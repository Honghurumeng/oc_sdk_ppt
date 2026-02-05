import { NextResponse } from "next/server";
import { getJob, setJob, type PptJobInput } from "@/lib/jobStore";
import { runRenderFromHtmlJob } from "@/lib/runJob";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isSafeId(id: string) {
  return /^[a-z0-9]+$/i.test(id);
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const { jobId } = await params;
  if (!isSafeId(jobId)) {
    return NextResponse.json({ error: "invalid jobId" }, { status: 400 });
  }

  const job = getJob(jobId);
  if (!job) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const obj = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;

  const nextInput: PptJobInput = {
    ...job.input,
    model: typeof obj.model === "string" ? obj.model : job.input.model,
  };

  setJob(jobId, { input: nextInput, error: undefined });

  queueMicrotask(() => {
    void runRenderFromHtmlJob(jobId, nextInput);
  });

  return NextResponse.json({ ok: true });
}
