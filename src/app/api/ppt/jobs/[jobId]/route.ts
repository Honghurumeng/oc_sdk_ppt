import { NextResponse } from "next/server";
import { getJob } from "@/lib/jobStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isSafeId(id: string) {
  return /^[a-z0-9]+$/i.test(id);
}

export async function GET(
  _req: Request,
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

  const base = `/api/ppt/jobs/${jobId}`;
  return NextResponse.json({
    id: job.id,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    sessionId: job.sessionId ?? null,
    error: job.error ?? null,
    logs: job.logs.slice(-200),
    outlineMarkdown: job.outlineMarkdown ?? null,
    pptxUrl: job.pptxPath ? `${base}/pptx` : null,
    thumbnailsUrl: job.thumbnailsPath ? `${base}/thumbnails` : null,
  });
}
