import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { createJob, type PptJobInput } from "@/lib/jobStore";
import { runOutlineJob } from "@/lib/runJob";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function makeJobId() {
  return crypto.randomUUID().replace(/-/g, "");
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

  const input: PptJobInput = {
    topic: String(obj.topic ?? "").trim(),
    language: obj.language ? String(obj.language) : undefined,
    slideCount: obj.slideCount ? Number(obj.slideCount) : undefined,
    audience: obj.audience ? String(obj.audience) : undefined,
    tone: obj.tone ? String(obj.tone) : undefined,
    referenceContent: obj.referenceContent
      ? String(obj.referenceContent).trim()
      : undefined,
    stylePreset: obj.stylePreset ? String(obj.stylePreset) : undefined,
    palette: obj.palette ? String(obj.palette) : undefined,
    model: obj.model ? String(obj.model) : undefined,
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
