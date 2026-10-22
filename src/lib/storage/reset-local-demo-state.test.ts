import { beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";

// Hoist mocks for pg using constructor-safe functions
const { queryMock, poolCtorMock } = vi.hoisted(() => {
  const query = vi.fn().mockResolvedValue({ rows: [{ count: "5" }] });
  const end = vi.fn().mockResolvedValue(undefined);
  const ctor = vi.fn(function MockPool() {
    return {
      query,
      end,
    };
  });
  return {
    queryMock: query,
    poolCtorMock: ctor,
  };
});

vi.mock("pg", () => ({
  Pool: poolCtorMock,
}));

// Hoist mocks for ioredis using constructor-safe functions
const { redisKeysMock, redisDelMock, redisCtorMock } = vi.hoisted(() => {
  const keys = vi.fn().mockResolvedValue(["fortexa:rate-limit:test"]);
  const del = vi.fn().mockResolvedValue(1);
  const disconnect = vi.fn();
  const ctor = vi.fn(function MockRedis() {
    return {
      keys,
      del,
      disconnect,
    };
  });
  return {
    redisKeysMock: keys,
    redisDelMock: del,
    redisCtorMock: ctor,
  };
});

vi.mock("ioredis", () => ({
  default: redisCtorMock,
}));

// Mock fs promises
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    promises: {
      stat: vi.fn().mockResolvedValue({ size: 123 }),
      unlink: vi.fn().mockResolvedValue(undefined),
    },
  };
});

import {
  runReset,
  isLocalDatabaseUrl,
  isLocalRedisUrl,
} from "../../../scripts/reset-local-demo-state";

describe("Local Demo Reset Safety Helpers", () => {
  describe("isLocalDatabaseUrl", () => {
    it("identifies localhost, 127.0.0.1, ::1 as local", () => {
      expect(isLocalDatabaseUrl("postgres://localhost/db")).toBe(true);
      expect(isLocalDatabaseUrl("postgresql://127.0.0.1:5432/fortexa")).toBe(true);
      expect(isLocalDatabaseUrl("postgres://[::1]:5432/db")).toBe(true);
      expect(isLocalDatabaseUrl("postgres://user:pass@localhost:5432/db")).toBe(true);
      expect(isLocalDatabaseUrl("")).toBe(true);
      expect(isLocalDatabaseUrl(undefined)).toBe(true);
    });

    it("identifies key-value hosts", () => {
      expect(isLocalDatabaseUrl("host=localhost port=5432")).toBe(true);
      expect(isLocalDatabaseUrl("host=127.0.0.1 dbname=test")).toBe(true);
      expect(isLocalDatabaseUrl("dbname=fortexa")).toBe(true);
    });

    it("identifies non-local hosts as unsafe", () => {
      expect(isLocalDatabaseUrl("postgres://evil.com/fortexa")).toBe(false);
      expect(isLocalDatabaseUrl("postgresql://10.0.0.1:5432/db")).toBe(false);
      expect(isLocalDatabaseUrl("host=db.production.fortexa.com")).toBe(false);
    });
  });

  describe("isLocalRedisUrl", () => {
    it("identifies local redis", () => {
      expect(isLocalRedisUrl("redis://localhost:6379")).toBe(true);
      expect(isLocalRedisUrl("redis://127.0.0.1")).toBe(true);
      expect(isLocalRedisUrl("")).toBe(true);
      expect(isLocalRedisUrl(undefined)).toBe(true);
    });

    it("identifies non-local redis", () => {
      expect(isLocalRedisUrl("redis://redis-server.production.local")).toBe(false);
    });
  });
});

describe("runReset script logic", () => {
  let logOutput: string[] = [];
  let errorOutput: string[] = [];

  const mockLog = (msg: string) => {
    logOutput.push(msg);
  };
  const mockError = (msg: string) => {
    errorOutput.push(msg);
  };

  beforeEach(() => {
    logOutput = [];
    errorOutput = [];
    vi.clearAllMocks();
    queryMock.mockResolvedValue({ rows: [{ count: "5" }] });
    redisKeysMock.mockResolvedValue(["fortexa:rate-limit:test"]);
  });

  it("defaults to dry-run mode and performs NO modifications", async () => {
    const result = await runReset({
      dryRun: true,
      log: mockLog,
      errorLog: mockError,
      storeDir: "/mock/store",
    });

    expect(result.success).toBe(false);
    expect(result.refusalReason).toContain("Missing env variable");
    expect(fs.unlink).not.toHaveBeenCalled();

    // Verify it printed target files and DB tables
    const logged = logOutput.join("\n");
    expect(logged).toContain("=== Fortexa Local Demo State Reset (DRY-RUN) ===");
    expect(logged).toContain("[Target Files]");
    expect(logged).toContain("audit.json");
    expect(logged).toContain("policy.json");
  });

  it("refuses to execute if FORTEXA_ALLOW_LOCAL_RESET is missing", async () => {
    const result = await runReset({
      allowLocalReset: false,
      yesFlag: true,
      log: mockLog,
      errorLog: mockError,
      storeDir: "/mock/store",
    });

    expect(result.success).toBe(false);
    expect(result.refusalReason).toContain("FORTEXA_ALLOW_LOCAL_RESET=true");
    expect(fs.unlink).not.toHaveBeenCalled();
  });

  it("refuses to execute if --yes flag is missing", async () => {
    const result = await runReset({
      allowLocalReset: true,
      yesFlag: false,
      log: mockLog,
      errorLog: mockError,
      storeDir: "/mock/store",
    });

    expect(result.success).toBe(false);
    expect(result.refusalReason).toContain("flag --yes");
    expect(fs.unlink).not.toHaveBeenCalled();
  });

  it("refuses to execute against a non-local database host", async () => {
    const result = await runReset({
      allowLocalReset: true,
      yesFlag: true,
      databaseUrl: "postgres://remote-db.production.com:5432/fortexa",
      log: mockLog,
      errorLog: mockError,
      storeDir: "/mock/store",
    });

    expect(result.success).toBe(false);
    expect(result.refusalReason).toContain("non-local database host");
    expect(errorOutput.join("\n")).toContain("REFUSAL: Execution BLOCKED");
    expect(fs.unlink).not.toHaveBeenCalled();
  });

  it("performs full reset when all guardrails are met", async () => {
    const result = await runReset({
      allowLocalReset: true,
      yesFlag: true,
      databaseUrl: "postgres://localhost:5432/fortexa",
      redisUrl: "redis://localhost:6379",
      log: mockLog,
      errorLog: mockError,
      storeDir: "/mock/store",
    });

    expect(result.success).toBe(true);

    // Verify files unlinked
    expect(fs.unlink).toHaveBeenCalledTimes(5);

    // Verify DB pool query executed for table truncates
    expect(queryMock).toHaveBeenCalled();
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining("TRUNCATE TABLE fortexa_wallets")
    );

    // Verify default policy re-seeded
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO fortexa_policy_state"),
      expect.any(Array)
    );

    // Verify Redis keys deleted
    expect(redisKeysMock).toHaveBeenCalledWith("fortexa:*");
    expect(redisDelMock).toHaveBeenCalledWith("fortexa:rate-limit:test");
  });
});
