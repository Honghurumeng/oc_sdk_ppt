import { NextResponse } from "next/server";
import { activateSlideVersion } from "@/lib/slideVersions";
import { getJob, setJob } from "@/lib/jobStore";

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
  const slideName = typeof obj.slideName === "string" ? obj.slideName : "";
  const versionId = typeof obj.versionId === "string" ? obj.versionId : "";

  if (!slideName.trim() || !versionId.trim()) {
    return NextResponse.json({ error: "missing slideName/versionId" }, { status: 400 });
  }

  try {
    await activateSlideVersion(jobId, slideName.trim(), versionId.trim());
    // Version切换会让现有 pptx 过期
    setJob(jobId, { pptxPath: undefined, thumbnailsPath: undefined });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 400 }
    );
  }

  return NextResponse.json({ ok: true });
}
