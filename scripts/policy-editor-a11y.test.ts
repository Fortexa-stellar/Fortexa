import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("policy editor accessibility smoke test (issue #361)", () => {
  const rootDir = path.resolve(__dirname, "..");
  const policyEditorPath = path.join(
    rootDir,
    "src/components/policy-editor.tsx",
  );

  it("ensures policy-editor.tsx exists and is a client component", () => {
    expect(fs.existsSync(policyEditorPath)).toBe(true);
    const content = fs.readFileSync(policyEditorPath, "utf-8");

    expect(content).toContain('"use client"');
    expect(content).toContain("export function PolicyEditor");
  });

  describe("Default state accessibility assertions", () => {
    it("ensures all numeric rule inputs have accessible names via aria-label", () => {
      const content = fs.readFileSync(policyEditorPath, "utf-8");

      expect(content).toContain('aria-label="Per-transaction cap"');
      expect(content).toContain('aria-label="Daily spending cap"');
      expect(content).toContain('aria-label="Max tool calls per day"');
      expect(content).toContain('aria-label="Risk score threshold"');
    });

    it("ensures all list textareas for domains and tools have accessible names via aria-label", () => {
      const content = fs.readFileSync(policyEditorPath, "utf-8");

      expect(content).toContain('aria-label="Allowed domains"');
      expect(content).toContain('aria-label="Blocked domains"');
      expect(content).toContain('aria-label="Allowed tools"');
      expect(content).toContain('aria-label="Blocked tools"');
    });

    it("ensures action buttons have accessible names and labels", () => {
      const content = fs.readFileSync(policyEditorPath, "utf-8");

      expect(content).toContain('aria-label="Save Policy"');
      expect(content).toContain('aria-label="Reload policy"');
      expect(content).toContain('aria-label="Reload policy history"');
      expect(content).toContain('aria-label="Run simulation"');
    });

    it("ensures policy status updates use polite live regions", () => {
      const content = fs.readFileSync(policyEditorPath, "utf-8");

      expect(content).toContain("<AlertTitle>Policy status</AlertTitle>");
      expect(content).toMatch(
        /role="status"\s+aria-live="polite"[^>]*>[\s\S]*?<AlertTitle>Policy status<\/AlertTitle>/,
      );
    });
  });

  describe("Validation-error state accessibility assertions", () => {
    it("ensures validation failure alert uses assertive role='alert' live region", () => {
      const content = fs.readFileSync(policyEditorPath, "utf-8");

      expect(content).toMatch(
        /validationGate\.status === "invalid"[\s\S]*?role="alert"\s+aria-live="assertive"/,
      );
      expect(content).toContain("Validation failed — activation is disabled");
    });

    it("ensures validation error listings provide an accessible labeled list", () => {
      const content = fs.readFileSync(policyEditorPath, "utf-8");

      expect(content).toContain('aria-label="Validation error list"');
    });

    it("ensures valid state draft confirmation uses polite status announcement", () => {
      const content = fs.readFileSync(policyEditorPath, "utf-8");

      expect(content).toMatch(
        /validationGate\.status === "valid"[\s\S]*?role="status"\s+aria-live="polite"/,
      );
      expect(content).toContain("Draft validated");
    });

    it("ensures save conflict error alert uses assertive role='alert'", () => {
      const content = fs.readFileSync(policyEditorPath, "utf-8");

      expect(content).toMatch(
        /\{conflict \? \([\s\S]*?role="alert"\s+aria-live="assertive"/,
      );
      expect(content).toContain(
        "Save conflict — another operator edited this policy",
      );
    });
  });

  describe("Disabled states accessibility assertions", () => {
    it("ensures viewer mode alert informs assistive technology politely", () => {
      const content = fs.readFileSync(policyEditorPath, "utf-8");

      expect(content).toMatch(
        /!sessionLoading && !isOperator[\s\S]*?role="status"\s+aria-live="polite"/,
      );
      expect(content).toContain("Viewer mode");
      expect(content).toContain(
        "Policy editing is disabled. Only operator role can update policy.",
      );
    });

    it("ensures network mismatch and sensitive payload alert uses assertive role='alert'", () => {
      const content = fs.readFileSync(policyEditorPath, "utf-8");

      expect(content).toMatch(
        /networkMismatch \|\| sensitivePayload[\s\S]*?role="alert"\s+aria-live="assertive"/,
      );
      expect(content).toContain("Saving disabled");
    });

    it("ensures form inputs expose aria-disabled matching disabled write state", () => {
      const content = fs.readFileSync(policyEditorPath, "utf-8");

      // Inputs bind both disabled and aria-disabled to writeDisabled
      expect(content).toContain("aria-disabled={writeDisabled}");
      expect(content).toContain("disabled={writeDisabled}");
    });

    it("ensures save and simulation buttons expose aria-disabled when actions are disabled", () => {
      const content = fs.readFileSync(policyEditorPath, "utf-8");

      expect(content).toContain("aria-disabled={saveDisabled}");
      expect(content).toContain("disabled={saveDisabled}");
      expect(content).toContain("aria-disabled={writeDisabled || simulating}");
      expect(content).toContain("disabled={writeDisabled || simulating}");
    });
  });
});
