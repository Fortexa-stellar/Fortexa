import { beforeEach, describe, expect, it, vi } from "vitest";

const { queryMock, endMock, releaseMock, poolCtorMock } = vi.hoisted(() => {
  const query = vi.fn();
  const end = vi.fn().mockResolvedValue(undefined);
  const release = vi.fn();
  const ctor = vi.fn(function MockPool() {
    return {
      query,
      end,
      connect: vi.fn(async () => ({ query, release })),
    };
  });

  return {
    queryMock: query,
    endMock: end,
    releaseMock: release,
    poolCtorMock: ctor,
    releaseMock: release,
  };
});

vi.mock("pg", () => ({
  Pool: poolCtorMock,
}));

import {
  __resetDatabaseForTests,
  DatabaseMigrationError,
  getDatabaseMigrationStatus,
  runWithDatabase,
} from "@/lib/storage/db";

describe("db storage helper", () => {
  beforeEach(async () => {
    queryMock.mockReset();
    endMock.mockClear();
    releaseMock.mockClear();
    poolCtorMock.mockClear();
    delete process.env.DATABASE_URL;
    await __resetDatabaseForTests();
  });

  it("returns unavailable when DATABASE_URL is absent", async () => {
    const result = await runWithDatabase("no-db", async () => "ok");
    expect(result.available).toBe(false);
    expect(poolCtorMock).not.toHaveBeenCalled();
  });

  it("runs migrations before action when DB is configured", async () => {
    process.env.DATABASE_URL = "postgres://fortexa:test@localhost:5432/fortexa";

    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT id") && sql.includes("fortexa_schema_migrations")) {
        return { rows: [] };
      }

      return { rows: [] };
    });

    const result = await runWithDatabase("with-db", async () => 123);

    expect(result.available).toBe(true);
    if (result.available) {
      expect(result.value).toBe(123);
    }

    expect(
      queryMock.mock.calls.some(
        (call) => typeof call[0] === "string" && call[0].includes("fortexa_schema_migrations")
      )
    ).toBe(true);

    expect(
      queryMock.mock.calls.some(
        (call) => typeof call[0] === "string" && call[0].includes("CREATE TABLE IF NOT EXISTS fortexa_wallets")
      )
    ).toBe(true);
    expect(releaseMock).toHaveBeenCalledOnce();
  });

  it("rolls back a failed migration step and does not continue to later migrations", async () => {
    process.env.DATABASE_URL = "postgres://fortexa:test@localhost:5432/fortexa";
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT id") && sql.includes("fortexa_schema_migrations")) {
        return { rows: [] };
      }
      if (sql.includes("ALTER TABLE fortexa_audit_entries")) {
        throw new Error("migration failed");
      }
      return { rows: [] };
    });

    const action = vi.fn(async () => "should not run");
    await expect(runWithDatabase("failed-migration", action)).rejects.toBeInstanceOf(DatabaseMigrationError);

    expect(queryMock).toHaveBeenCalledWith("ROLLBACK");
    expect(queryMock.mock.calls.some(([sql]) => typeof sql === "string" && sql.includes("fortexa_submit_idempotency"))).toBe(false);
    expect(action).not.toHaveBeenCalled();
  });

  it("reports not ready until every code migration is applied", async () => {
    process.env.DATABASE_URL = "postgres://fortexa:test@localhost:5432/fortexa";
    queryMock.mockResolvedValue({ rows: [] });

    const status = await getDatabaseMigrationStatus();

    expect(status).toMatchObject({ configured: true, ready: false, appliedId: null });
    expect(status.expectedId).toBe("005_audit_chain_sequence");
  });
});
