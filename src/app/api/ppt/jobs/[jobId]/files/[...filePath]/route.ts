import { NextResponse } from "next/server";
import path from "node:path";
import { promises as fs } from "node:fs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isSafeId(id: string) {
  return /^[a-z0-9]+$/i.test(id);
}

function contentTypeByExt(ext: string) {
  switch (ext.toLowerCase()) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "application/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".svg":
      return "image/svg+xml";
    case ".webp":
      return "image/webp";
    case ".woff":
      return "font/woff";
    case ".woff2":
      return "font/woff2";
    case ".ttf":
      return "font/ttf";
    case ".otf":
      return "font/otf";
    default:
      return "application/octet-stream";
  }
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ jobId: string; filePath: string[] }> }
) {
  const { jobId, filePath } = await params;
  if (!isSafeId(jobId)) {
    return NextResponse.json({ error: "invalid jobId" }, { status: 400 });
  }

  const relRaw = Array.isArray(filePath) ? filePath.join("/") : "";
  const relNorm = path.posix.normalize(relRaw).replace(/^\/+/, "");
  if (!relNorm || relNorm.startsWith("..") || path.posix.isAbsolute(relNorm)) {
    return NextResponse.json({ error: "invalid path" }, { status: 400 });
  }

  const base = path.join(process.cwd(), "workspace", "jobs", jobId);
  const abs = path.join(base, relNorm);
  const baseWithSep = base.endsWith(path.sep) ? base : base + path.sep;
  if (!abs.startsWith(baseWithSep)) {
    return NextResponse.json({ error: "invalid path" }, { status: 400 });
  }

  const ct = contentTypeByExt(path.extname(abs));

  let data: Buffer;
  try {
    data = await fs.readFile(abs);
  } catch {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const body = new Blob([Uint8Array.from(data)], { type: ct.split(";")[0] });
  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": ct,
      "Cache-Control": "no-store",
    },
  });
}
