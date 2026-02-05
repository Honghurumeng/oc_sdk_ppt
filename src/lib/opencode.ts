import {
  createOpencode,
  createOpencodeClient,
  type Config,
} from "@opencode-ai/sdk";

type OpencodeClient = ReturnType<typeof createOpencodeClient>;

type OpencodeHandle = {
  client: OpencodeClient;
  server?: { url: string; close: () => void };
  mode: "embedded" | "remote";
};

declare global {
  var __opencodeHandle: Promise<OpencodeHandle> | undefined;
}

function makeHandle(): Promise<OpencodeHandle> {
  const baseUrl = process.env.OPENCODE_BASE_URL;
  if (baseUrl) {
    const client = createOpencodeClient({ baseUrl });
    return Promise.resolve({ client, mode: "remote" });
  }

  const config: Config = {};
  return (createOpencode({
    hostname: process.env.OPENCODE_HOSTNAME ?? "127.0.0.1",
    port: process.env.OPENCODE_PORT ? Number(process.env.OPENCODE_PORT) : 4096,
    timeout: process.env.OPENCODE_START_TIMEOUT_MS
      ? Number(process.env.OPENCODE_START_TIMEOUT_MS)
      : 15000,
    config,
  }) as unknown as Promise<Omit<OpencodeHandle, "mode">>).then((h) => ({
    ...h,
    mode: "embedded" as const,
  }));
}

export function getOpencodeHandle() {
  if (!globalThis.__opencodeHandle) {
    globalThis.__opencodeHandle = makeHandle();
  }
  return globalThis.__opencodeHandle;
}

export async function reloadOpencodeHandle() {
  const cur = globalThis.__opencodeHandle
    ? await globalThis.__opencodeHandle
    : null;

  if (cur?.mode === "remote") {
    return {
      ok: false,
      reason: "OPENCODE_BASE_URL is set; cannot reload remote server config.",
    };
  }

  if (cur?.server) {
    try {
      cur.server.close();
    } catch {
      // ignore
    }
  }

  globalThis.__opencodeHandle = makeHandle();
  await globalThis.__opencodeHandle;
  return { ok: true };
}

export function unwrapData<T>(res: unknown): T {
  const obj = typeof res === "object" && res !== null ? (res as Record<string, unknown>) : null;
  if (obj && "data" in obj) return obj.data as T;
  return res as T;
}
