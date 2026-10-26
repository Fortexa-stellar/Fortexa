import { rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const sharedStatePath = path.join(process.cwd(), ".fortexa", "login-lockout-shared.test.json");

describe("login lockout shared state", () => {
  afterEach(async () => {
    delete process.env.FORTEXA_SHARED_STATE_PATH;
    delete process.env.FORTEXA_AUTH_MAX_ATTEMPTS;
    delete process.env.FORTEXA_AUTH_LOCK_MINUTES;
    await rm(sharedStatePath, { force: true });
    vi.resetModules();
  });

  it("keeps lockout state across module reloads", async () => {
    process.env.FORTEXA_SHARED_STATE_PATH = sharedStatePath;
    process.env.FORTEXA_AUTH_MAX_ATTEMPTS = "2";
    process.env.FORTEXA_AUTH_LOCK_MINUTES = "1";

    const firstModule = await import("@/lib/auth/login-lockout");
    await firstModule.resetLoginLockoutStore();
    await firstModule.registerLoginFailure("operator@fortexa.local", "10.9.0.1");
    await firstModule.registerLoginFailure("operator@fortexa.local", "10.9.0.1");

    expect((await firstModule.isLoginLocked("operator@fortexa.local", "10.9.0.1")).locked).toBe(
      true
    );

    vi.resetModules();

    const secondModule = await import("@/lib/auth/login-lockout");
    const lockState = await secondModule.isLoginLocked("operator@fortexa.local", "10.9.0.1");

    expect(lockState.locked).toBe(true);
    expect(lockState.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("records failures against the user id across wallet addresses", async () => {
    process.env.FORTEXA_SHARED_STATE_PATH = sharedStatePath;
    process.env.FORTEXA_AUTH_MAX_ATTEMPTS = "2";
    process.env.FORTEXA_AUTH_LOCK_MINUTES = "1";

    const lockoutModule = await import("@/lib/auth/login-lockout");
    await lockoutModule.resetLoginLockoutStore();

    await lockoutModule.registerLoginFailure("operator@fortexa.local", "10.9.0.1");
    await lockoutModule.registerLoginFailure("operator@fortexa.local", "10.9.0.2");

    expect((await lockoutModule.isLoginLocked("operator@fortexa.local", "10.9.0.3")).locked).toBe(
      true
    );
  });

  it("clears the lock only after the configured expiry using an injectable clock", async () => {
    process.env.FORTEXA_SHARED_STATE_PATH = sharedStatePath;
    process.env.FORTEXA_AUTH_MAX_ATTEMPTS = "1";
    process.env.FORTEXA_AUTH_LOCK_MINUTES = "1";

    const lockoutModule = await import("@/lib/auth/login-lockout");
    await lockoutModule.resetLoginLockoutStore();

    let now = new Date("2024-01-01T00:00:00Z");
    lockoutModule.setLoginLockoutClock(() => now);

    await lockoutModule.registerLoginFailure("operator@fortexa.local", "10.9.0.1");
    expect((await lockoutModule.isLoginLocked("operator@fortexa.local", "10.9.0.1")).locked).toBe(
      true
    );

    now = new Date("2024-01-01T00:00:30Z");
    expect((await lockoutModule.isLoginLocked("operator@fortexa.local", "10.9.0.1")).locked).toBe(
      true
    );

    now = new Date("2024-01-01T00:01:01Z");
    expect((await lockoutModule.isLoginLocked("operator@fortexa.local", "10.9.0.1")).locked).toBe(
      false
    );
  });
});
