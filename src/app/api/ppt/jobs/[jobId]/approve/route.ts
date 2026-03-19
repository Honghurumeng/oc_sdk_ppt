import { NextResponse } from "next/server";
import path from "node:path";
import { promises as fs } from "node:fs";
import { getJob, setJob, type PptJobInput } from "@/lib/jobStore";
import { runDeckJob, runHtmlOnlyJob } from "@/lib/runJob";

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

  if (job.status === "queued" || job.status === "running") {
    return NextResponse.json(
      { error: `任务正在执行中（status=${job.status}），请等待完成或失败后再开始新的生成。` },
      { status: 409 }
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const obj = (typeof body === "object" && body !== null ? body : {}) as Record<
    string,
    unknown
  >;

  const outlineMarkdown =
    typeof obj.outlineMarkdown === "string" ? obj.outlineMarkdown : null;

  const nextInput: PptJobInput = {
    ...job.input,
    stylePreset:
      typeof obj.stylePreset === "string" ? obj.stylePreset : job.input.stylePreset,
    palette: typeof obj.palette === "string" ? obj.palette : job.input.palette,
    model: typeof obj.model === "string" ? obj.model : job.input.model,
  };

  const buildModeRaw = typeof obj.buildMode === "string" ? obj.buildMode : "pptx";
  const buildMode = buildModeRaw === "preview" ? "preview" : "pptx";

  // 如果前端允许编辑大纲，这里落盘覆盖 outline.md
  if (outlineMarkdown && outlineMarkdown.trim().length > 0) {
    const outlinePath = job.outlinePath ?? `${job.outputDir}/outline.md`;
    await fs.mkdir(path.join(process.cwd(), job.outputDir), { recursive: true });
    await fs.writeFile(path.join(process.cwd(), outlinePath), outlineMarkdown, "utf-8");
    setJob(jobId, { outlinePath, outlineMarkdown });
  }

  setJob(jobId, { input: nextInput, error: undefined });

  // When the user clicks "use this outline to generate", start a fresh LLM session
  // for deck generation (do not reuse the outline session context).
  setJob(jobId, { sessionId: undefined });

  // Mark queued immediately so UI can reflect the transition even if the
  // background task starts slightly later.
  setJob(jobId, { status: "queued", error: undefined });

  // Start the long-running job in background.
  // In some Next.js runtimes/dev reload scenarios, queueMicrotask() can be flaky
  // for background work; setImmediate is more reliable.
  setImmediate(() => {
    try {
      if (buildMode === "preview") {
        void runHtmlOnlyJob(jobId, nextInput);
      } else {
        void runDeckJob(jobId, nextInput);
      }
    } catch {
      // ignore
    }
  });

  return NextResponse.json({ ok: true });
}
