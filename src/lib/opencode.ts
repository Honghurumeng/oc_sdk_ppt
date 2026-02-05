import {
  createOpencode,
  createOpencodeClient,
  type Config,
} from "@opencode-ai/sdk";
import net from "node:net";

const DEFAULT_OPENCODE_HOSTNAME = "127.0.0.1";
const DEFAULT_OPENCODE_PORT = 5937;
const DEFAULT_OPENCODE_PORT_MAX_TRIES = 20;
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

function isFinitePort(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 65535;
}

async function isPortAvailable(hostname: string, port: number): Promise<boolean> {
  // Best-effort probe: bind then immediately close.
  // This avoids relying on SDK error message shape for EADDRINUSE.
  return await new Promise<boolean>((resolve, reject) => {
    const s = net.createServer();
    const cleanup = () => {
      try {
        s.removeAllListeners();
      } catch {
        // ignore
      }
    };

    s.once("error", (err) => {
      cleanup();
      const e = err as NodeJS.ErrnoException;
      if (e?.code === "EADDRINUSE" || e?.code === "EACCES") return resolve(false);
      return reject(err);
    });

    s.listen({ host: hostname, port }, () => {
      s.close(() => {
        cleanup();
        resolve(true);
      });
    });

    // Avoid keeping the process alive due to this probe.
    try {
      s.unref();
    } catch {
      // ignore
    }
  });
}

function isRetryablePortBindFailure(e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  if (/EADDRINUSE/i.test(msg)) return true;
  if (/address already in use/i.test(msg)) return true;
  if (/Failed to start server on port\s+\d+/i.test(msg)) return true;
  if (/Failed to start server on port/i.test(msg)) return true;
  return false;
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

  const hostname = process.env.OPENCODE_HOSTNAME ?? DEFAULT_OPENCODE_HOSTNAME;
  const startPort = process.env.OPENCODE_PORT
    ? Number(process.env.OPENCODE_PORT)
    : DEFAULT_OPENCODE_PORT;
  const timeout = process.env.OPENCODE_START_TIMEOUT_MS
    ? Number(process.env.OPENCODE_START_TIMEOUT_MS)
    : 15000;
  const maxTries = process.env.OPENCODE_PORT_MAX_TRIES
    ? Number(process.env.OPENCODE_PORT_MAX_TRIES)
    : DEFAULT_OPENCODE_PORT_MAX_TRIES;

  if (!isFinitePort(startPort)) {
    return Promise.reject(
      new Error(
        `Invalid OPENCODE_PORT: ${process.env.OPENCODE_PORT ?? "(empty)"}. Expected 1-65535.`
      )
    );
  }

  const tries = Number.isFinite(maxTries) && maxTries > 0 ? Math.floor(maxTries) : 1;

  const startEmbedded = async (): Promise<Omit<OpencodeHandle, "mode">> => {
    let lastErr: unknown = null;
    for (let i = 0; i < tries; i++) {
      const port = startPort + i;
      if (port > 65535) break;

      // Pre-check to avoid spawning when port is clearly taken.
      // Still keep a retry path to handle race conditions.
      try {
        const available = await isPortAvailable(hostname, port);
        if (!available) continue;
      } catch (e) {
        // Probe failed for a non-EADDRINUSE error: treat as config/host problem.
        throw e;
      }

      try {
        const h = (await createOpencode({
          hostname,
          port,
          timeout,
          config,
        })) as unknown as Omit<OpencodeHandle, "mode">;

        // Make the chosen port visible to follow-up reloads/logs.
        process.env.OPENCODE_PORT = String(port);

        if (i > 0) {
          console.info(
            `[opencode] Port ${startPort} is in use; started embedded server on ${port}.`
          );
        }

        return h;
      } catch (e) {
        lastErr = e;
        if (isRetryablePortBindFailure(e)) continue;
        throw e;
      }
    }

    const suffix = lastErr instanceof Error ? ` Last error: ${lastErr.message}` : "";
    throw new Error(
      `Failed to start embedded opencode server: no available port starting at ${startPort} (tries=${tries}).${suffix}`
    );
  };

  return startEmbedded().then((h) => ({
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
