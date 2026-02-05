"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import Divider from "@mui/material/Divider";
import FormControlLabel from "@mui/material/FormControlLabel";
import FormControl from "@mui/material/FormControl";
import InputLabel from "@mui/material/InputLabel";
import MenuItem from "@mui/material/MenuItem";
import Paper from "@mui/material/Paper";
import Select from "@mui/material/Select";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";

type JobStatus = "queued" | "running" | "awaiting_approval" | "done" | "error";

type JobResponse = {
  id: string;
  status: JobStatus;
  sessionId: string | null;
  error: string | null;
  logs: { ts: number; message: string }[];
  outlineMarkdown?: string | null;
  pptxUrl: string | null;
  thumbnailsUrl?: string | null;
};

type SlideVersion = {
  id: string;
  createdAt: number;
  note?: string;
};

type SlideInfo = {
  name: string;
  activeVersion: string | null;
  versions: SlideVersion[];
};

function fmtTime(ts: number) {
  const d = new Date(ts);
  return d.toLocaleTimeString();
}

const monoFontFamily =
  "var(--font-geist-mono), ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace";

export default function PptJobForm() {
  const [topic, setTopic] = useState("");
  const [language, setLanguage] = useState("中文");
  const [slideCount, setSlideCount] = useState(8);
  const [audience, setAudience] = useState("一般受众");
  const [tone, setTone] = useState("专业、清晰、偏实用");
  const [referenceContent, setReferenceContent] = useState("");
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

  const [previewHtml, setPreviewHtml] = useState(false);
  const [showHtmlPreview, setShowHtmlPreview] = useState(false);
  const [slides, setSlides] = useState<SlideInfo[]>([]);
  const [slidesError, setSlidesError] = useState<string | null>(null);
  const [htmlRev, setHtmlRev] = useState(0);
  const [adjustTarget, setAdjustTarget] = useState<string>("all");
  const [adjustFeedback, setAdjustFeedback] = useState<string>("");
  const [isAdjusting, setIsAdjusting] = useState(false);
  const [pendingSlidesReload, setPendingSlidesReload] = useState(false);
  const [previewScale, setPreviewScale] = useState(1);
  const previewHostRef = useRef<HTMLDivElement | null>(null);

  const esRef = useRef<EventSource | null>(null);
  const pollRef = useRef<number | null>(null);
  const tailRef = useRef<HTMLDivElement | null>(null);
  const seenLogRef = useRef<Set<string>>(new Set());

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
    if (!res.ok) {
      let msg = "查询任务状态失败";
      if (res.status === 404) {
        msg = `任务不存在或服务已重启（jobId=${id}）。如果已生成产物，请检查 workspace/jobs/${id}/`; 
      } else {
        const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (typeof data.error === "string" && data.error.trim()) msg = data.error;
      }
      setError(msg);
      setStatus("error");
      return;
    }

    const data = (await res.json()) as JobResponse;
    setStatus(data.status);
    setSessionId(data.sessionId);
    setError(data.error);
    const nextLogs = data.logs ?? [];
    setLogs(nextLogs);
    seenLogRef.current = new Set(nextLogs.map((l) => `${l.ts}|${l.message}`));
    if (typeof data.outlineMarkdown === "string") setOutlineMarkdown(data.outlineMarkdown);
    setPptxUrl(data.pptxUrl);

    if (data.status !== "queued" && data.status !== "running") {
      if (pollRef.current) {
        window.clearInterval(pollRef.current);
        pollRef.current = null;
      }
    }
  }

  function startPolling(id: string) {
    if (pollRef.current) return;
    pollRef.current = window.setInterval(() => {
      void refreshJob(id);
    }, 1500);
  }

  function stopPolling() {
    if (!pollRef.current) return;
    window.clearInterval(pollRef.current);
    pollRef.current = null;
  }

  async function start() {
    setError(null);
    setLogs([]);
    setOutlineMarkdown("");
    setPptxUrl(null);
    seenLogRef.current = new Set();

    const res = await fetch("/api/ppt/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        topic,
        language,
        slideCount,
        audience,
        tone,
        referenceContent: referenceContent.trim() || undefined,
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

    // 先连 SSE，再 refresh，避免“日志重放 + refresh”造成重复
    esRef.current?.close();
    const es = new EventSource(`/api/ppt/jobs/${id}/events`);
    esRef.current = es;

    startPolling(id);

    await refreshJob(id);

    es.addEventListener("log", (ev) => {
      try {
        const payload = JSON.parse((ev as MessageEvent).data);
        const key = `${payload.ts}|${payload.message}`;
        if (seenLogRef.current.has(key)) return;
        seenLogRef.current.add(key);
        if (seenLogRef.current.size > 1200) {
          // 防止长时间运行导致内存增长
          const next = new Set(Array.from(seenLogRef.current).slice(-900));
          seenLogRef.current = next;
        }
        setLogs((cur) => [...cur, payload]);
      } catch {
        // ignore
      }
    });

    es.addEventListener("status", (ev) => {
      try {
        const payload = JSON.parse((ev as MessageEvent).data);
        setStatus(payload.status);
        if (payload.status !== "queued" && payload.status !== "running") {
          stopPolling();
        }
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
      stopPolling();
    };

    es.addEventListener("result", () => void finish());
    es.addEventListener("error", () => void finish());
    es.addEventListener("flush", () => void refreshJob(id));
  }

  async function approve() {
    if (!jobId) return;
    setError(null);
    setShowHtmlPreview(previewHtml);
    if (previewHtml) {
      setSlides([]);
      setSlidesError(null);
      setHtmlRev((v) => v + 1);
    }
    const res = await fetch(`/api/ppt/jobs/${jobId}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        outlineMarkdown,
        stylePreset,
        palette,
        model: model || undefined,
        buildMode: previewHtml ? "preview" : "pptx",
      }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data?.error ?? "提交确认失败");
      return;
    }
    await refreshJob(jobId);
  }

  async function loadSlides() {
    if (!jobId) return;
    setSlidesError(null);
    const res = await fetch(`/api/ppt/jobs/${jobId}/slides`, { cache: "no-store" });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || data.ok !== true) {
      setSlides([]);
      setSlidesError((data.error as string) ?? "加载 slides 失败");
      return;
    }
    const list = Array.isArray(data.slides) ? data.slides : [];
    const parsed: SlideInfo[] = list
      .map((x) => (typeof x === "object" && x !== null ? (x as any) : null))
      .filter(Boolean)
      .map((x) => ({
        name: typeof x.name === "string" ? x.name : "",
        activeVersion: typeof x.activeVersion === "string" ? x.activeVersion : null,
        versions: Array.isArray(x.versions)
          ? x.versions
              .filter((v: any) => v && typeof v.id === "string")
              .map((v: any) => ({
                id: String(v.id),
                createdAt: typeof v.createdAt === "number" ? v.createdAt : 0,
                note: typeof v.note === "string" ? v.note : undefined,
              }))
          : [],
      }))
      .filter((s) => s.name && s.name.toLowerCase().endsWith(".html"));
    setSlides(parsed);
  }

  async function activateVersion(slideName: string, versionId: string) {
    if (!jobId) return;
    setError(null);
    const res = await fetch(`/api/ppt/jobs/${jobId}/slides/activate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slideName, versionId }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data?.error ?? "切换版本失败");
      return;
    }
    setHtmlRev((v) => v + 1);
    void loadSlides();
    await refreshJob(jobId);
  }

  async function renderFromHtml() {
    if (!jobId) return;
    setError(null);
    const res = await fetch(`/api/ppt/jobs/${jobId}/render`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: model || undefined }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data?.error ?? "渲染 PPTX 失败");
      return;
    }
    await refreshJob(jobId);
  }

  async function adjustHtml() {
    if (!jobId) return;
    if (!adjustFeedback.trim()) return;
    setIsAdjusting(true);
    setError(null);
    try {
      const res = await fetch(`/api/ppt/jobs/${jobId}/slides/adjust`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target: adjustTarget,
          feedback: adjustFeedback,
          model: model || undefined,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data?.error ?? "调整 HTML 失败");
        return;
      }
      // 后台异步调整：等状态回到 done 再刷新（避免读到旧 HTML）
      setPendingSlidesReload(true);
      await refreshJob(jobId);
    } finally {
      setIsAdjusting(false);
    }
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
      stopPolling();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    tailRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [logs.length]);

  useEffect(() => {
    if (!jobId) return;
    // 只要 slides 存在，就允许预览（不强绑 buildMode，避免刷新页面后丢 UI）。
    if (status === "done" && showHtmlPreview) {
      void loadSlides();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, status, showHtmlPreview]);

  useEffect(() => {
    if (!jobId) return;
    if (!showHtmlPreview) return;
    if (!pendingSlidesReload) return;
    if (status === "error") {
      setPendingSlidesReload(false);
      return;
    }
    if (status !== "done") return;
    setPendingSlidesReload(false);
    setHtmlRev((v) => v + 1);
    void loadSlides();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, status, showHtmlPreview, pendingSlidesReload]);

  useEffect(() => {
    if (!showHtmlPreview) return;
    const el = previewHostRef.current;
    if (!el) return;

    const BASE_W = 960;
    const BASE_H = 540;

    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const w = entry.contentRect.width;
      const h = entry.contentRect.height;
      const s = Math.min(w / BASE_W, h / BASE_H);
      if (!Number.isFinite(s) || s <= 0) return;
      setPreviewScale(s);
    });

    ro.observe(el);
    return () => ro.disconnect();
  }, [showHtmlPreview]);

  return (
    <Box>
      <Stack spacing={2}>
        <Box>
          <Typography variant="h6" sx={{ fontWeight: 800, letterSpacing: -0.2 }}>
            生成任务
          </Typography>
          <Typography variant="body2" sx={{ color: "text.secondary" }}>
            先生成可编辑大纲，再确认生成 PPTX。
          </Typography>
        </Box>

        <Stack spacing={1.5}>
          <TextField
            label="PPT 主题"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder="例如：面向新员工的 Git 入门与规范"
            fullWidth
            size="small"
          />

          <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5}>
            <TextField
              label="语言"
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              placeholder="中文 / English"
              fullWidth
              size="small"
            />
            <TextField
              label="页数"
              type="number"
              inputProps={{ min: 3, max: 20 }}
              value={slideCount}
              onChange={(e) => setSlideCount(Number(e.target.value))}
              fullWidth
              size="small"
            />
          </Stack>

          <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5}>
            <TextField
              label="受众"
              value={audience}
              onChange={(e) => setAudience(e.target.value)}
              placeholder="例如：产品经理 / 技术团队 / 客户"
              fullWidth
              size="small"
            />
            <TextField
              label="语气/风格"
              value={tone}
              onChange={(e) => setTone(e.target.value)}
              placeholder="例如：商业路演 / 教学 / 极简"
              fullWidth
              size="small"
            />
          </Stack>

          <TextField
            label="参考内容（可选）"
            value={referenceContent}
            onChange={(e) => setReferenceContent(e.target.value)}
            placeholder="可粘贴材料要点/链接/术语解释/你希望覆盖的事实（生成大纲时会一起提供给模型）"
            multiline
            minRows={6}
            maxRows={12}
            size="small"
            fullWidth
            InputProps={{
              sx: {
                "& textarea": {
                  resize: "vertical",
                  maxHeight: 260,
                  overflow: "auto",
                },
              },
            }}
          />

          <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5}>
            <TextField
              label="模板/风格预设"
              value={stylePreset}
              onChange={(e) => setStylePreset(e.target.value)}
              placeholder="Editorial / Modern Grid / Clean"
              fullWidth
              size="small"
            />
            <TextField
              label="配色方案"
              value={palette}
              onChange={(e) => setPalette(e.target.value)}
              placeholder="Sand & Ink / Teal & Coral"
              fullWidth
              size="small"
            />
          </Stack>

          <FormControl fullWidth size="small" disabled={modelOptions.length === 0}>
            <InputLabel id="model-select-label">使用模型（provider/model）</InputLabel>
            <Select
              labelId="model-select-label"
              label="使用模型（provider/model）"
              value={model}
              onChange={(e) => setModel(String(e.target.value))}
            >
              {modelOptions.length === 0 ? (
                <MenuItem value="">
                  (暂无模型，请先配置供应商/模型)
                </MenuItem>
              ) : (
                modelOptions.map((m) => (
                  <MenuItem key={m} value={m}>
                    {m}
                  </MenuItem>
                ))
              )}
            </Select>
            {modelLoadError ? (
              <Typography variant="caption" sx={{ color: "error.main", mt: 0.5 }}>
                {modelLoadError}
              </Typography>
            ) : null}
          </FormControl>

          <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} alignItems={{ sm: "center" }}>
            <Button
              variant="contained"
              onClick={start}
              disabled={!canSubmit || modelOptions.length === 0}
            >
              生成大纲
            </Button>
            <Typography variant="body2" sx={{ color: "text.secondary" }}>
              {jobId ? (
                <span>
                  jobId: <code>{jobId}</code>
                </span>
              ) : (
                <span>提交后会返回 jobId</span>
              )}
            </Typography>
          </Stack>
        </Stack>

        <Divider />

        <Stack spacing={1.5}>
          <Stack
            direction={{ xs: "column", sm: "row" }}
            spacing={1}
            useFlexGap
            sx={{
              alignItems: { sm: "center" },
              justifyContent: "space-between",
            }}
          >
            <Stack direction="row" spacing={1.5} alignItems="center" flexWrap="wrap">
              <Typography variant="body2">
                状态：<b>{status ?? "-"}</b>
              </Typography>
              {sessionId ? (
                <Typography variant="body2">
                  sessionId：<code>{sessionId}</code>
                </Typography>
              ) : null}
            </Stack>
          </Stack>

          {jobId && outlineMarkdown ? (
            <Stack spacing={1}>
              <TextField
                label="大纲（可编辑）"
                value={outlineMarkdown}
                onChange={(e) => setOutlineMarkdown(e.target.value)}
                multiline
                minRows={12}
                fullWidth
                InputProps={{
                  sx: {
                    fontFamily: monoFontFamily,
                    fontSize: 12,
                    lineHeight: 1.6,
                  },
                }}
              />
              <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} alignItems={{ sm: "center" }}>
                <Button variant="contained" onClick={approve} disabled={!jobId}>
                  使用该大纲生成 PPT
                </Button>
                <FormControlLabel
                  control={
                    <Checkbox
                      checked={previewHtml}
                      onChange={(e) => setPreviewHtml(e.target.checked)}
                      size="small"
                    />
                  }
                  label="生成 HTML 后先预览"
                />
                <Typography variant="caption" sx={{ color: "text.secondary" }}>
                  你也可以先修改大纲，再点生成。
                </Typography>
              </Stack>
            </Stack>
          ) : null}

          {error ? <Alert severity="error">错误：{error}</Alert> : null}

          <Paper
            variant="outlined"
            sx={{
              p: 1.5,
              bgcolor: "rgba(255,255,255,0.6)",
              minHeight: 120,
              maxHeight: 260,
              overflow: "auto",
              fontFamily: monoFontFamily,
              fontSize: 12,
              lineHeight: 1.6,
            }}
          >
            {logs.length === 0 ? (
              <Box sx={{ opacity: 0.6 }}>日志会显示在这里</Box>
            ) : (
              logs.map((l, idx) => (
                <Box key={`${l.ts}-${idx}`}>
                  <Box component="span" sx={{ opacity: 0.6 }}>
                    [{fmtTime(l.ts)}]
                  </Box>{" "}
                  {l.message}
                </Box>
              ))
            )}
            <div ref={tailRef} />
          </Paper>

          {pptxUrl ? (
            <Stack direction="row" justifyContent="flex-end">
              <Button component="a" href={pptxUrl} variant="outlined">
                下载 PPTX
              </Button>
            </Stack>
          ) : null}

          {jobId && showHtmlPreview ? (
            <Stack spacing={1.25}>
              <Divider />
              <Stack direction={{ xs: "column", sm: "row" }} spacing={1} alignItems={{ sm: "center" }}>
                <Typography variant="subtitle2" sx={{ fontWeight: 800 }}>
                  HTML 预览
                </Typography>
                <Stack direction="row" spacing={1} sx={{ ml: { sm: "auto" } }}>
                  <Button size="small" variant="outlined" onClick={loadSlides}>
                    刷新 slides
                  </Button>
                </Stack>
              </Stack>

              {slidesError ? <Alert severity="warning">{slidesError}</Alert> : null}

              {slides.length === 0 ? (
                <Typography variant="body2" sx={{ color: "text.secondary" }}>
                  暂无 slides（等待生成完成或点击“刷新 slides”）。
                </Typography>
              ) : null}

              <FormControl size="small" sx={{ maxWidth: 360 }}>
                <InputLabel id="adjust-target-label">调整范围</InputLabel>
                <Select
                  labelId="adjust-target-label"
                  label="调整范围"
                  value={adjustTarget}
                  onChange={(e) => setAdjustTarget(String(e.target.value))}
                >
                  <MenuItem value="all">全部 HTML</MenuItem>
                  {slides.map((s) => (
                    <MenuItem key={s.name} value={s.name}>
                      {s.name}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>

              <TextField
                size="small"
                label="修改意见"
                value={adjustFeedback}
                onChange={(e) => setAdjustFeedback(e.target.value)}
                placeholder="例如：统一把标题字号调小一点，留出更大下边距；第 03 页用更简洁的 bullet；配色更克制…"
                multiline
                minRows={2}
                fullWidth
              />

              <Stack direction={{ xs: "column", sm: "row" }} spacing={1} alignItems={{ sm: "center" }}>
                <Button size="small" variant="contained" onClick={renderFromHtml}>
                  用当前 HTML 渲染 PPTX
                </Button>
                <Button
                  size="small"
                  variant="outlined"
                  onClick={adjustHtml}
                  disabled={isAdjusting || !adjustFeedback.trim()}
                >
                  应用调整
                </Button>
              </Stack>

              <Stack spacing={1.25}>
                {slides.map((s, idx) => (
                  <Paper
                    key={`${s.name}-${s.activeVersion ?? "na"}-${htmlRev}`}
                    variant="outlined"
                    sx={{ p: 1 }}
                  >
                    <Stack
                      direction={{ xs: "column", sm: "row" }}
                      spacing={1}
                      alignItems={{ sm: "center" }}
                      justifyContent="space-between"
                    >
                      <Typography variant="caption" sx={{ color: "text.secondary" }}>
                        {s.name}
                      </Typography>
                      <FormControl size="small" sx={{ minWidth: 220 }}>
                        <InputLabel id={`ver-${s.name.replace(/[^a-z0-9_-]/gi, "_")}`}>版本</InputLabel>
                        <Select
                          labelId={`ver-${s.name.replace(/[^a-z0-9_-]/gi, "_")}`}
                          label="版本"
                          value={s.activeVersion ?? ""}
                          onChange={(e) => void activateVersion(s.name, String(e.target.value))}
                        >
                          {s.versions
                            .slice()
                            .sort((a, b) => b.createdAt - a.createdAt)
                            .map((v) => (
                              <MenuItem key={v.id} value={v.id}>
                                {v.id}
                                {v.note ? ` - ${v.note}` : ""}
                              </MenuItem>
                            ))}
                        </Select>
                      </FormControl>
                    </Stack>
                    <Box
                      ref={idx === 0 ? previewHostRef : undefined}
                      sx={{
                        mt: 0.75,
                        width: "100%",
                        position: "relative",
                        borderRadius: 1,
                        overflow: "hidden",
                        bgcolor: "#fff",
                        border: "1px solid rgba(0,0,0,0.08)",
                        paddingTop: "56.25%", // 16:9
                      }}
                    >
                      <Box
                        component="iframe"
                        title={s.name}
                        src={`/api/ppt/jobs/${jobId}/files/slides/${encodeURIComponent(
                          s.name
                        )}?ver=${encodeURIComponent(s.activeVersion ?? "")}&v=${htmlRev}`}
                        scrolling="no"
                        sx={{
                          position: "absolute",
                          inset: 0,
                          width: 960,
                          height: 540,
                          transform: `scale(${previewScale})`,
                          transformOrigin: "0 0",
                          border: 0,
                        }}
                      />
                    </Box>
                  </Paper>
                ))}
              </Stack>
            </Stack>
          ) : null}
        </Stack>
      </Stack>
    </Box>
  );
}
