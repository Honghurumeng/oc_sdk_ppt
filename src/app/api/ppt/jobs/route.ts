import { NextResponse } from "next/server";
import crypto from "node:crypto";
import path from "node:path";
import { promises as fs } from "node:fs";
import { createJob, type PptJobInput } from "@/lib/jobStore";
import { runOutlineJob } from "@/lib/runJob";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function extractFirstJsonValue(s: string): string | null {
  let start = 0;
  while (start < s.length && /\s/.test(s[start]!)) start++;

  const first = s[start];
  if (first !== "{" && first !== "[") return null;

  let depth = 0;
  let inString = false;
  let escaping = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i]!;
    if (inString) {
      if (escaping) {
        escaping = false;
        continue;
      }
      if (ch === "\\") {
        escaping = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{" || ch === "[") {
      depth++;
      continue;
    }
    if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
      if (depth < 0) return null;
    }
  }
  return null;
}

function safeJsonParse(s: string): unknown | null {
  try {
    return JSON.parse(s) as unknown;
  } catch {
    const first = extractFirstJsonValue(s);
    if (!first) return null;
    try {
      return JSON.parse(first) as unknown;
    } catch {
      return null;
    }
  }
}

function isSafeId(id: string) {
  return /^[a-z0-9]+$/i.test(id);
}

async function fileExists(p: string) {
  try {
    const st = await fs.stat(p);
    return st.isFile();
  } catch {
    return false;
  }
}

async function countHtmlFiles(dir: string) {
  try {
    const files = await fs.readdir(dir);
    return files.filter((f) => f.toLowerCase().endsWith(".html")).length;
  } catch {
    return 0;
  }
}

function makeJobId() {
  return crypto.randomUUID().replace(/-/g, "");
}

export async function GET() {
  const baseDir = path.join(process.cwd(), "workspace", "jobs");
  let entries: import("node:fs").Dirent[] = [];
  try {
    entries = await fs.readdir(baseDir, { withFileTypes: true });
  } catch {
    entries = [];
  }

  const summaries: Array<{
    id: string;
    status: string;
    createdAt: number;
    updatedAt: number;
    topic: string;
    slideCount: number | null;
    hasOutline: boolean;
    hasSlides: boolean;
    slidesCount: number;
    hasPptx: boolean;
    error: string | null;
  }> = [];

  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const id = ent.name;
    if (!isSafeId(id)) continue;

    const absJobJson = path.join(baseDir, id, "job.json");
    if (!(await fileExists(absJobJson))) continue;

    let raw = "";
    try {
      raw = await fs.readFile(absJobJson, "utf-8");
    } catch {
      continue;
    }

    const parsed = safeJsonParse(raw);
    if (!parsed || typeof parsed !== "object") continue;
    const obj = parsed as Record<string, unknown>;
    if (obj.id !== id) continue;

    const input =
      obj.input && typeof obj.input === "object"
        ? (obj.input as Record<string, unknown>)
        : ({} as Record<string, unknown>);
    const topic = typeof input.topic === "string" ? input.topic : "";
    const slideCountRaw = input.slideCount;
    const slideCount =
      typeof slideCountRaw === "number" && Number.isFinite(slideCountRaw) ? slideCountRaw : null;

    const outputDir = path.join(baseDir, id);
    const outlineAbs = path.join(outputDir, "outline.md");
    const slidesAbs = path.join(outputDir, "slides");
    const pptxAbs = path.join(outputDir, "deck.pptx");

    const hasOutline = await fileExists(outlineAbs);
    const slidesCount = await countHtmlFiles(slidesAbs);
    const hasSlides = slidesCount > 0;
    const hasPptx = await fileExists(pptxAbs);

    summaries.push({
      id,
      status: typeof obj.status === "string" ? obj.status : "unknown",
      createdAt: typeof obj.createdAt === "number" ? obj.createdAt : 0,
      updatedAt: typeof obj.updatedAt === "number" ? obj.updatedAt : 0,
      topic,
      slideCount,
      hasOutline,
      hasSlides,
      slidesCount,
      hasPptx,
      error: typeof obj.error === "string" ? obj.error : null,
    });
  }

  summaries.sort((a, b) => {
    const da = a.updatedAt || a.createdAt;
    const db = b.updatedAt || b.createdAt;
    return db - da;
  });

  return NextResponse.json({ ok: true, jobs: summaries });
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const obj = (typeof body === "object" && body !== null ? body : {}) as Record<
    string,
    unknown
  >;

  let slideCount: number | undefined = undefined;
  if (Object.prototype.hasOwnProperty.call(obj, "slideCount")) {
    const raw = obj.slideCount;
    const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
    if (Number.isFinite(n)) slideCount = n;
  }

  const input: PptJobInput = {
    topic: String(obj.topic ?? "").trim(),
    language: obj.language ? String(obj.language) : undefined,
    // slideCount=0 is allowed (means: let AI decide)
    slideCount,
    audience: obj.audience ? String(obj.audience) : undefined,
    tone: obj.tone ? String(obj.tone) : undefined,
    referenceContent: obj.referenceContent ? String(obj.referenceContent).trim() : undefined,
    stylePreset: obj.stylePreset ? String(obj.stylePreset) : undefined,
    palette: obj.palette ? String(obj.palette) : undefined,
    model: obj.model ? String(obj.model) : undefined,
    svgModel: obj.svgModel ? String(obj.svgModel) : undefined,
  };

  if (!input.topic) {
    return NextResponse.json({ error: "topic is required" }, { status: 400 });
  }

  const jobId = makeJobId();
  const createdAt = Date.now();
  const outputDir = `workspace/jobs/${jobId}`;

  createJob({
    id: jobId,
    input,
    status: "queued",
    createdAt,
    updatedAt: createdAt,
    outputDir,
    logs: [],
  });

  // 后台执行（注意：无 serverless 保证；适合本地/单机 next start）
  queueMicrotask(() => {
    void runOutlineJob(jobId, input);
  });

  return NextResponse.json({ jobId });
}
