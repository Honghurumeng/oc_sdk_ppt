import { NextResponse } from "next/server";
import path from "node:path";
import { promises as fs } from "node:fs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PROVIDER_TYPE_TO_NPM: Record<string, string> = {
  "openai-compatible": "@ai-sdk/openai-compatible",
  openai: "@ai-sdk/openai",
  google: "@ai-sdk/google",
  anthropic: "@ai-sdk/anthropic",
};

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

function configPath() {
  return path.join(process.cwd(), "opencode.json");
}

function redact(cfg: OpencodeConfig) {
  const out: OpencodeConfig = JSON.parse(JSON.stringify(cfg ?? {}));
  const p = out.provider ?? {};
  for (const k of Object.keys(p)) {
    const entry = p[k];
    if (entry?.options && typeof entry.options === "object") {
      if (typeof entry.options.apiKey === "string" && entry.options.apiKey.length > 0) {
        entry.options.apiKey = "********";
      }
    }
  }
  return out;
}

function buildMeta(cfg: OpencodeConfig) {
  const meta: Record<string, { hasApiKey: boolean }> = {};
  const p = cfg.provider ?? {};
  for (const k of Object.keys(p)) {
    const entry = p[k];
    const apiKey = entry?.options?.apiKey;
    meta[k] = { hasApiKey: typeof apiKey === "string" && apiKey.trim().length > 0 };
  }
  return { providers: meta };
}

async function readConfig(): Promise<OpencodeConfig> {
  const p = configPath();
  const raw = await fs.readFile(p, "utf-8");
  return JSON.parse(raw) as OpencodeConfig;
}

function asString(v: unknown) {
  return typeof v === "string" ? v : null;
}

export async function GET() {
  try {
    const cfg = await readConfig();
    return NextResponse.json({
      ok: true,
      config: redact(cfg),
      meta: buildMeta(cfg),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: `Failed to read opencode.json: ${msg}` },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }

  const obj = (typeof body === "object" && body !== null ? body : {}) as Record<
    string,
    unknown
  >;

  const action = asString(obj.action) ?? "upsertProvider";

  const p = configPath();
  const backup = `${p}.bak`;

  // 读现有配置（尽量保留未知字段）
  let curCfg: OpencodeConfig = {
    $schema: "https://opencode.ai/config.json",
    provider: {},
  };
  try {
    curCfg = await readConfig();
  } catch {
    // ignore
  }

  if (typeof curCfg.$schema !== "string") {
    curCfg.$schema = "https://opencode.ai/config.json";
  }
  if (!curCfg.provider || typeof curCfg.provider !== "object") {
    curCfg.provider = {};
  }

  if (action === "deleteProvider") {
    const providerId = asString(obj.providerId);
    if (!providerId) {
      return NextResponse.json(
        { ok: false, error: "providerId is required" },
        { status: 400 }
      );
    }

    const next = JSON.parse(JSON.stringify(curCfg)) as OpencodeConfig;
    if (next.provider) delete next.provider[providerId];

    // 如果默认 model 指向该 provider，则清空
    if (typeof next.model === "string" && next.model.startsWith(`${providerId}/`)) {
      delete next.model;
    }

    try {
      try {
        await fs.copyFile(p, backup);
      } catch {
        // ignore
      }
      await fs.writeFile(p, JSON.stringify(next, null, 2) + "\n", "utf-8");
      return NextResponse.json({ ok: true, config: redact(next), meta: buildMeta(next) });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return NextResponse.json(
        { ok: false, error: `Failed to write opencode.json: ${msg}` },
        { status: 500 }
      );
    }
  }

  if (action !== "upsertProvider") {
    return NextResponse.json(
      { ok: false, error: `Unknown action: ${action}` },
      { status: 400 }
    );
  }

  const providerType = asString(obj.providerType);
  const providerId = asString(obj.providerId);
  const baseURL = asString(obj.baseURL);
  const apiKeyRaw = asString(obj.apiKey);

  const modelsRaw = obj.models;
  const models: string[] = Array.isArray(modelsRaw)
    ? modelsRaw
        .map((x) => (typeof x === "string" ? x.trim() : ""))
        .filter((x) => x.length > 0)
    : [];

  const npm = providerType ? PROVIDER_TYPE_TO_NPM[providerType] : null;
  if (!providerType || !npm) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "Invalid providerType. Use one of: openai-compatible, openai, google, anthropic",
      },
      { status: 400 }
    );
  }

  if (!providerId || providerId.trim().length === 0) {
    return NextResponse.json(
      { ok: false, error: "providerId is required" },
      { status: 400 }
    );
  }

  if (!baseURL || baseURL.trim().length === 0) {
    return NextResponse.json(
      { ok: false, error: "baseURL is required" },
      { status: 400 }
    );
  }

  if (models.length === 0) {
    return NextResponse.json(
      { ok: false, error: "At least one model is required" },
      { status: 400 }
    );
  }

  const apiKey = apiKeyRaw && apiKeyRaw.trim().length > 0 ? apiKeyRaw.trim() : null;

  const next = JSON.parse(JSON.stringify(curCfg)) as OpencodeConfig;
  if (!next.provider) next.provider = {};

  const prevEntry = next.provider[providerId] ?? {};
  const cleanedPrevEntry: Record<string, unknown> =
    prevEntry && typeof prevEntry === "object"
      ? { ...(prevEntry as Record<string, unknown>) }
      : {};
  // 不设置展示名，统一使用 providerId
  delete cleanedPrevEntry.name;
  const prevOptions =
    prevEntry.options && typeof prevEntry.options === "object" ? prevEntry.options : {};

  const nextOptions: Record<string, unknown> = {
    ...prevOptions,
    baseURL: baseURL.trim(),
  };

  // apiKey 没传：保留旧值；传空字符串不会覆盖（前端用“留空=保留”）
  if (apiKey) nextOptions.apiKey = apiKey;

  const nextModels: Record<string, { name?: string }> = {};
  for (const m of models) {
    nextModels[m] = { name: m };
  }

  next.provider[providerId] = {
    ...cleanedPrevEntry,
    npm,
    options: nextOptions,
    models: nextModels,
  };

  // 不在配置里设置默认模型；由业务（PPT 表单）在每次调用时指定。

  try {
    // 备份
    try {
      await fs.copyFile(p, backup);
    } catch {
      // ignore
    }

    await fs.writeFile(p, JSON.stringify(next, null, 2) + "\n", "utf-8");
    return NextResponse.json({ ok: true, config: redact(next), meta: buildMeta(next) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: `Failed to write opencode.json: ${msg}` },
      { status: 500 }
    );
  }
}
