import { NextResponse } from "next/server";
import { getJob, setJob, type PptJobInput } from "@/lib/jobStore";
import { runHtmlAdjustJob } from "@/lib/runJob";

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
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const obj = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;

  const targetRaw = typeof obj.target === "string" ? obj.target : "all";
  const target = targetRaw.trim() ? targetRaw.trim() : "all";
  const feedback = typeof obj.feedback === "string" ? obj.feedback : "";

  const nextInput: PptJobInput = {
    ...job.input,
    model: typeof obj.model === "string" ? obj.model : job.input.model,
  };

  setJob(jobId, { input: nextInput, error: undefined });

  queueMicrotask(() => {
    void runHtmlAdjustJob(jobId, nextInput, target === "all" ? "all" : target, feedback);
  });

  return NextResponse.json({ ok: true });
}
