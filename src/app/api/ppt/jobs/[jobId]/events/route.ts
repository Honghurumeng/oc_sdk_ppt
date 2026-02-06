import { NextRequest } from "next/server";
import { subscribe, getJob } from "@/lib/jobStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isSafeId(id: string) {
  return /^[a-z0-9]+$/i.test(id);
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const { jobId } = await params;
  if (!isSafeId(jobId)) {
    return new Response("invalid jobId", { status: 400 });
  }

  const job = getJob(jobId);
  if (!job) {
    return new Response("not found", { status: 404 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(
          encoder.encode(
            `event: ${event}\n` + `data: ${JSON.stringify(data)}\n\n`
          )
        );
      };

      // 先订阅，避免在握手阶段错过关键事件（status/outline/result）
      const unsubscribe = subscribe(jobId, (evt) => {
        send(evt.type, evt);
        if (evt.type === "error" || evt.type === "result") {
          // 让前端尽快刷新 job 状态
          send("flush", { ts: Date.now() });
        }
        if (evt.type === "status" && (evt.status === "done" || evt.status === "awaiting_approval")) {
          // status 事件本身不包含 job.error/pptxUrl 等完整信息，主动触发前端刷新。
          send("flush", { ts: Date.now() });
        }
      });

      // 初始快照：即使前端在订阅前错过事件，也能拿到当前状态/结果
      send("hello", {
        jobId,
        status: job.status,
        ts: Date.now(),
      });

      send("status", { type: "status", status: job.status, ts: Date.now() });

      if (job.outlineMarkdown) {
        send("outline", {
          type: "outline",
          outlineMarkdown: job.outlineMarkdown,
          ts: Date.now(),
        });
      }

      if (job.pptxPath) {
        send("result", {
          type: "result",
          pptxPath: job.pptxPath,
          thumbnailsPath: job.thumbnailsPath ?? null,
          ts: Date.now(),
        });
      }

      // 推送最近日志（给晚加入的连接补齐上下文）
      for (const l of job.logs.slice(-50)) {
        send("log", l);
      }

      const ping = setInterval(() => {
        send("ping", { ts: Date.now() });
      }, 15000);

      const abort = () => {
        clearInterval(ping);
        unsubscribe();
        controller.close();
      };

      req.signal.addEventListener("abort", abort);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
