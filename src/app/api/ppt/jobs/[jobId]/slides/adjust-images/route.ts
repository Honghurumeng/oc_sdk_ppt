import { NextResponse } from "next/server";
import path from "node:path";
import { promises as fs } from "node:fs";

import { getJob, setJob, type PptJobInput } from "@/lib/jobStore";
import { runSvgAdjustJob } from "@/lib/runJob";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isSafeId(id: string) {
  return /^[a-z0-9]+$/i.test(id);
}

function hasIllustSlot(html: string) {
  return /data-oc-illust-slot\s*=/i.test(html);
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

  if (job.status === "queued" || job.status === "running") {
    return NextResponse.json(
      { error: `任务正在执行中（status=${job.status}），请等待完成或失败后再调整。` },
      { status: 409 }
    );
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
  if (!feedback.trim()) {
    return NextResponse.json({ error: "缺少修改意见" }, { status: 400 });
  }

  if (target !== "all") {
    const normalized = path.posix.basename(target);
    if (!/\.html$/i.test(normalized)) {
      return NextResponse.json({ error: "target 必须是 .html 文件名或 all" }, { status: 400 });
    }
    const absHtml = path.join(process.cwd(), "workspace", "jobs", jobId, "slides", normalized);
    let html = "";
    try {
      html = await fs.readFile(absHtml, "utf-8");
    } catch {
      return NextResponse.json({ error: `目标 HTML 不存在：${normalized}` }, { status: 404 });
    }
    if (!hasIllustSlot(html)) {
      return NextResponse.json({ error: "该页面没有图片槽位，无法进行图片应用调整。" }, { status: 400 });
    }
  }

  const nextInput: PptJobInput = {
    ...job.input,
    model: typeof obj.model === "string" ? obj.model : job.input.model,
    svgModel: typeof obj.svgModel === "string" ? obj.svgModel : job.input.svgModel,
  };

  setJob(jobId, { input: nextInput, error: undefined, status: "queued" });

  setImmediate(() => {
    try {
      void runSvgAdjustJob(jobId, nextInput, target === "all" ? "all" : target, feedback);
    } catch {
      // ignore
    }
  });

  return NextResponse.json({ ok: true });
}

