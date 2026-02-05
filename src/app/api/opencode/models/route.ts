import { NextResponse } from "next/server";
import path from "node:path";
import { promises as fs } from "node:fs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ProviderEntry = {
  models?: Record<string, unknown>;
} & Record<string, unknown>;

type OpencodeConfig = {
  provider?: Record<string, ProviderEntry>;
} & Record<string, unknown>;

function configPath() {
  return path.join(process.cwd(), "opencode.json");
}

async function readConfig(): Promise<OpencodeConfig> {
  const raw = await fs.readFile(configPath(), "utf-8");
  return JSON.parse(raw) as OpencodeConfig;
}

export async function GET() {
  try {
    const out: string[] = [];

    // IMPORTANT: 只使用本项目的 opencode.json，不读取全局/内置 provider 列表
    const cfg = await readConfig();
    const providers = cfg.provider ?? {};
    for (const providerId of Object.keys(providers)) {
      const models = providers[providerId]?.models ?? {};
      for (const modelId of Object.keys(models)) {
        out.push(`${providerId}/${modelId}`);
      }
    }
    out.sort((a, b) => a.localeCompare(b));

    return NextResponse.json({ ok: true, models: out });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: `Failed to list models: ${msg}` },
      { status: 500 }
    );
  }
}
