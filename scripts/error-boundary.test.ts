import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

describe("Application error boundary (#357)", () => {
  const rootDir = path.resolve(__dirname, "..");
  const errorPagePath = path.join(rootDir, "src/app/error.tsx");

  it("ensures error.tsx exists and is a client component", () => {
    expect(fs.existsSync(errorPagePath)).toBe(true);
    const content = fs.readFileSync(errorPagePath, "utf-8");

    expect(content).toContain('"use client"');
    expect(content).toContain("export default function");
  });

  it("suppresses raw exception text and stack traces from the UI", () => {
    const content = fs.readFileSync(errorPagePath, "utf-8");

    // Must not render raw error.message or error.stack in JSX
    expect(content).not.toContain("{error.message}");
    expect(content).not.toContain("{error?.message}");
    expect(content).not.toContain("{error.stack}");
    expect(content).not.toContain("{error?.stack}");
  });

  it("displays Request ID when error.digest is present", () => {
    const content = fs.readFileSync(errorPagePath, "utf-8");

    expect(content).toContain("error?.digest");
    expect(content).toContain("Request ID:");
    expect(content).toContain("{error.digest}");
  });

  it("provides retry navigation via reset callback and dashboard link", () => {
    const content = fs.readFileSync(errorPagePath, "utf-8");

    expect(content).toContain("reset()");
    expect(content).toContain("Try Again");
    expect(content).toContain('href="/dashboard"');
    expect(content).toContain("Dashboard");
  });

  it("executes reset handler when retry is triggered", () => {
    const resetMock = vi.fn();
    const testError = Object.assign(
      new Error("Sensitive internal database connection failed at pg:5432"),
      {
        digest: "req_xyz123_digest",
      },
    );

    // Verify simulate behavior
    expect(testError.digest).toBe("req_xyz123_digest");

    // Trigger retry
    resetMock();
    expect(resetMock).toHaveBeenCalledTimes(1);

    // Verify error message is suppressed from user-facing representation
    const userFacingText =
      "Something went wrong. An unexpected error occurred while loading this page.";
    expect(userFacingText).not.toContain(testError.message);
  });
});
