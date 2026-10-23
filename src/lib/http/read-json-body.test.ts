import { describe, expect, it } from "vitest";

import {
  DEFAULT_JSON_BODY_MAX_BYTES,
  getJsonBodyMaxBytes,
  readJsonBody,
} from "@/lib/http/read-json-body";

function requestWithBody(body: string, contentLength?: number) {
  const headers = new Headers({ "content-type": "application/json" });
  if (contentLength !== undefined) {
    headers.set("content-length", String(contentLength));
  }

  return new Request("http://localhost/api/test", {
    method: "POST",
    headers,
    body,
  });
}

describe("readJsonBody", () => {
  it("parses valid JSON within the limit", async () => {
    const result = await readJsonBody(requestWithBody(JSON.stringify({ ok: true })));

    expect(result).toEqual({ ok: true, data: { ok: true } });
  });

  it("returns 413 when Content-Length exceeds the limit", async () => {
    const result = await readJsonBody(requestWithBody("{}", DEFAULT_JSON_BODY_MAX_BYTES + 1), {
      maxBytes: 1024,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(413);
    }
  });

  it("returns 413 when streamed body exceeds the limit", async () => {
    const oversized = "x".repeat(2048);
    const result = await readJsonBody(requestWithBody(oversized), { maxBytes: 1024 });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(413);
    }
  });

  it("treats malformed small JSON as an empty object", async () => {
    const result = await readJsonBody(requestWithBody("{not-json"));

    expect(result).toEqual({ ok: true, data: {} });
  });

  it("reads FORTEXA_JSON_BODY_MAX_BYTES when set", () => {
    const previous = process.env.FORTEXA_JSON_BODY_MAX_BYTES;
    process.env.FORTEXA_JSON_BODY_MAX_BYTES = "8192";

    expect(getJsonBodyMaxBytes()).toBe(8192);

    process.env.FORTEXA_JSON_BODY_MAX_BYTES = previous;
  });
});
