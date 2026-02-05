import {
  createOpencode,
  createOpencodeClient,
  type Config,
} from "@opencode-ai/sdk";

const DEFAULT_OPENCODE_HOSTNAME = "127.0.0.1";
const DEFAULT_OPENCODE_PORT = 5937;
// Used to secure the embedded opencode server when OPENCODE_SERVER_PASSWORD is not set.
const DEFAULT_OPENCODE_SERVER_PASSWORD = "oc-ppt-agent";

function makeOpencodeAuthHeader(password: string) {
  // opencode server uses HTTP Basic auth with fixed username "opencode".
  const token = Buffer.from(`opencode:${password}`, "utf-8").toString("base64");
  return `Basic ${token}`;
}

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
  const serverPassword =
    process.env.OPENCODE_SERVER_PASSWORD ?? DEFAULT_OPENCODE_SERVER_PASSWORD;

  const authHeader = serverPassword
    ? { Authorization: makeOpencodeAuthHeader(serverPassword) }
    : undefined;

  if (baseUrl) {
    const client = createOpencodeClient({
      baseUrl,
      headers: authHeader,
      throwOnError: true,
    });
    return Promise.resolve({ client, mode: "remote" });
  }

  // Ensure the spawned server process sees a password even when the user
  // doesn't provide OPENCODE_SERVER_PASSWORD.
  if (!process.env.OPENCODE_SERVER_PASSWORD) {
    process.env.OPENCODE_SERVER_PASSWORD = serverPassword;
  }

  const config: Config = {};
  return (createOpencode({
    hostname: process.env.OPENCODE_HOSTNAME ?? DEFAULT_OPENCODE_HOSTNAME,
    port: process.env.OPENCODE_PORT
      ? Number(process.env.OPENCODE_PORT)
      : DEFAULT_OPENCODE_PORT,
    timeout: process.env.OPENCODE_START_TIMEOUT_MS
      ? Number(process.env.OPENCODE_START_TIMEOUT_MS)
      : 15000,
    config,
  }) as unknown as Promise<Omit<OpencodeHandle, "mode">>).then((h) => ({
    ...h,
    // Use a client instance that always carries the password header.
    client: createOpencodeClient({
      baseUrl: h.server!.url,
      headers: authHeader,
      throwOnError: true,
    }),
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
