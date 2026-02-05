import { NextResponse } from "next/server";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
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
  if (!job || !job.pptxPath) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const abs = path.join(process.cwd(), job.pptxPath);
  const st = await stat(abs);
  const stream = Readable.toWeb(createReadStream(abs)) as unknown as ReadableStream<Uint8Array>;

  return new Response(stream, {
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "Content-Length": String(st.size),
      "Content-Disposition": `attachment; filename="${jobId}.pptx"`,
      "Cache-Control": "no-store",
    },
  });
}
