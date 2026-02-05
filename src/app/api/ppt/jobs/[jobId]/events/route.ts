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

      send("hello", {
        jobId,
        status: job.status,
        ts: Date.now(),
      });

      // 推送最近日志
      for (const l of job.logs.slice(-50)) {
        send("log", l);
      }

      const unsubscribe = subscribe(jobId, (evt) => {
        send(evt.type, evt);
        if (evt.type === "error" || evt.type === "result") {
          // 让前端尽快刷新 job 状态
          send("flush", { ts: Date.now() });
        }
      });

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
