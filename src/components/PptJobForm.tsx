"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import CircularProgress from "@mui/material/CircularProgress";
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

type PptJobInput = {
  topic: string;
  language?: string;
  slideCount?: number;
  audience?: string;
  tone?: string;
  referenceContent?: string;
  stylePreset?: string;
  palette?: string;
  model?: string;
};

type JobResponse = {
  id: string;
  input: PptJobInput;
  status: JobStatus;
  sessionId: string | null;
  error: string | null;
  logs: { ts: number; message: string }[];
  outlineMarkdown?: string | null;
  pptxUrl: string | null;
  thumbnailsUrl?: string | null;
};

type JobSummary = {
  id: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  topic: string;
  slideCount: number | null;
  hasOutline: boolean;
  hasSlides: boolean;
  slidesCount: number;
  hasPptx: boolean;
  error: string | null;
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

function fmtDateTime(ts: number) {
  if (!ts) return "-";
  const d = new Date(ts);
  return d.toLocaleString();
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

  const [recentJobs, setRecentJobs] = useState<JobSummary[]>([]);
  const [recentJobsLoading, setRecentJobsLoading] = useState(false);
  const [recentJobsError, setRecentJobsError] = useState<string | null>(null);
  const [recentPick, setRecentPick] = useState<string>("");
  const [resumeJobId, setResumeJobId] = useState<string>("");
  const [isResuming, setIsResuming] = useState(false);

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

  const canSubmit = useMemo(() => {
    if (topic.trim().length === 0) return false;
    if (!Number.isFinite(slideCount)) return false;
    if (slideCount === 0) return true; // 0 = let AI decide
    if (slideCount < 3 || slideCount > 20) return false;
    return true;
  }, [topic, slideCount]);

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

  async function loadRecentJobs() {
    setRecentJobsLoading(true);
    setRecentJobsError(null);
    try {
      const res = await fetch("/api/ppt/jobs", { cache: "no-store" });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok || data.ok !== true) {
        throw new Error((data.error as string) ?? "加载 workspace 任务列表失败");
      }
      const list = Array.isArray(data.jobs) ? (data.jobs as unknown[]) : [];
      const parsed: JobSummary[] = list
        .map((x) => (typeof x === "object" && x !== null ? (x as Record<string, unknown>) : null))
        .filter((x): x is Record<string, unknown> => Boolean(x))
        .map((x) => ({
          id: typeof x.id === "string" ? x.id : "",
          status: typeof x.status === "string" ? x.status : "unknown",
          createdAt: typeof x.createdAt === "number" ? x.createdAt : 0,
          updatedAt: typeof x.updatedAt === "number" ? x.updatedAt : 0,
          topic: typeof x.topic === "string" ? x.topic : "",
          slideCount: typeof x.slideCount === "number" ? x.slideCount : null,
          hasOutline: Boolean(x.hasOutline),
          hasSlides: Boolean(x.hasSlides),
          slidesCount: typeof x.slidesCount === "number" ? x.slidesCount : 0,
          hasPptx: Boolean(x.hasPptx),
          error: typeof x.error === "string" ? x.error : null,
        }))
        .filter((j) => j.id);
      setRecentJobs(parsed);
    } catch (e) {
      setRecentJobs([]);
      setRecentJobsError(e instanceof Error ? e.message : String(e));
    } finally {
      setRecentJobsLoading(false);
    }
  }

  function attachJobStream(id: string) {
    esRef.current?.close();
    const es = new EventSource(`/api/ppt/jobs/${id}/events`);
    esRef.current = es;

    es.addEventListener("log", (ev) => {
      try {
        const payload = JSON.parse((ev as MessageEvent).data);
        const key = `${payload.ts}|${payload.message}`;
        if (seenLogRef.current.has(key)) return;
        seenLogRef.current.add(key);
        if (seenLogRef.current.size > 1200) {
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

    es.addEventListener("flush", () => void refreshJob(id));

    es.addEventListener("result", () => {
      void refreshJob(id);
    });

    es.addEventListener("error", (ev) => {
      // Avoid closing stream on transient network errors.
      const maybeData = (ev as unknown as { data?: unknown }).data;
      if (typeof maybeData === "string" && maybeData.trim()) {
        void refreshJob(id);
      }
    });

    return es;
  }

  async function refreshJob(id: string, opts?: { hydrateInput?: boolean }) {
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

    if (opts?.hydrateInput && data.input) {
      setTopic(typeof data.input.topic === "string" ? data.input.topic : "");
      setLanguage(typeof data.input.language === "string" ? data.input.language : "中文");
      setSlideCount(
        typeof data.input.slideCount === "number" && Number.isFinite(data.input.slideCount)
          ? data.input.slideCount
          : 8
      );
      setAudience(typeof data.input.audience === "string" ? data.input.audience : "一般受众");
      setTone(
        typeof data.input.tone === "string" ? data.input.tone : "专业、清晰、偏实用"
      );
      setReferenceContent(
        typeof data.input.referenceContent === "string" ? data.input.referenceContent : ""
      );
      setStylePreset(
        typeof data.input.stylePreset === "string" ? data.input.stylePreset : "Editorial"
      );
      setPalette(
        typeof data.input.palette === "string" ? data.input.palette : "Sand & Ink"
      );
      if (typeof data.input.model === "string") {
        setModel(data.input.model);
      }
    }

    setStatus(data.status);
    setSessionId(data.sessionId);
    setError(data.error);
    const nextLogs = data.logs ?? [];
    setLogs(nextLogs);
    seenLogRef.current = new Set(nextLogs.map((l) => `${l.ts}|${l.message}`));
    if (typeof data.outlineMarkdown === "string") setOutlineMarkdown(data.outlineMarkdown);
    setPptxUrl(data.pptxUrl);

    if (data.status === "queued" || data.status === "running") {
      startPolling(id);
    } else {
      stopPolling();
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

  async function resumeJob(idRaw: string) {
    const id = idRaw.trim();
    if (!id) return;

    setIsResuming(true);
    setError(null);
    setSlides([]);
    setSlidesError(null);
    setShowHtmlPreview(false);
    setPendingSlidesReload(false);
    setAdjustFeedback("");
    setAdjustTarget("all");
    setHtmlRev((v) => v + 1);

    setJobId(id);
    setStatus(null);
    setSessionId(null);
    setPptxUrl(null);
    setLogs([]);
    setOutlineMarkdown("");
    seenLogRef.current = new Set();

    stopPolling();
    esRef.current?.close();

    try {
      await refreshJob(id, { hydrateInput: true });
      attachJobStream(id);

      const list = await loadSlides(id);
      if (list.length > 0) {
        setShowHtmlPreview(true);
      }
    } finally {
      setIsResuming(false);
    }
  }

  async function start() {
    setError(null);
    setLogs([]);
    setOutlineMarkdown("");
    setPptxUrl(null);
    seenLogRef.current = new Set();
    setShowHtmlPreview(false);
    setSlides([]);
    setSlidesError(null);
    setPendingSlidesReload(false);

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

    stopPolling();
    esRef.current?.close();
    await refreshJob(id);
    attachJobStream(id);
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

  async function loadSlides(forJobId?: string): Promise<SlideInfo[]> {
    const id = (forJobId ?? jobId)?.trim();
    if (!id) return [];
    setSlidesError(null);
    const res = await fetch(`/api/ppt/jobs/${id}/slides`, { cache: "no-store" });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || data.ok !== true) {
      setSlides([]);
      setSlidesError((data.error as string) ?? "加载 slides 失败");
      return [];
    }
    const list = Array.isArray(data.slides) ? (data.slides as unknown[]) : [];
    const parsed: SlideInfo[] = list
      .map((item) => {
        if (!item || typeof item !== "object") return null;
        const obj = item as Record<string, unknown>;
        const name = typeof obj.name === "string" ? obj.name : "";
        const activeVersion = typeof obj.activeVersion === "string" ? obj.activeVersion : null;
        const versionsRaw = Array.isArray(obj.versions) ? (obj.versions as unknown[]) : [];
        const versions: SlideVersion[] = versionsRaw
          .map((v): SlideVersion | null => {
            if (!v || typeof v !== "object") return null;
            const vv = v as Record<string, unknown>;
            if (typeof vv.id !== "string") return null;
            const out: SlideVersion = {
              id: String(vv.id),
              createdAt: typeof vv.createdAt === "number" ? vv.createdAt : 0,
              ...(typeof vv.note === "string" ? { note: vv.note } : {}),
            };
            return out;
          })
          .filter((v): v is SlideVersion => v !== null);
        const out: SlideInfo = { name, activeVersion, versions };
        return out;
      })
      .filter((s): s is SlideInfo => s !== null && s.name.toLowerCase().endsWith(".html"));
    setSlides(parsed);
    return parsed;
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
    void loadRecentJobs();

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

    const calc = () => {
      // Use DOMRect (includes padding) to avoid ResizeObserver edge cases when
      // the box height is driven by percentage padding.
      const rect = el.getBoundingClientRect();
      const w = rect.width;
      const h = rect.height;
      const s = Math.min(w / BASE_W, h / BASE_H);
      if (!Number.isFinite(s) || s <= 0) return;
      setPreviewScale(s);
    };

    calc();

    const ro = new ResizeObserver(() => calc());
    ro.observe(el);
    return () => ro.disconnect();
  }, [showHtmlPreview, slides.length, htmlRev]);

  return (
    <Box>
      <Stack spacing={2}>
        <Paper
          variant="outlined"
          sx={{
            p: 1.5,
            bgcolor: "rgba(251, 247, 239, 0.55)",
            borderStyle: "dashed",
          }}
        >
          <Stack spacing={1.25}>
            <Stack
              direction={{ xs: "column", sm: "row" }}
              spacing={1}
              alignItems={{ sm: "center" }}
              justifyContent="space-between"
            >
              <Box>
                <Typography variant="subtitle2" sx={{ fontWeight: 900, letterSpacing: -0.2 }}>
                  继续之前的任务
                </Typography>
                <Typography variant="caption" sx={{ color: "text.secondary" }}>
                  从 <code>workspace/jobs/&lt;jobId&gt;/job.json</code> 恢复输入/日志/大纲；若已有 HTML
                  slides，会自动加载到下方预览。
                </Typography>
              </Box>

              <Stack direction="row" spacing={1} alignItems="center" sx={{ ml: { sm: "auto" } }}>
                <Button
                  size="small"
                  variant="outlined"
                  onClick={() => void loadRecentJobs()}
                  disabled={recentJobsLoading}
                >
                  刷新列表
                </Button>
                <Button
                  size="small"
                  variant="contained"
                  onClick={() => void resumeJob(resumeJobId || recentPick)}
                  disabled={isResuming || (!resumeJobId.trim() && !recentPick.trim())}
                >
                  {isResuming ? (
                    <Stack direction="row" spacing={1} alignItems="center">
                      <CircularProgress size={14} />
                      <span>加载中</span>
                    </Stack>
                  ) : (
                    "加载任务"
                  )}
                </Button>
              </Stack>
            </Stack>

            <Stack direction={{ xs: "column", sm: "row" }} spacing={1.25} alignItems={{ sm: "center" }}>
              <FormControl size="small" sx={{ minWidth: 280 }} disabled={recentJobs.length === 0}>
                <InputLabel id="recent-job-select">从 workspace 选择</InputLabel>
                <Select
                  labelId="recent-job-select"
                  label="从 workspace 选择"
                  value={recentPick}
                  onChange={(e) => {
                    const id = String(e.target.value);
                    setRecentPick(id);
                    setResumeJobId(id);
                  }}
                >
                  {recentJobs.length === 0 ? (
                    <MenuItem value="">(暂无 job.json 项目)</MenuItem>
                  ) : (
                    recentJobs.map((j) => {
                      const when = j.updatedAt || j.createdAt;
                      const label =
                        (j.topic ? j.topic.slice(0, 40) : "(无标题)") +
                        ` · ${j.status}` +
                        (j.slidesCount ? ` · HTML:${j.slidesCount}` : "") +
                        (j.hasPptx ? " · PPTX" : "") +
                        (when ? ` · ${fmtDateTime(when)}` : "");
                      return (
                        <MenuItem key={j.id} value={j.id}>
                          {label}
                        </MenuItem>
                      );
                    })
                  )}
                </Select>
              </FormControl>

              <TextField
                size="small"
                label="或手动输入 jobId"
                value={resumeJobId}
                onChange={(e) => setResumeJobId(e.target.value)}
                placeholder="例如：12602b57..."
                fullWidth
              />
            </Stack>

            {recentJobsError ? <Alert severity="warning">{recentJobsError}</Alert> : null}
          </Stack>
        </Paper>

        <Divider />

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
              inputProps={{ min: 0, max: 20 }}
              value={slideCount}
              onChange={(e) => {
                const raw = e.target.value;
                if (raw === "") {
                  setSlideCount(0);
                  return;
                }
                const n = Number(raw);
                setSlideCount(Number.isFinite(n) ? n : 0);
              }}
              error={
                !Number.isFinite(slideCount) ||
                slideCount < 0 ||
                slideCount > 20 ||
                (slideCount !== 0 && slideCount < 3)
              }
              helperText={
                slideCount === 0
                  ? "已选择：由 AI 自行决定页数（范围 3-20）"
                  : slideCount < 3
                    ? "页数最少 3；输入 0 表示让 AI 自行决定页数"
                    : slideCount > 20
                      ? "页数最多 20；或输入 0 让 AI 自行决定"
                      : "输入 0 表示让 AI 自行决定页数（范围 3-20）"
              }
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
                  <Button size="small" variant="outlined" onClick={() => void loadSlides()}>
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
