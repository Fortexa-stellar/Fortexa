import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type StandaloneSmokeOptions = {
  projectRoot?: string;
  host?: string;
  healthTimeoutMs?: number;
  healthPath?: string;
  pollIntervalMs?: number;
  serverShutdownTimeoutMs?: number;
  silent?: boolean;
};

export type StandaloneSmokeResult = {
  ok: boolean;
  port: number;
  healthStatus: number;
  durationMs: number;
  serverPid?: number;
};

/**
 * Finds an available ephemeral port assigned by the OS.
 */
export async function getEphemeralPort(host = "127.0.0.1"): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.unref();

    server.on("error", reject);

    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Unable to obtain server port")));
        return;
      }
      const port = address.port;
      server.close((closeErr) => {
        if (closeErr) reject(closeErr);
        else resolve(port);
      });
    });
  });
}

/**
 * Resolves the location of Next.js standalone server.js.
 */
export function getStandaloneServerPath(projectRoot?: string): string {
  const root = projectRoot ?? process.cwd();
  const directPath = path.join(root, ".next", "standalone", "server.js");
  if (existsSync(directPath)) {
    return directPath;
  }

  // Next.js may nest standalone files under project directory basename in monorepos
  const nestedPath = path.join(root, ".next", "standalone", path.basename(root), "server.js");
  if (existsSync(nestedPath)) {
    return nestedPath;
  }

  return directPath;
}

/**
 * Polls the health endpoint until it responds or times out.
 */
export async function waitForHealth(
  healthUrl: string,
  options?: { timeoutMs?: number; pollIntervalMs?: number },
): Promise<{ ok: boolean; status: number; body?: unknown }> {
  const timeoutMs = options?.timeoutMs ?? 30_000;
  const pollIntervalMs = options?.pollIntervalMs ?? 250;
  const startTime = Date.now();

  let lastError: Error | null = null;

  while (Date.now() - startTime < timeoutMs) {
    try {
      const response = await fetch(healthUrl, {
        method: "GET",
        headers: { Accept: "application/json" },
      });

      // Health endpoint may return 200 (healthy) or 503 (readiness check failing in bare dev environment)
      // Both prove that Next.js standalone server successfully booted, routed, and executed the handler.
      const status = response.status;
      const body = await response.json().catch(() => undefined);

      if (status === 200 || status === 503) {
        return { ok: true, status, body };
      }
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }

    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  throw new Error(
    `Standalone server health check timed out after ${timeoutMs}ms at ${healthUrl}. Last error: ${lastError?.message ?? "none"}`,
  );
}

/**
 * Cleanly terminates a child server process with SIGTERM (fallback to SIGKILL).
 */
export async function stopServerProcess(
  child: ChildProcess,
  timeoutMs = 5000,
): Promise<void> {
  if (child.exitCode !== null || child.killed) {
    return;
  }

  return new Promise<void>((resolve) => {
    let resolved = false;

    const cleanup = () => {
      if (!resolved) {
        resolved = true;
        resolve();
      }
    };

    child.once("exit", cleanup);
    child.once("close", cleanup);

    // Send SIGTERM
    try {
      child.kill("SIGTERM");
    } catch {
      cleanup();
      return;
    }

    // Force kill if process does not exit in time
    const killTimer = setTimeout(() => {
      try {
        if (child.exitCode === null) {
          child.kill("SIGKILL");
        }
      } catch {
        // Ignore errors on force-kill
      }
      cleanup();
    }, timeoutMs);

    killTimer.unref();
  });
}

/**
 * Runs the complete standalone server startup smoke test.
 */
export async function runStandaloneSmokeTest(
  options?: StandaloneSmokeOptions,
): Promise<StandaloneSmokeResult> {
  const root = options?.projectRoot ?? process.cwd();
  const host = options?.host ?? "127.0.0.1";
  const healthPath = options?.healthPath ?? "/api/health";
  const healthTimeoutMs = options?.healthTimeoutMs ?? 30_000;
  const pollIntervalMs = options?.pollIntervalMs ?? 250;
  const serverShutdownTimeoutMs = options?.serverShutdownTimeoutMs ?? 5000;
  const silent = options?.silent ?? false;

  const log = (msg: string) => {
    if (!silent) {
      console.log(`[standalone-smoke] ${msg}`);
    }
  };

  const serverPath = getStandaloneServerPath(root);

  if (!existsSync(serverPath)) {
    throw new Error(
      `Standalone server output not found at "${serverPath}". Ensure "next build" with output: "standalone" has been executed first.`,
    );
  }

  const port = await getEphemeralPort(host);
  log(`Acquired ephemeral port: ${port}`);

  log(`Spawning standalone server: ${serverPath}`);
  const startTime = Date.now();

  const child = spawn(process.execPath, [serverPath], {
    cwd: path.dirname(serverPath),
    env: {
      ...process.env,
      PORT: String(port),
      HOSTNAME: host,
      NODE_ENV: "production",
      // Disable unnecessary database attempts during startup smoke test if unconfigured
      FORTEXA_AUTH_SECRET: process.env.FORTEXA_AUTH_SECRET || "standalone-smoke-test-secret-32-chars-long",
      FORTEXA_BLOCKLIST_URL: process.env.FORTEXA_BLOCKLIST_URL || "https://blocklist.fortexa.internal/api/v1/addresses",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const pid = child.pid;
  log(`Standalone server started (PID: ${pid})`);

  let stdoutData = "";
  let stderrData = "";

  child.stdout?.on("data", (chunk: Buffer) => {
    stdoutData += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrData += chunk.toString();
  });

  let earlyExitError: Error | null = null;
  child.once("exit", (code, signal) => {
    earlyExitError = new Error(
      `Standalone server process exited prematurely with code ${code} and signal ${signal}.\nStderr: ${stderrData}\nStdout: ${stdoutData}`,
    );
  });

  try {
    const healthUrl = `http://${host}:${port}${healthPath}`;
    log(`Polling health check at: ${healthUrl}`);

    // Check if process crashed immediately
    if (earlyExitError) {
      throw earlyExitError;
    }

    const health = await waitForHealth(healthUrl, {
      timeoutMs: healthTimeoutMs,
      pollIntervalMs,
    });

    const durationMs = Date.now() - startTime;
    log(`Health check responded with HTTP ${health.status} in ${durationMs}ms`);

    return {
      ok: true,
      port,
      healthStatus: health.status,
      durationMs,
      serverPid: pid,
    };
  } finally {
    log(`Stopping standalone server (PID: ${pid})...`);
    await stopServerProcess(child, serverShutdownTimeoutMs);
    log("Server stopped cleanly.");
  }
}

// CLI runner when executed directly via `tsx scripts/smoke-standalone.ts`
const isMain =
  typeof process !== "undefined" &&
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  runStandaloneSmokeTest()
    .then((result) => {
      console.log(
        `✅ Standalone smoke test passed successfully (Port: ${result.port}, Status: ${result.healthStatus}, Duration: ${result.durationMs}ms)`,
      );
      process.exit(0);
    })
    .catch((err) => {
      console.error(`❌ Standalone smoke test failed:`, err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
