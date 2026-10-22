import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rm } from "node:fs/promises";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";

// Mock ioredis
const mockGet = vi.fn();
const mockSet = vi.fn();
const mockDel = vi.fn();
const mockKeys = vi.fn();
const mockDisconnect = vi.fn();
const mockOn = vi.fn();

let errorCallback: ((err: Error) => void) | null = null;

vi.mock("ioredis", () => {
  class MockRedis {
    get = mockGet;
    set = mockSet;
    del = mockDel;
    keys = mockKeys;
    disconnect = mockDisconnect;
    on = mockOn.mockImplementation((event: string, callback: (err?: Error) => void) => {
      if (event === "error") {
        errorCallback = callback as (err: Error) => void;
      }
    });
  }
  return {
    default: MockRedis,
  };
});

import {
  readSharedRateLimit,
  writeSharedRateLimit,
  clearSharedRateLimits,
  isSharedSecurityStateEnabled,
  resetRedisClient,
} from "./shared-security-state";

const testFilePath = path.join(process.cwd(), ".fortexa", "shared-state-test.json");

describe("shared-security-state with Redis & File Fallback", () => {
  beforeEach(async () => {
    delete process.env.REDIS_URL;
    delete process.env.FORTEXA_SHARED_STATE_PATH;
    await rm(testFilePath, { force: true });
    resetRedisClient();
    vi.clearAllMocks();
    errorCallback = null;
  });

  afterEach(async () => {
    delete process.env.REDIS_URL;
    delete process.env.FORTEXA_SHARED_STATE_PATH;
    await rm(testFilePath, { force: true });
    resetRedisClient();
  });

  it("isSharedSecurityStateEnabled returns true if either REDIS_URL or PATH is set", () => {
    expect(isSharedSecurityStateEnabled()).toBe(false);

    process.env.FORTEXA_SHARED_STATE_PATH = testFilePath;
    expect(isSharedSecurityStateEnabled()).toBe(true);

    delete process.env.FORTEXA_SHARED_STATE_PATH;
    process.env.REDIS_URL = "redis://localhost:6379";
    expect(isSharedSecurityStateEnabled()).toBe(true);
  });

  it("uses Redis when available", async () => {
    process.env.REDIS_URL = "redis://localhost:6379";

    // Test write rate limit
    const val = { count: 5, resetAt: Date.now() + 10000 };
    mockSet.mockResolvedValue("OK");
    await writeSharedRateLimit("test-key", val);

    expect(mockSet).toHaveBeenCalledWith(
      "fortexa:rate-limit:test-key",
      JSON.stringify(val),
      "EX",
      expect.any(Number)
    );

    // Test read rate limit
    mockGet.mockResolvedValue(JSON.stringify(val));
    const result = await readSharedRateLimit("test-key");
    expect(result).toEqual(val);
    expect(mockGet).toHaveBeenCalledWith("fortexa:rate-limit:test-key");

    // Test clear rate limits
    mockKeys.mockResolvedValue(["fortexa:rate-limit:test-key"]);
    mockDel.mockResolvedValue(1);
    await clearSharedRateLimits();
    expect(mockKeys).toHaveBeenCalledWith("fortexa:rate-limit:*");
    expect(mockDel).toHaveBeenCalledWith(["fortexa:rate-limit:test-key"]);
  });

  it("falls back to file store when Redis is unreachable", async () => {
    process.env.REDIS_URL = "redis://localhost:6379";
    process.env.FORTEXA_SHARED_STATE_PATH = testFilePath;

    // Simulate Redis client initialization
    await readSharedRateLimit("test-key"); // this triggers getRedisClient()

    // Trigger connection error callback
    if (errorCallback) {
      errorCallback(new Error("Connection refused"));
    }

    // Now write should fall back to file store
    const val = { count: 3, resetAt: Date.now() + 5000 };
    await writeSharedRateLimit("fallback-key", val);

    // Verify it was written to file instead of throwing
    expect(existsSync(testFilePath)).toBe(true);
    const fileContent = JSON.parse(readFileSync(testFilePath, "utf8"));
    expect(fileContent.rateLimits["fallback-key"]).toEqual(val);

    // Verify read falls back to file store
    const readVal = await readSharedRateLimit("fallback-key");
    expect(readVal).toEqual(val);
  });

  it("falls back to file store when Redis command throws error", async () => {
    process.env.REDIS_URL = "redis://localhost:6379";
    process.env.FORTEXA_SHARED_STATE_PATH = testFilePath;

    // Force mockSet and mockGet to reject/throw
    mockSet.mockRejectedValue(new Error("Redis write timeout"));
    mockGet.mockRejectedValue(new Error("Redis read timeout"));

    // Write should fail in Redis and write to file store instead
    const val = { count: 4, resetAt: Date.now() + 10000 };
    await writeSharedRateLimit("timeout-key", val);

    // Verify write fallback to file store
    expect(existsSync(testFilePath)).toBe(true);
    const fileContent = JSON.parse(readFileSync(testFilePath, "utf8"));
    expect(fileContent.rateLimits["timeout-key"]).toEqual(val);

    // Verify read falls back to file store on Redis error
    const result = await readSharedRateLimit("timeout-key");
    expect(result).toEqual(val);
  });
});
