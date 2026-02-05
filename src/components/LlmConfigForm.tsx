"use client";

import { useEffect, useMemo, useState } from "react";

import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Divider from "@mui/material/Divider";
import FormControl from "@mui/material/FormControl";
import InputLabel from "@mui/material/InputLabel";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";

type ProviderType = "openai-compatible" | "openai" | "google" | "anthropic";

type ProviderEntry = {
  npm?: string;
  options?: { apiKey?: string; baseURL?: string } & Record<string, unknown>;
  models?: Record<string, { name?: string } & Record<string, unknown>>;
} & Record<string, unknown>;

type OpencodeConfig = {
  $schema?: string;
  model?: string;
  provider?: Record<string, ProviderEntry>;
} & Record<string, unknown>;

type OpencodeMeta = {
  providers?: Record<string, { hasApiKey: boolean }>;
};

const PROVIDER_TYPES: { value: ProviderType; label: string; npm: string }[] = [
  {
    value: "openai-compatible",
    label: "OpenAI Compatible",
    npm: "@ai-sdk/openai-compatible",
  },
  { value: "openai", label: "OpenAI", npm: "@ai-sdk/openai" },
  { value: "google", label: "Google", npm: "@ai-sdk/google" },
  { value: "anthropic", label: "Anthropic", npm: "@ai-sdk/anthropic" },
];

function inferProviderType(npm: string | undefined): ProviderType {
  const hit = PROVIDER_TYPES.find((p) => p.npm === npm);
  return hit?.value ?? "openai-compatible";
}

export default function LlmConfigForm({ embedded }: { embedded?: boolean }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [providerIds, setProviderIds] = useState<string[]>([]);
  const [selectedProviderId, setSelectedProviderId] = useState<string>("__new__");
  const [hasApiKey, setHasApiKey] = useState(false);

  const [providerType, setProviderType] = useState<ProviderType>("openai-compatible");
  const [providerId, setProviderId] = useState("myprovider");
  const [baseURL, setBaseURL] = useState("https://api.myprovider.com/v1");
  const [apiKey, setApiKey] = useState("");

  const [models, setModels] = useState<string[]>(["my-model-name"]);
  const [newModelName, setNewModelName] = useState("");

  const providerNpm = useMemo(() => {
    return PROVIDER_TYPES.find((p) => p.value === providerType)?.npm;
  }, [providerType]);

  async function load(selectProviderId?: string) {
    setLoading(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch("/api/opencode/config", { cache: "no-store" });
      const data = (await res.json()) as unknown;
      const obj =
        typeof data === "object" && data !== null
          ? (data as Record<string, unknown>)
          : {};
      if (!res.ok || obj.ok !== true) {
        throw new Error((obj.error as string) ?? "Failed to load config");
      }

      const cfg = (obj.config ?? {}) as OpencodeConfig;
      const meta = (obj.meta ?? {}) as OpencodeMeta;
      const providers = cfg.provider ?? {};

      const ids = Object.keys(providers).sort();
      setProviderIds(ids);

      // When user picks "+ 新增供应商" ("__new__"), providers["__new__"] is always falsy.
      // If we don't special-case it, we will fall back to the previously selected provider
      // and the UI looks like "no response".
      const pid =
        (selectProviderId === "__new__"
          ? "__new__"
          : selectProviderId && providers[selectProviderId]
            ? selectProviderId
            : null) ??
        (selectedProviderId !== "__new__" && providers[selectedProviderId]
          ? selectedProviderId
          : null) ??
        ids[0] ??
        "__new__";

      setSelectedProviderId(pid);

      if (pid === "__new__") {
        setProviderId("myprovider");
        setProviderType("openai-compatible");
        setBaseURL("https://api.myprovider.com/v1");
        setApiKey("");
        setModels(["my-model-name"]);
        setHasApiKey(false);
        return;
      }

      const p = providers[pid] ?? {};
      setProviderId(pid);
      setProviderType(inferProviderType(p.npm));
      if (typeof p.options?.baseURL === "string") setBaseURL(p.options.baseURL);
      setApiKey("");

      const m = Object.keys(p.models ?? {}).sort();
      const nextModels = m.length > 0 ? m : ["my-model-name"];
      setModels(nextModels);

      const providerMeta = meta.providers?.[pid];
      setHasApiKey(Boolean(providerMeta?.hasApiKey));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  async function saveAndReload() {
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const dedupModels = Array.from(
        new Set(models.map((x) => x.trim()).filter((x) => x.length > 0))
      );
      if (dedupModels.length === 0) {
        throw new Error("至少需要 1 个模型");
      }

      const body: Record<string, unknown> = {
        action: "upsertProvider",
        providerType,
        providerId: providerId.trim(),
        baseURL: baseURL.trim(),
        models: dedupModels,
      };

      // key 留空表示“保留旧 key”
      if (apiKey.trim().length > 0) body.apiKey = apiKey.trim();

      const res = await fetch("/api/opencode/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok || data.ok !== true) {
        throw new Error((data.error as string) ?? "Failed to write config");
      }

      let reloadProblem: string | null = null;
      try {
        const reloadRes = await fetch("/api/opencode/reload", { method: "POST" });
        const reloadData = (await reloadRes
          .json()
          .catch(() => ({}))) as Record<string, unknown>;
        if (!reloadRes.ok || reloadData.ok !== true) {
          reloadProblem =
            (reloadData.reason as string) ??
            (reloadData.error as string) ??
            "Reload failed";
        }
      } catch (e) {
        reloadProblem = e instanceof Error ? e.message : String(e);
      }

      setMessage(
        reloadProblem
          ? `保存成功，但重载失败：${reloadProblem}`
          : "保存成功，已重载 opencode server。新创建的 session 会立即使用该 provider/model。"
      );
      setApiKey("");
      await load(providerId.trim());

      // 通知 PPT 表单刷新模型下拉框
      window.dispatchEvent(new Event("opencode:models-changed"));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function deleteProvider() {
    if (selectedProviderId === "__new__") return;

    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch("/api/opencode/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "deleteProvider", providerId: selectedProviderId }),
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok || data.ok !== true) {
        throw new Error((data.error as string) ?? "Failed to delete provider");
      }

      let reloadProblem: string | null = null;
      try {
        const reloadRes = await fetch("/api/opencode/reload", { method: "POST" });
        const reloadData = (await reloadRes
          .json()
          .catch(() => ({}))) as Record<string, unknown>;
        if (!reloadRes.ok || reloadData.ok !== true) {
          reloadProblem =
            (reloadData.reason as string) ??
            (reloadData.error as string) ??
            "Reload failed";
        }
      } catch (e) {
        reloadProblem = e instanceof Error ? e.message : String(e);
      }

      setMessage(reloadProblem ? `删除成功，但重载失败：${reloadProblem}` : "删除成功，已重载 opencode server。");
      await load();

      // 通知 PPT 表单刷新模型下拉框
      window.dispatchEvent(new Event("opencode:models-changed"));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  const isNew = selectedProviderId === "__new__";

  function addModel() {
    const v = newModelName.trim();
    if (!v) return;
    if (models.includes(v)) {
      setNewModelName("");
      return;
    }
    const next = [...models, v].filter(Boolean);
    setModels(next);
    setNewModelName("");
  }

  function removeModel(name: string) {
    const next = models.filter((m) => m !== name);
    if (next.length === 0) return;
    setModels(next);
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Stack spacing={2}>
      {!embedded ? (
        <Box>
          <Typography variant="h6" sx={{ fontWeight: 800, letterSpacing: -0.2 }}>
            LLM 配置
          </Typography>
          <Typography variant="body2" sx={{ color: "text.secondary" }}>
            写入 <code>web/opencode.json</code>，并重载内嵌 opencode server。
          </Typography>
        </Box>
      ) : null}

      <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={2}>
        <Typography variant="body2" sx={{ color: "text.secondary" }}>
          {loading ? "加载中..." : saving ? "保存中..." : ""}
        </Typography>
        <Button onClick={() => void load()} disabled={loading || saving} variant="outlined">
          刷新
        </Button>
      </Stack>

      {error ? <Alert severity="error">{error}</Alert> : null}
      {message ? <Alert severity="success">{message}</Alert> : null}

      <Stack spacing={2}>
        <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5}>
          <FormControl fullWidth size="small">
            <InputLabel id="provider-select-label">已配置供应商</InputLabel>
            <Select
              labelId="provider-select-label"
              label="已配置供应商"
              value={selectedProviderId}
              onChange={(e) => void load(String(e.target.value))}
            >
              <MenuItem value="__new__">+ 新增供应商</MenuItem>
              {providerIds.map((id) => (
                <MenuItem key={id} value={id}>
                  {id}
                </MenuItem>
              ))}
            </Select>
          </FormControl>

          <TextField
            label="供应商名称（providerId）"
            value={providerId}
            onChange={(e) => setProviderId(e.target.value)}
            disabled={!isNew}
            placeholder="例如：openai / anthropic / myprovider"
            fullWidth
            size="small"
            helperText={
              !isNew
                ? "已存在的 providerId 为键，不建议在线改名（删除后重建更安全）。"
                : ""
            }
          />
        </Stack>

        <Box
          sx={{
            display: "grid",
            gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr" },
            columnGap: 1.5,
            rowGap: 0.5,
            alignItems: { sm: "center" },
          }}
        >
          <FormControl fullWidth size="small">
            <InputLabel id="provider-type-label">供应商类型</InputLabel>
            <Select
              labelId="provider-type-label"
              label="供应商类型"
              value={providerType}
              onChange={(e) => setProviderType(e.target.value as ProviderType)}
            >
              {PROVIDER_TYPES.map((p) => (
                <MenuItem key={p.value} value={p.value}>
                  {p.label}
                </MenuItem>
              ))}
            </Select>
          </FormControl>

          <Box>
            {!isNew ? (
              <Button
                onClick={deleteProvider}
                disabled={loading || saving}
                variant="contained"
                color="error"
                fullWidth
              >
                删除该供应商
              </Button>
            ) : (
              <Typography variant="caption" sx={{ color: "text.secondary" }}>
                新增供应商：填写完下面信息后点“保存并重载”。
              </Typography>
            )}
          </Box>

          <Typography variant="caption" sx={{ color: "text.secondary" }}>
            npm: <code>{providerNpm}</code>
          </Typography>
        </Box>

        <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5}>
          <TextField
            label="URL（baseURL）"
            value={baseURL}
            onChange={(e) => setBaseURL(e.target.value)}
            placeholder="https://api.xxx.com/v1"
            fullWidth
            size="small"
          />

          <TextField
            label="Key（apiKey）"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={hasApiKey ? "留空=保留已保存 key" : "sk-..."}
            fullWidth
            size="small"
            helperText={hasApiKey ? "当前 provider 已保存 key（不会回显）。不修改就保持留空。" : ""}
          />
        </Stack>

        <Divider />

        <Stack spacing={1}>
          <Box>
            <Typography variant="subtitle1" sx={{ fontWeight: 800 }}>
              模型
            </Typography>
            <Typography variant="caption" sx={{ color: "text.secondary" }}>
              同名 = 展示名
            </Typography>
          </Box>

          <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5}>
            <TextField
              label="新增 modelName"
              value={newModelName}
              onChange={(e) => setNewModelName(e.target.value)}
              placeholder="例如：gpt-4.1-mini"
              fullWidth
              size="small"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addModel();
                }
              }}
            />
            <Button
              onClick={addModel}
              disabled={!newModelName.trim()}
              variant="outlined"
              sx={{ whiteSpace: "nowrap" }}
            >
              添加模型
            </Button>
          </Stack>

          <Box sx={{ display: "flex", flexWrap: "wrap", gap: 1 }}>
            {models.map((m) => (
              <Chip
                key={m}
                label={<code>{m}</code>}
                onDelete={models.length <= 1 ? undefined : () => removeModel(m)}
                variant="outlined"
                sx={{ bgcolor: "rgba(255,255,255,0.55)" }}
              />
            ))}
          </Box>
        </Stack>

        <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} alignItems={{ sm: "center" }}>
          <Button
            onClick={saveAndReload}
            disabled={loading || saving || !providerId.trim() || !baseURL.trim() || models.length === 0}
            variant="contained"
            startIcon={saving ? <CircularProgress size={16} /> : undefined}
          >
            保存并重载
          </Button>
          <Typography variant="caption" sx={{ color: "text.secondary" }}>
            会更新当前 provider 的配置；不在列表里的模型会被移除。
          </Typography>
        </Stack>
      </Stack>
    </Stack>
  );
}
