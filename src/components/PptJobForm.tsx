"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type JobStatus = "queued" | "running" | "awaiting_approval" | "done" | "error";

type JobResponse = {
  id: string;
  status: JobStatus;
  sessionId: string | null;
  error: string | null;
  logs: { ts: number; message: string }[];
  outlineMarkdown?: string | null;
  pptxUrl: string | null;
  thumbnailsUrl: string | null;
};

function fmtTime(ts: number) {
  const d = new Date(ts);
  return d.toLocaleTimeString();
}

export default function PptJobForm() {
  const [topic, setTopic] = useState("");
  const [language, setLanguage] = useState("中文");
  const [slideCount, setSlideCount] = useState(8);
  const [audience, setAudience] = useState("一般受众");
  const [tone, setTone] = useState("专业、清晰、偏实用");
  const [stylePreset, setStylePreset] = useState("Editorial");
  const [palette, setPalette] = useState("Sand & Ink");
  const [model, setModel] = useState<string>("");
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [modelLoadError, setModelLoadError] = useState<string | null>(null);

  const [jobId, setJobId] = useState<string | null>(null);
  const [status, setStatus] = useState<JobStatus | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<{ ts: number; message: string }[]>([]);
  const [outlineMarkdown, setOutlineMarkdown] = useState<string>("");
  const [pptxUrl, setPptxUrl] = useState<string | null>(null);
  const [thumbnailsUrl, setThumbnailsUrl] = useState<string | null>(null);

  const esRef = useRef<EventSource | null>(null);
  const tailRef = useRef<HTMLDivElement | null>(null);

  const canSubmit = useMemo(() => topic.trim().length > 0, [topic]);

  async function loadModelOptions() {
    try {
      setModelLoadError(null);
      const res = await fetch("/api/opencode/models", { cache: "no-store" });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok || data.ok !== true) {
        throw new Error((data.error as string) ?? "Failed to load models");
      }
      const list = Array.isArray(data.models)
        ? data.models.filter((x) => typeof x === "string")
        : [];
      setModelOptions(list as string[]);
      if (list.length === 0) {
        setModel("");
        return;
      }
      if (!model || !list.includes(model)) {
        setModel(String(list[0]));
      }
    } catch (e) {
      setModelOptions([]);
      setModel("");
      setModelLoadError(e instanceof Error ? e.message : String(e));
    }
  }

  async function refreshJob(id: string) {
    const res = await fetch(`/api/ppt/jobs/${id}`, { cache: "no-store" });
    if (!res.ok) return;
    const data = (await res.json()) as JobResponse;
    setStatus(data.status);
    setSessionId(data.sessionId);
    setError(data.error);
    setLogs(data.logs ?? []);
    if (typeof data.outlineMarkdown === "string") setOutlineMarkdown(data.outlineMarkdown);
    setPptxUrl(data.pptxUrl);
    setThumbnailsUrl(data.thumbnailsUrl);
  }

  async function start() {
    setError(null);
    setLogs([]);
    setOutlineMarkdown("");
    setPptxUrl(null);
    setThumbnailsUrl(null);

    const res = await fetch("/api/ppt/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        topic,
        language,
        slideCount,
        audience,
        tone,
        stylePreset,
        palette,
        model: model || undefined,
      }),
    });

    const data = await res.json();
    if (!res.ok) {
      setError(data?.error ?? "创建任务失败");
      return;
    }

    const id = String(data.jobId);
    setJobId(id);
    setStatus("queued");
    await refreshJob(id);

    esRef.current?.close();
    const es = new EventSource(`/api/ppt/jobs/${id}/events`);
    esRef.current = es;

    es.addEventListener("log", (ev) => {
      try {
        const payload = JSON.parse((ev as MessageEvent).data);
        setLogs((cur) => [...cur, payload]);
      } catch {
        // ignore
      }
    });

    es.addEventListener("status", (ev) => {
      try {
        const payload = JSON.parse((ev as MessageEvent).data);
        setStatus(payload.status);
      } catch {
        // ignore
      }
    });

    es.addEventListener("outline", (ev) => {
      try {
        const payload = JSON.parse((ev as MessageEvent).data);
        if (typeof payload.outlineMarkdown === "string") {
          setOutlineMarkdown(payload.outlineMarkdown);
        }
      } catch {
        // ignore
      }
    });

    const finish = async () => {
      await refreshJob(id);
      es.close();
    };

    es.addEventListener("result", () => void finish());
    es.addEventListener("error", () => void finish());
    es.addEventListener("flush", () => void refreshJob(id));
  }

  async function approve() {
    if (!jobId) return;
    setError(null);
    const res = await fetch(`/api/ppt/jobs/${jobId}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        outlineMarkdown,
        stylePreset,
        palette,
        model: model || undefined,
      }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data?.error ?? "提交确认失败");
      return;
    }
    await refreshJob(jobId);
  }

  useEffect(() => {
    void loadModelOptions();

    const onModelsChanged = () => {
      void loadModelOptions();
    };

    window.addEventListener("opencode:models-changed", onModelsChanged);

    return () => {
      window.removeEventListener("opencode:models-changed", onModelsChanged);
      esRef.current?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    tailRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [logs.length]);

  return (
    <div>
      <div style={{ display: "grid", gap: 12 }}>
        <label>
          <div style={{ fontSize: 12, opacity: 0.75 }}>PPT 主题</div>
          <input
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder="例如：面向新员工的 Git 入门与规范"
            style={{ width: "100%" }}
          />
        </label>

        <div style={{ display: "grid", gap: 12, gridTemplateColumns: "1fr 1fr" }}>
          <label>
            <div style={{ fontSize: 12, opacity: 0.75 }}>语言</div>
            <input
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              placeholder="中文 / English"
              style={{ width: "100%" }}
            />
          </label>
          <label>
            <div style={{ fontSize: 12, opacity: 0.75 }}>页数</div>
            <input
              type="number"
              min={3}
              max={20}
              value={slideCount}
              onChange={(e) => setSlideCount(Number(e.target.value))}
              style={{ width: "100%" }}
            />
          </label>
        </div>

        <div style={{ display: "grid", gap: 12, gridTemplateColumns: "1fr 1fr" }}>
          <label>
            <div style={{ fontSize: 12, opacity: 0.75 }}>受众</div>
            <input
              value={audience}
              onChange={(e) => setAudience(e.target.value)}
              placeholder="例如：产品经理 / 技术团队 / 客户"
              style={{ width: "100%" }}
            />
          </label>
          <label>
            <div style={{ fontSize: 12, opacity: 0.75 }}>语气/风格</div>
            <input
              value={tone}
              onChange={(e) => setTone(e.target.value)}
              placeholder="例如：商业路演 / 教学 / 极简"
              style={{ width: "100%" }}
            />
          </label>
        </div>

        <div style={{ display: "grid", gap: 12, gridTemplateColumns: "1fr 1fr" }}>
          <label>
            <div style={{ fontSize: 12, opacity: 0.75 }}>模板/风格预设</div>
            <input
              value={stylePreset}
              onChange={(e) => setStylePreset(e.target.value)}
              placeholder="Editorial / Modern Grid / Clean"
              style={{ width: "100%" }}
            />
          </label>
          <label>
            <div style={{ fontSize: 12, opacity: 0.75 }}>配色方案</div>
            <input
              value={palette}
              onChange={(e) => setPalette(e.target.value)}
              placeholder="Sand & Ink / Teal & Coral"
              style={{ width: "100%" }}
            />
          </label>
        </div>

        <label>
          <div style={{ fontSize: 12, opacity: 0.75 }}>使用模型（provider/model）</div>
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            disabled={modelOptions.length === 0}
            style={{ width: "100%", padding: "10px 12px", borderRadius: 10 }}
          >
            {modelOptions.length === 0 ? (
              <option value="">(暂无模型，请先在下方配置供应商/模型)</option>
            ) : (
              modelOptions.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))
            )}
          </select>
          {modelLoadError ? (
            <div style={{ marginTop: 6, fontSize: 12, color: "#7a1a1a" }}>
              {modelLoadError}
            </div>
          ) : null}
        </label>

        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <button onClick={start} disabled={!canSubmit || modelOptions.length === 0}>
            生成大纲
          </button>
          <div style={{ fontSize: 12, opacity: 0.75 }}>
            {jobId ? (
              <span>
                jobId: <code>{jobId}</code>
              </span>
            ) : (
              <span>提交后会返回 jobId</span>
            )}
          </div>
        </div>
      </div>

      <div style={{ marginTop: 24, display: "grid", gap: 12 }}>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <div>
            状态：<b>{status ?? "-"}</b>
          </div>
          {sessionId ? (
            <div>
              sessionId：<code>{sessionId}</code>
            </div>
          ) : null}
          {pptxUrl ? (
            <a href={pptxUrl} style={{ textDecoration: "underline" }}>
              下载 PPTX
            </a>
          ) : null}
        </div>

        {jobId && outlineMarkdown ? (
          <div style={{ display: "grid", gap: 8 }}>
            <div style={{ fontSize: 12, opacity: 0.75 }}>大纲（可编辑）</div>
            <textarea
              value={outlineMarkdown}
              onChange={(e) => setOutlineMarkdown(e.target.value)}
              rows={12}
              style={{
                width: "100%",
                border: "1px solid rgba(0,0,0,0.18)",
                borderRadius: 12,
                padding: 12,
                background: "rgba(255,255,255,0.85)",
                fontFamily:
                  "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
                fontSize: 12,
                lineHeight: 1.5,
              }}
            />
            <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
              <button onClick={approve} disabled={!jobId}>
                使用该大纲生成 PPT
              </button>
              <div style={{ fontSize: 12, opacity: 0.65 }}>
                你也可以先修改大纲，再点生成。
              </div>
            </div>
          </div>
        ) : null}

        {error ? (
          <div
            style={{
              padding: 12,
              border: "1px solid rgba(255,0,0,0.25)",
              background: "rgba(255,0,0,0.06)",
              borderRadius: 10,
              color: "#7a1a1a",
            }}
          >
            错误：{error}
          </div>
        ) : null}

        <div
          style={{
            padding: 12,
            border: "1px solid rgba(0,0,0,0.12)",
            borderRadius: 12,
            background: "rgba(255,255,255,0.7)",
            minHeight: 120,
            maxHeight: 240,
            overflow: "auto",
            fontFamily:
              "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
            fontSize: 12,
            lineHeight: 1.5,
          }}
        >
          {logs.length === 0 ? (
            <div style={{ opacity: 0.6 }}>日志会显示在这里</div>
          ) : (
            logs.map((l, idx) => (
              <div key={`${l.ts}-${idx}`}>
                <span style={{ opacity: 0.6 }}>[{fmtTime(l.ts)}]</span> {l.message}
              </div>
            ))
          )}
          <div ref={tailRef} />
        </div>

        {thumbnailsUrl ? (
          <div style={{ display: "grid", gap: 8 }}>
            <div style={{ fontSize: 12, opacity: 0.75 }}>预览（缩略图网格）</div>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={thumbnailsUrl}
              alt="thumbnails"
              style={{
                width: "100%",
                height: "auto",
                borderRadius: 12,
                border: "1px solid rgba(0,0,0,0.12)",
              }}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
