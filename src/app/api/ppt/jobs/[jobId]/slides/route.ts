import { NextResponse } from "next/server";
import { getSlideVersionsMeta } from "@/lib/slideVersions";

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

  const { slides, meta } = await getSlideVersionsMeta(jobId);
  const data = slides.map((name) => {
    const m = meta.slides[name];
    return {
      name,
      activeVersion: m?.active ?? null,
      versions: Array.isArray(m?.versions) ? m.versions : [],
    };
  });

  return NextResponse.json({ ok: true, slides: data });
}
