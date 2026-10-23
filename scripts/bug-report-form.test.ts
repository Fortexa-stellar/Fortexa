import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import yaml from "js-yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const TEMPLATE_PATH = resolve(REPO_ROOT, ".github/ISSUE_TEMPLATE/bug_report.yml");

interface FormField {
  type: string;
  id?: string;
  attributes?: {
    label?: string;
    description?: string;
    value?: string;
    options?: string[];
  };
  validations?: {
    required?: boolean;
  };
}

interface IssueForm {
  name: string;
  description: string;
  title: string;
  labels: string[];
  body: FormField[];
}

describe("Structured bug-report issue form (#358)", () => {
  it("exists at .github/ISSUE_TEMPLATE/bug_report.yml", () => {
    expect(existsSync(TEMPLATE_PATH)).toBe(true);
  });

  it("parses as valid YAML with standard issue form metadata", () => {
    const raw = readFileSync(TEMPLATE_PATH, "utf-8");
    const parsed = yaml.load(raw) as IssueForm;

    expect(parsed).toBeDefined();
    expect(parsed.name).toBe("Bug Report");
    expect(parsed.description).toBeTruthy();
    expect(parsed.title).toContain("[Bug]:");
    expect(parsed.labels).toContain("bug");
    expect(Array.isArray(parsed.body)).toBe(true);
  });

  it("includes a security notice explicitly warning against posting secrets or private keys", () => {
    const raw = readFileSync(TEMPLATE_PATH, "utf-8");
    const parsed = yaml.load(raw) as IssueForm;

    const markdownBlocks = parsed.body.filter((item) => item.type === "markdown");
    expect(markdownBlocks.length).toBeGreaterThan(0);

    const hasSecretWarning = markdownBlocks.some((block) => {
      const val = block.attributes?.value || "";
      return (
        val.toLowerCase().includes("secrets") &&
        val.toLowerCase().includes("private keys")
      );
    });
    expect(hasSecretWarning).toBe(true);
  });

  it("requests reproduction steps as a required field", () => {
    const raw = readFileSync(TEMPLATE_PATH, "utf-8");
    const parsed = yaml.load(raw) as IssueForm;

    const reproField = parsed.body.find(
      (item) => item.id === "reproduction-steps" || item.id === "reproduction"
    );
    expect(reproField).toBeDefined();
    expect(reproField?.type).toBe("textarea");
    expect(reproField?.validations?.required).toBe(true);
  });

  it("requests deployment mode through a structured dropdown", () => {
    const raw = readFileSync(TEMPLATE_PATH, "utf-8");
    const parsed = yaml.load(raw) as IssueForm;

    const deployField = parsed.body.find((item) => item.id === "deployment-mode");
    expect(deployField).toBeDefined();
    expect(deployField?.type).toBe("dropdown");
    expect(deployField?.validations?.required).toBe(true);

    const options = deployField?.attributes?.options || [];
    expect(options.some((opt: string) => opt.toLowerCase().includes("local"))).toBe(true);
    expect(options.some((opt: string) => opt.toLowerCase().includes("vercel"))).toBe(true);
    expect(options.some((opt: string) => opt.toLowerCase().includes("docker") || opt.toLowerCase().includes("standalone"))).toBe(true);
  });

  it("requests targeted Stellar network through a structured dropdown", () => {
    const raw = readFileSync(TEMPLATE_PATH, "utf-8");
    const parsed = yaml.load(raw) as IssueForm;

    const networkField = parsed.body.find((item) => item.id === "network");
    expect(networkField).toBeDefined();
    expect(networkField?.type).toBe("dropdown");
    expect(networkField?.validations?.required).toBe(true);

    const options = networkField?.attributes?.options || [];
    expect(options.some((opt: string) => opt.toLowerCase().includes("testnet"))).toBe(true);
    expect(options.some((opt: string) => opt.toLowerCase().includes("mainnet"))).toBe(true);
  });

  it("provides a dedicated redacted logs input and security confirmation checkbox", () => {
    const raw = readFileSync(TEMPLATE_PATH, "utf-8");
    const parsed = yaml.load(raw) as IssueForm;

    const logField = parsed.body.find((item) => item.id === "redacted-logs");
    expect(logField).toBeDefined();
    expect(logField?.type).toBe("textarea");

    const checkboxField = parsed.body.find((item) => item.id === "security-confirmation");
    expect(checkboxField).toBeDefined();
    expect(checkboxField?.type).toBe("checkboxes");
  });
});
