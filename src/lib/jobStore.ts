import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";

export type PptJobStatus =
  | "queued"
  | "running"
  | "awaiting_approval"
  | "done"
  | "error";

export type PptJobInput = {
  topic: string;
  language?: string;
  slideCount?: number;
  audience?: string;
  tone?: string;
  referenceContent?: string;
  stylePreset?: string;
  palette?: string;
  model?: string; // provider/model
};

export type PptJobEvent =
  | { type: "log"; message: string; ts: number }
  | { type: "status"; status: PptJobStatus; ts: number }
  | {
      type: "outline";
      outlineMarkdown: string;
      draftOutlineMarkdown?: string;
      refinedOutlineMarkdown?: string;
      ts: number;
    }
  | { type: "result"; pptxPath: string; thumbnailsPath?: string | null; ts: number }
  | { type: "error"; message: string; ts: number };

export type PptJob = {
  id: string;
  input: PptJobInput;
  status: PptJobStatus;
  createdAt: number;
  updatedAt: number;
  sessionId?: string;
  outputDir: string; // workspace-relative
  outlinePath?: string; // workspace-relative
  outlineMarkdown?: string;
  draftOutlineMarkdown?: string;
  refinedOutlineMarkdown?: string;
  pptxPath?: string; // workspace-relative
  thumbnailsPath?: string; // workspace-relative
  logs: { ts: number; message: string }[];
  error?: string;
};

const jobs = new Map<string, PptJob>();
const emitters = new Map<string, EventEmitter>();

type PersistState = {
  writing: boolean;
  pending: PptJob | null;
};

const persistStates = new Map<string, PersistState>();

function extractFirstJsonValue(s: string): string | null {
  // Some runs may leave trailing garbage in job.json (eg. partial writes or accidental
  // concatenation). We try to recover by extracting the first complete top-level JSON value.
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
      if (ch === '"') {
        inString = false;
      }
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
      if (depth === 0) {
        return s.slice(start, i + 1);
      }
      if (depth < 0) return null;
    }
  }

  return null;
}

async function writeFileAtomic(destPath: string, content: string) {
  const dir = path.dirname(destPath);
  const tmpPath = `${destPath}.tmp.${process.pid}.${Date.now()}.${Math.random()
    .toString(16)
    .slice(2)}`;

  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(tmpPath, content, { encoding: "utf-8" });

  try {
    await fs.promises.rename(tmpPath, destPath);
  } catch {
    // Windows may fail to rename over an existing file; fall back to replace.
    try {
      await fs.promises.rm(destPath, { force: true });
      await fs.promises.rename(tmpPath, destPath);
    } catch {
      try {
        await fs.promises.rm(tmpPath, { force: true });
      } catch {
        // ignore
      }
      throw new Error("atomic write failed");
    }
  }
}

function safeJsonParse<T>(s: string): T | null {
  try {
    return JSON.parse(s) as T;
  } catch {
    const first = extractFirstJsonValue(s);
    if (!first) return null;
    try {
      return JSON.parse(first) as T;
    } catch {
      return null;
    }
  }
}

function isSafeId(id: string) {
  return /^[a-z0-9]+$/i.test(id);
}

function absJobDir(jobId: string) {
  // CWD is expected to be the Next.js app root (web/)
  return path.join(process.cwd(), "workspace", "jobs", jobId);
}

function absJobStatePath(jobId: string) {
  return path.join(absJobDir(jobId), "job.json");
}

function absOutlinePath(jobId: string) {
  return path.join(absJobDir(jobId), "outline.md");
}

function absPptxPath(jobId: string) {
  return path.join(absJobDir(jobId), "deck.pptx");
}

function absThumbPath(jobId: string) {
  return path.join(absJobDir(jobId), "thumbnails.jpg");
}

function inferFromOutline(md: string) {
  const lines = md.split("\n");
  let title: string | null = null;
  let slideCount = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (!title && line.startsWith("# ")) {
      title = line.slice(2).trim() || null;
    }
    if (/^##\s+Slide\s+\d+\s*:/i.test(line)) {
      slideCount++;
    }
  }
  return {
    title: title ?? "PPT",
    slideCount: slideCount > 0 ? slideCount : undefined,
  };
}

function tryRehydrateJob(jobId: string): PptJob | null {
  if (!isSafeId(jobId)) return null;

  const statePath = absJobStatePath(jobId);
  const outlineAbs = absOutlinePath(jobId);
  const pptxAbs = absPptxPath(jobId);
  const thumbAbs = absThumbPath(jobId);

  // 1) Prefer persisted state
  try {
    const raw = fs.readFileSync(statePath, "utf-8");
    const parsed = safeJsonParse<PptJob>(raw);
    if (parsed && parsed.id === jobId) {
      // Best-effort: refill outlineMarkdown from disk if missing.
      if (!parsed.outlineMarkdown && parsed.outlinePath) {
        try {
          const md = fs.readFileSync(path.join(process.cwd(), parsed.outlinePath), "utf-8");
          parsed.outlineMarkdown = md;
        } catch {
          // ignore
        }
      }
      return parsed;
    }
  } catch {
    // ignore
  }

  // 2) Fallback: infer from existing artifacts on disk (for older runs)
  let outlineMarkdown: string | null = null;
  try {
    outlineMarkdown = fs.readFileSync(outlineAbs, "utf-8");
  } catch {
    outlineMarkdown = null;
  }

  let hasPptx = false;
  try {
    hasPptx = fs.statSync(pptxAbs).isFile();
  } catch {
    hasPptx = false;
  }

  let hasThumb = false;
  try {
    hasThumb = fs.statSync(thumbAbs).isFile();
  } catch {
    hasThumb = false;
  }

  if (!outlineMarkdown && !hasPptx && !hasThumb) {
    return null;
  }

  const inferred = outlineMarkdown ? inferFromOutline(outlineMarkdown) : null;
  const outputDir = `workspace/jobs/${jobId}`;
  const now = Date.now();

  const status: PptJobStatus = hasPptx
    ? "done"
    : outlineMarkdown
      ? "awaiting_approval"
      : "queued";

  const job: PptJob = {
    id: jobId,
    input: {
      topic: inferred?.title ?? "PPT",
      language: "中文",
      slideCount: inferred?.slideCount,
    },
    status,
    createdAt: now,
    updatedAt: now,
    outputDir,
    outlinePath: outlineMarkdown ? `${outputDir}/outline.md` : undefined,
    outlineMarkdown: outlineMarkdown ?? undefined,
    pptxPath: hasPptx ? `${outputDir}/deck.pptx` : undefined,
    thumbnailsPath: hasThumb ? `${outputDir}/thumbnails.jpg` : undefined,
    logs: [],
  };

  return job;
}

function tryReadPersistedJob(jobId: string): PptJob | null {
  if (!isSafeId(jobId)) return null;
  try {
    const raw = fs.readFileSync(absJobStatePath(jobId), "utf-8");
    const parsed = safeJsonParse<PptJob>(raw);
    if (!parsed || parsed.id !== jobId) return null;
    return parsed;
  } catch {
    return null;
  }
}

function persistJob(job: PptJob) {
  if (!isSafeId(job.id)) return;

  const data: PptJob = {
    ...job,
    // Don't persist unlimited logs; keep it bounded.
    logs: job.logs.slice(-300),
  };

  let st = persistStates.get(job.id);
  if (!st) {
    st = { writing: false, pending: null };
    persistStates.set(job.id, st);
  }

  // Coalesce bursts: keep only the latest snapshot.
  st.pending = data;

  if (st.writing) return;
  st.writing = true;

  const jobId = job.id;
  queueMicrotask(() => {
    void (async () => {
      try {
        const absState = absJobStatePath(jobId);
        const state = persistStates.get(jobId);
        if (!state) return;

        while (state.pending) {
          const next = state.pending;
          state.pending = null;

          try {
            const json = JSON.stringify(next, null, 2) + "\n";
            await writeFileAtomic(absState, json);
          } catch {
            // ignore
          }
        }
      } finally {
        const state = persistStates.get(jobId);
        if (state) state.writing = false;
      }
    })();
  });
}

function getEmitter(jobId: string) {
  let e = emitters.get(jobId);
  if (!e) {
    e = new EventEmitter();
    e.setMaxListeners(100);
    emitters.set(jobId, e);
  }
  return e;
}

export function createJob(job: PptJob) {
  jobs.set(job.id, job);
  getEmitter(job.id);
  persistJob(job);
}

export function getJob(jobId: string) {
  const inMem = jobs.get(jobId);
  if (inMem) {
    // In dev / multi-worker runtimes, background work and API reads may happen
    // in different processes. If another process updated job.json on disk,
    // refresh our in-memory snapshot.
    const persisted = tryReadPersistedJob(jobId);
    if (persisted && typeof persisted.updatedAt === "number") {
      const memUpdatedAt = typeof inMem.updatedAt === "number" ? inMem.updatedAt : 0;
      if (persisted.updatedAt > memUpdatedAt) {
        jobs.set(jobId, persisted);
        getEmitter(jobId);
        return persisted;
      }
    }
    return inMem;
  }

  const rehydrated = tryRehydrateJob(jobId);
  if (!rehydrated) return null;
  jobs.set(jobId, rehydrated);
  getEmitter(jobId);
  persistJob(rehydrated);
  return rehydrated;
}

export function setJob(jobId: string, update: Partial<PptJob>) {
  const cur = jobs.get(jobId);
  if (!cur) return null;
  const next: PptJob = {
    ...cur,
    ...update,
    updatedAt: Date.now(),
  };
  jobs.set(jobId, next);
  persistJob(next);
  return next;
}

export function pushEvent(jobId: string, event: PptJobEvent) {
  const cur = jobs.get(jobId);
  if (cur && event.type === "log") {
    cur.logs.push({ ts: event.ts, message: event.message });
    cur.updatedAt = event.ts;
  }
  getEmitter(jobId).emit("event", event);
}

export function subscribe(jobId: string, cb: (event: PptJobEvent) => void) {
  const e = getEmitter(jobId);
  e.on("event", cb);
  return () => e.off("event", cb);
}
