import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * GitHub keeps actions/upload-artifact output for this many days.
 * Seven days covers inspection of a failed run through the following
 * release week, then the diagnostic logs and reports are deleted.
 */
const DIAGNOSTIC_ARTIFACT_RETENTION_DAYS = 7;

const UPLOAD_ARTIFACT = /^actions\/upload-artifact(@|$)/;

type UploadArtifactStep = {
  line: number;
  retentionDays: number | null;
};

function leadingIndent(line: string): number {
  const match = /^(\s*)/.exec(line);
  return match ? match[1].length : 0;
}

function stripInlineComment(line: string): string {
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote && line[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "#") return line.slice(0, i);
  }
  return line;
}

function isCommentOrEmpty(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.length === 0 || trimmed.startsWith("#");
}

function unquote(value: string): string {
  if (
    (value.startsWith("'") && value.endsWith("'")) ||
    (value.startsWith('"') && value.endsWith('"'))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

type StepBlock = { line: number; text: string[] };

function splitSteps(source: string): StepBlock[] {
  const lines = source.split(/\r?\n/);
  const steps: StepBlock[] = [];
  let current: StepBlock | null = null;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const match = /^(\s*)-\s+\S/.exec(line);
    if (match) {
      const indent = match[1].length;
      if (current && indent > leadingIndent(current.text[0])) {
        current.text.push(line);
        continue;
      }
      current = { line: index + 1, text: [line] };
      steps.push(current);
      continue;
    }
    if (current) current.text.push(line);
  }

  return steps;
}

function mappingKeys(stepLines: string[]): { key: string; value: string }[] {
  const keys: { key: string; value: string }[] = [];
  let blockFloor = -1;

  for (const raw of stepLines) {
    if (isCommentOrEmpty(raw)) continue;
    const indent = leadingIndent(raw);
    if (blockFloor >= 0) {
      if (indent > blockFloor) continue;
      blockFloor = -1;
    }
    const cleaned = stripInlineComment(raw).trim().replace(/^-\s+/, "");
    const keyMatch = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(cleaned);
    if (!keyMatch) continue;
    const value = keyMatch[2].trim();
    keys.push({ key: keyMatch[1], value });
    if (value === "|" || value === ">" || value.startsWith("|") || value.startsWith(">")) {
      blockFloor = indent;
    }
  }

  return keys;
}

function findUploadArtifactSteps(source: string): UploadArtifactStep[] {
  const found: UploadArtifactStep[] = [];
  for (const step of splitSteps(source)) {
    const keys = mappingKeys(step.text);
    const uses = keys.find((entry) => entry.key === "uses");
    if (!uses) continue;
    const action = unquote(uses.value);
    if (!UPLOAD_ARTIFACT.test(action)) continue;
    const retention = keys.find((entry) => entry.key === "retention-days");
    let retentionDays: number | null = null;
    if (retention && /^\d+$/.test(unquote(retention.value))) {
      retentionDays = Number(unquote(retention.value));
    }
    found.push({ line: step.line, retentionDays });
  }
  return found;
}

function retentionViolations(source: string, fileLabel: string): string[] {
  return findUploadArtifactSteps(source)
    .filter((step) => step.retentionDays !== DIAGNOSTIC_ARTIFACT_RETENTION_DAYS)
    .map((step) => {
      const actual = step.retentionDays === null ? "missing" : String(step.retentionDays);
      return `${fileLabel}:${step.line} retention-days is ${actual}, expected ${DIAGNOSTIC_ARTIFACT_RETENTION_DAYS}`;
    });
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function workflowPaths(): string[] {
  const dir = join(repoRoot, ".github", "workflows");
  return readdirSync(dir)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .sort()
    .map((name) => join(dir, name));
}

describe("CI diagnostic artifact retention", () => {
  it("documents a 7-day retention period in the CI workflow", () => {
    const ci = readFileSync(join(repoRoot, ".github/workflows/ci.yml"), "utf8");
    expect(ci).toContain(
      `Diagnostic artifact retention is ${DIAGNOSTIC_ARTIFACT_RETENTION_DAYS} days`,
    );
    expect(ci).toContain(`retention-days: ${DIAGNOSTIC_ARTIFACT_RETENTION_DAYS}`);
  });

  it("requires every upload-artifact step to set the documented retention", () => {
    const violations: string[] = [];
    for (const path of workflowPaths()) {
      const source = readFileSync(path, "utf8");
      violations.push(...retentionViolations(source, relative(repoRoot, path)));
    }
    expect(violations).toEqual([]);
  });

  it("flags an upload that omits retention-days", () => {
    const source = [
      "jobs:",
      "  quality:",
      "    steps:",
      "      - uses: actions/upload-artifact@v4",
      "        with:",
      "          name: logs",
      "          path: logs/",
    ].join("\n");
    expect(retentionViolations(source, "ci.yml")).toEqual([
      "ci.yml:4 retention-days is missing, expected 7",
    ]);
  });

  it("accepts an upload that sets the documented retention", () => {
    const source = [
      "      - name: Upload logs",
      "        uses: actions/upload-artifact@v4",
      "        with:",
      "          name: ci-logs",
      "          path: logs/",
      `          retention-days: ${DIAGNOSTIC_ARTIFACT_RETENTION_DAYS}`,
    ].join("\n");
    expect(findUploadArtifactSteps(source)).toEqual([
      { line: 1, retentionDays: DIAGNOSTIC_ARTIFACT_RETENTION_DAYS },
    ]);
    expect(retentionViolations(source, "ci.yml")).toEqual([]);
  });

  it("rejects a longer retention on a diagnostic upload", () => {
    const source = [
      "      - uses: actions/upload-artifact@v4",
      "        with:",
      "          path: reports/",
      "          retention-days: 90",
    ].join("\n");
    expect(retentionViolations(source, "ci.yml")).toEqual([
      "ci.yml:1 retention-days is 90, expected 7",
    ]);
  });

  it("ignores upload-artifact text that is only inside a run script", () => {
    const source = [
      "      - name: Document",
      "        run: |",
      "          echo uses: actions/upload-artifact@v4",
      "          echo retention-days: 90",
    ].join("\n");
    expect(findUploadArtifactSteps(source)).toEqual([]);
  });

  it("accepts a quoted retention value of 7", () => {
    const source = [
      "      - uses: actions/upload-artifact@v4",
      '        with:',
      "          retention-days: '7'",
    ].join("\n");
    expect(retentionViolations(source, "ci.yml")).toEqual([]);
  });
});
