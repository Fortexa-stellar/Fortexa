import { describe, expect, it } from "vitest";

import { diffLists } from "@/components/policy-editor";

describe("diffLists", () => {
  it("returns all items as unchanged when lists are identical", () => {
    const a = ["research-pro", "market-feed", "settlement-worker"];
    const b = ["research-pro", "market-feed", "settlement-worker"];

    const result = diffLists(a, b);

    expect(result).toHaveLength(3);
    for (const item of result) {
      expect(item.status).toBe("unchanged");
    }
  });

  it("returns an empty array when both lists are empty", () => {
    expect(diffLists([], [])).toEqual([]);
  });

  it("treats duplicate values as a single unchanged entry", () => {
    const a = ["x", "y", "x"];
    const b = ["x", "y"];

    const result = diffLists(a, b);

    expect(result).toEqual(
      expect.arrayContaining([
        { value: "x", status: "unchanged" },
        { value: "y", status: "unchanged" },
      ])
    );
  });
});
