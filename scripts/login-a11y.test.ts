import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("login accessibility smoke test (issue #359)", () => {
  const rootDir = path.resolve(__dirname, "..");
  const loginFormPath = path.join(rootDir, "src/components/login-form.tsx");
  const loginPagePath = path.join(rootDir, "src/app/login/page.tsx");

  it("ensures login-form.tsx exists and is a client component", () => {
    expect(fs.existsSync(loginFormPath)).toBe(true);
    const content = fs.readFileSync(loginFormPath, "utf-8");

    expect(content).toContain('"use client"');
    expect(content).toContain("export function LoginForm");
  });

  describe("Labels & Landmark Accessibility", () => {
    it("ensures card container establishes an accessible region labeled by card title", () => {
      const content = fs.readFileSync(loginFormPath, "utf-8");

      expect(content).toContain('role="region"');
      expect(content).toContain('aria-labelledby="login-title"');
      expect(content).toContain('id="login-title"');
      expect(content).toContain("Sign in with Freighter");
    });

    it("ensures the form element has an explicit accessible label", () => {
      const content = fs.readFileSync(loginFormPath, "utf-8");

      expect(content).toContain('aria-label="Wallet sign-in form"');
    });

    it("ensures external helper links provide accessible link names for screen readers", () => {
      const content = fs.readFileSync(loginFormPath, "utf-8");

      expect(content).toContain(
        'aria-label="Get Freighter browser extension (opens in new tab)"',
      );
      expect(content).toContain('target="_blank"');
      expect(content).toContain('rel="noreferrer"');
    });
  });

  describe("Error Association Semantics", () => {
    it("ensures error alert exposes an assertive live region for immediate screen reader announcement", () => {
      const content = fs.readFileSync(loginFormPath, "utf-8");

      expect(content).toContain('role="alert"');
      expect(content).toContain('aria-live="assertive"');
      expect(content).toContain('id="login-error-alert"');
      expect(content).toContain(
        "<AlertTitle>Authentication error</AlertTitle>",
      );
    });

    it("ensures submit button links to the active error via aria-describedby", () => {
      const content = fs.readFileSync(loginFormPath, "utf-8");

      expect(content).toContain(
        'aria-describedby={error ? "login-error-alert" : undefined}',
      );
    });
  });

  describe("Focus Order & Decorative Icon Exclusion", () => {
    it("ensures decorative icons are hidden from assistive technology via aria-hidden", () => {
      const content = fs.readFileSync(loginFormPath, "utf-8");

      expect(content).toContain('<Loader2 aria-hidden="true"');
      expect(content).toContain('<Wallet aria-hidden="true"');
      expect(content).toContain('<ExternalLink aria-hidden="true"');
    });

    it("ensures logical DOM tab sequence flows from primary action to extension help link", () => {
      const content = fs.readFileSync(loginFormPath, "utf-8");

      const buttonIndex = content.indexOf("<Button");
      const linkIndex = content.indexOf('href="https://www.freighter.app/"');

      expect(buttonIndex).toBeGreaterThan(-1);
      expect(linkIndex).toBeGreaterThan(buttonIndex);
    });

    it("ensures login page establishes main landmark structure", () => {
      expect(fs.existsSync(loginPagePath)).toBe(true);
      const pageContent = fs.readFileSync(loginPagePath, "utf-8");

      expect(pageContent).toContain("<main");
      expect(pageContent).toContain("</main>");
      expect(pageContent).toContain("<h1");
      expect(pageContent).toContain("Sign in with your Stellar wallet");
    });
  });

  describe("Button Names & State Announcements", () => {
    it("ensures button defines an accessible name in default and loading states", () => {
      const content = fs.readFileSync(loginFormPath, "utf-8");

      expect(content).toContain("aria-label=");
      expect(content).toContain('"Sign in with Freighter"');
      expect(content).toContain("loginStepLabel(loginStep)");
    });

    it("ensures button exposes aria-busy and aria-disabled matching the loading state", () => {
      const content = fs.readFileSync(loginFormPath, "utf-8");

      expect(content).toContain("disabled={loading}");
      expect(content).toContain("aria-disabled={loading}");
      expect(content).toContain("aria-busy={loading}");
    });

    it("ensures redirection and success state provides a polite live announcement", () => {
      const content = fs.readFileSync(loginFormPath, "utf-8");

      expect(content).toMatch(/role="status"\s+aria-live="polite"/);
      expect(content).toContain("· redirecting");
    });
  });
});
