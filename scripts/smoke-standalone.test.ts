import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  getEphemeralPort,
  getStandaloneServerPath,
  waitForHealth,
  stopServerProcess,
  runStandaloneSmokeTest,
} from "./smoke-standalone";

describe("smoke-standalone", () => {
  describe("getEphemeralPort", () => {
    it("allocates a valid non-privileged ephemeral port", async () => {
      const port = await getEphemeralPort();
      expect(typeof port).toBe("number");
      expect(port).toBeGreaterThan(1024);
      expect(port).toBeLessThanOrEqual(65535);
    });

    it("allocates ports that are immediately bindable", async () => {
      const port = await getEphemeralPort();
      const server = http.createServer((_req, res) => {
        res.writeHead(200);
        res.end("ok");
      });

      await new Promise<void>((resolve, reject) => {
        server.listen(port, "127.0.0.1", () => resolve());
        server.on("error", reject);
      });

      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    });
  });

  describe("getStandaloneServerPath", () => {
    it("resolves the standard standalone server path", () => {
      const fakeRoot = path.join("test-root", "app");
      const resolved = getStandaloneServerPath(fakeRoot);
      expect(resolved).toBe(path.join(fakeRoot, ".next", "standalone", "server.js"));
    });
  });

  describe("waitForHealth", () => {
    it("succeeds when the target health endpoint returns 200", async () => {
      const server = http.createServer((req, res) => {
        if (req.url === "/api/health") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "healthy" }));
        } else {
          res.writeHead(404);
          res.end();
        }
      });

      const port = await new Promise<number>((resolve) => {
        server.listen(0, "127.0.0.1", () => {
          const addr = server.address();
          resolve(typeof addr === "object" && addr ? addr.port : 0);
        });
      });

      try {
        const result = await waitForHealth(`http://127.0.0.1:${port}/api/health`, {
          timeoutMs: 3000,
          pollIntervalMs: 50,
        });
        expect(result.ok).toBe(true);
        expect(result.status).toBe(200);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it("accepts HTTP 503 response as server readiness indication", async () => {
      const server = http.createServer((req, res) => {
        if (req.url === "/api/health") {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "degraded" }));
        } else {
          res.writeHead(404);
          res.end();
        }
      });

      const port = await new Promise<number>((resolve) => {
        server.listen(0, "127.0.0.1", () => {
          const addr = server.address();
          resolve(typeof addr === "object" && addr ? addr.port : 0);
        });
      });

      try {
        const result = await waitForHealth(`http://127.0.0.1:${port}/api/health`, {
          timeoutMs: 3000,
          pollIntervalMs: 50,
        });
        expect(result.ok).toBe(true);
        expect(result.status).toBe(503);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it("times out if server is unreachable", async () => {
      const port = await getEphemeralPort();
      await expect(
        waitForHealth(`http://127.0.0.1:${port}/api/health`, {
          timeoutMs: 300,
          pollIntervalMs: 50,
        }),
      ).rejects.toThrow(/timed out/i);
    });
  });

  describe("stopServerProcess", () => {
    it("cleanly terminates a child process", async () => {
      // Spawn a simple long-running node process
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
      expect(child.pid).toBeDefined();

      await stopServerProcess(child, 2000);
      expect(child.killed || child.exitCode !== null).toBe(true);
    });

    it("safely handles an already exited child process", async () => {
      const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
      await new Promise<void>((resolve) => child.on("exit", () => resolve()));

      // Calling stop on exited process must resolve without error
      await expect(stopServerProcess(child, 1000)).resolves.toBeUndefined();
    });
  });

  describe("runStandaloneSmokeTest", () => {
    it("throws if standalone server output does not exist", async () => {
      await expect(
        runStandaloneSmokeTest({
          projectRoot: "/path/that/does/not/exist",
          silent: true,
        }),
      ).rejects.toThrow(/Standalone server output not found/i);
    });
  });
});
