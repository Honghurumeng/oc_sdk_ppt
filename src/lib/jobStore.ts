import { EventEmitter } from "node:events";

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
  stylePreset?: string;
  palette?: string;
  model?: string; // provider/model
};

export type PptJobEvent =
  | { type: "log"; message: string; ts: number }
  | { type: "status"; status: PptJobStatus; ts: number }
  | { type: "outline"; outlineMarkdown: string; ts: number }
  | { type: "result"; pptxPath: string; thumbnailsPath: string; ts: number }
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
  pptxPath?: string; // workspace-relative
  thumbnailsPath?: string; // workspace-relative
  logs: { ts: number; message: string }[];
  error?: string;
};

const jobs = new Map<string, PptJob>();
const emitters = new Map<string, EventEmitter>();

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
}

export function getJob(jobId: string) {
  return jobs.get(jobId) ?? null;
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
