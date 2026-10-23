import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { policyConfigSchema } from "@/lib/validation/schemas";
import { normalizePolicy } from "@/lib/storage/policy-store";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const loadFixture = (name: string): unknown => {
  const raw = readFileSync(path.join(__dirname, "__fixtures__", name), "utf8");
  return JSON.parse(raw);
};

const VALID_FIXTURES = ["default.json", "strict.json", "permissive.json"] as const;

describe("policy import/export round trip", () => {
  for (const fixtureName of VALID_FIXTURES) {
    const label = fixtureName.replace(".json", "");

    it(`stably round-trips ${label} policy`, () => {
      const raw = loadFixture(fixtureName);
      const imported = policyConfigSchema.parse(raw);
      const normalized = normalizePolicy(imported);

      const exported = JSON.stringify(normalized);
      const reimported = normalizePolicy(policyConfigSchema.parse(JSON.parse(exported)));

      expect(reimported).toEqual(normalized);
      expect(JSON.stringify(normalized)).toBe(exported);
    });
  }

  it("rejects invalid fixture missing allowedHours", () => {
    const raw = loadFixture("invalid-missing-hours.json");
    const result = policyConfigSchema.safeParse(raw);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.includes("allowedHours"))).toBe(true);
    }
  });
});
