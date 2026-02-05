"use client";

import { useEffect, useMemo, useState } from "react";

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

export default function LlmConfigForm() {
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

      const pid =
        (selectProviderId && providers[selectProviderId] ? selectProviderId : null) ??
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

      const reloadRes = await fetch("/api/opencode/reload", { method: "POST" });
      const reloadData = (await reloadRes
        .json()
        .catch(() => ({}))) as Record<string, unknown>;
      if (!reloadRes.ok || reloadData.ok !== true) {
        throw new Error(
          (reloadData.reason as string) ??
            (reloadData.error as string) ??
            "Reload failed"
        );
      }

      setMessage(
        "保存成功，已重载 opencode server。新创建的 session 会立即使用该 provider/model。"
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

      const reloadRes = await fetch("/api/opencode/reload", { method: "POST" });
      const reloadData = (await reloadRes
        .json()
        .catch(() => ({}))) as Record<string, unknown>;
      if (!reloadRes.ok || reloadData.ok !== true) {
        throw new Error(
          (reloadData.reason as string) ??
            (reloadData.error as string) ??
            "Reload failed"
        );
      }

      setMessage("删除成功，已重载 opencode server。");
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
    <div style={{ display: "grid", gap: 12 }}>
      <div
        style={{
          display: "flex",
          gap: 12,
          flexWrap: "wrap",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <div>
          <div style={{ fontWeight: 700 }}>LLM 配置</div>
          <div style={{ fontSize: 12, opacity: 0.7 }}>
            写入 <code>web/opencode.json</code>，并重载内嵌 opencode server。
          </div>
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <button onClick={() => void load()} disabled={loading || saving}>
            刷新
          </button>
        </div>
      </div>

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
          {error}
        </div>
      ) : null}

      {message ? (
        <div
          style={{
            padding: 12,
            border: "1px solid rgba(0,140,90,0.25)",
            background: "rgba(0,140,90,0.06)",
            borderRadius: 10,
            color: "#0b4b31",
          }}
        >
          {message}
        </div>
      ) : null}

      <div style={{ display: "grid", gap: 12, gridTemplateColumns: "1fr 1fr" }}>
        <label>
          <div style={{ fontSize: 12, opacity: 0.75 }}>已配置供应商</div>
          <select
            value={selectedProviderId}
            onChange={(e) => void load(e.target.value)}
            style={{ width: "100%", padding: "10px 12px", borderRadius: 10 }}
          >
            <option value="__new__">+ 新增供应商</option>
            {providerIds.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </label>

        <label>
          <div style={{ fontSize: 12, opacity: 0.75 }}>供应商名称（providerId）</div>
          <input
            value={providerId}
            onChange={(e) => setProviderId(e.target.value.trim())}
            disabled={!isNew}
            placeholder="例如：openai / anthropic / myprovider"
            style={{ width: "100%" }}
          />
          {!isNew ? (
            <div style={{ fontSize: 12, opacity: 0.6, marginTop: 6 }}>
              已存在的 providerId 为键，不建议在线改名（删除后重建更安全）。
            </div>
          ) : null}
        </label>
      </div>

      <div style={{ display: "grid", gap: 12, gridTemplateColumns: "1fr 1fr" }}>
        <label>
          <div style={{ fontSize: 12, opacity: 0.75 }}>供应商类型</div>
          <select
            value={providerType}
            onChange={(e) => setProviderType(e.target.value as ProviderType)}
            style={{ width: "100%", padding: "10px 12px", borderRadius: 10 }}
          >
            {PROVIDER_TYPES.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
          <div style={{ fontSize: 12, opacity: 0.6, marginTop: 6 }}>
            npm: <code>{providerNpm}</code>
          </div>
        </label>

        <div style={{ display: "grid", alignContent: "end" }}>
          {!isNew ? (
            <button
              onClick={deleteProvider}
              disabled={loading || saving}
              style={{ background: "rgba(140,0,0,0.92)" }}
            >
              删除该供应商
            </button>
          ) : (
            <div style={{ fontSize: 12, opacity: 0.65 }}>
              新增供应商：填写完下面信息后点“保存并重载”。
            </div>
          )}
        </div>
      </div>

      <div style={{ display: "grid", gap: 12, gridTemplateColumns: "1fr 1fr" }}>
        <label>
          <div style={{ fontSize: 12, opacity: 0.75 }}>URL（baseURL）</div>
          <input
            value={baseURL}
            onChange={(e) => setBaseURL(e.target.value)}
            placeholder="https://api.xxx.com/v1"
            style={{ width: "100%" }}
          />
        </label>

        <label>
          <div style={{ fontSize: 12, opacity: 0.75 }}>Key（apiKey）</div>
          <input
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={hasApiKey ? "留空=保留已保存 key" : "sk-..."}
            style={{ width: "100%" }}
          />
          {hasApiKey ? (
            <div style={{ fontSize: 12, opacity: 0.6, marginTop: 6 }}>
              当前 provider 已保存 key（不会回显）。不修改就保持留空。
            </div>
          ) : null}
        </label>
      </div>

      <div style={{ display: "grid", gap: 12 }}>
        <div style={{ fontWeight: 700 }}>模型（同名=展示名）</div>

        <div
          style={{
            border: "1px solid rgba(0,0,0,0.12)",
            borderRadius: 12,
            padding: 12,
            background: "rgba(255,255,255,0.65)",
            display: "grid",
            gap: 10,
          }}
        >
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <input
              value={newModelName}
              onChange={(e) => setNewModelName(e.target.value)}
              placeholder="新增 modelName，例如：gpt-4.1-mini"
              style={{ flex: "1 1 320px" }}
            />
            <button onClick={addModel} disabled={!newModelName.trim()}>
              添加模型
            </button>
          </div>

          <div style={{ display: "grid", gap: 8 }}>
            {models.map((m) => (
              <div
                key={m}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 10,
                  border: "1px solid rgba(0,0,0,0.10)",
                  borderRadius: 10,
                  padding: "8px 10px",
                  background: "rgba(255,255,255,0.85)",
                }}
              >
                <div>
                  <code>{m}</code>
                </div>
                <button
                  onClick={() => removeModel(m)}
                  disabled={models.length <= 1}
                  style={{ background: "rgba(140,0,0,0.92)" }}
                >
                  删除
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <button
          onClick={saveAndReload}
          disabled={loading || saving || !providerId || !baseURL || models.length === 0}
        >
          保存并重载
        </button>
        <div style={{ fontSize: 12, opacity: 0.7 }}>
          会更新当前 provider 的配置；不在列表里的模型会被移除。
        </div>
      </div>
    </div>
  );
}
