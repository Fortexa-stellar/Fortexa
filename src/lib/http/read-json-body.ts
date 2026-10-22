/** Default max JSON body size for sensitive API routes (64 KiB). */
export const DEFAULT_JSON_BODY_MAX_BYTES = 64 * 1024;

export function getJsonBodyMaxBytes(): number {
  const configured = process.env.FORTEXA_JSON_BODY_MAX_BYTES;
  if (!configured) {
    return DEFAULT_JSON_BODY_MAX_BYTES;
  }

  const parsed = Number.parseInt(configured, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_JSON_BODY_MAX_BYTES;
  }

  return parsed;
}

export type ReadJsonBodyResult =
  { ok: true; data: unknown } | { ok: false; status: 413; error: string };

export async function readJsonBody(
  request: Request,
  options?: { maxBytes?: number }
): Promise<ReadJsonBodyResult> {
  const maxBytes = options?.maxBytes ?? getJsonBodyMaxBytes();
  const readResult = await readBodyTextWithLimit(request, maxBytes);

  if (!readResult.ok) {
    return {
      ok: false,
      status: 413,
      error: `Request body exceeds the ${maxBytes}-byte limit.`,
    };
  }

  return { ok: true, data: parseJsonBodyText(readResult.text) };
}

async function readBodyTextWithLimit(
  request: Request,
  maxBytes: number
): Promise<{ ok: true; text: string } | { ok: false }> {
  const contentLength = request.headers.get("content-length");
  if (contentLength) {
    const length = Number.parseInt(contentLength, 10);
    if (Number.isFinite(length) && length > maxBytes) {
      return { ok: false };
    }
  }

  const body = request.body;
  if (!body) {
    return { ok: true, text: "" };
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let text = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      bytesRead += value.byteLength;
      if (bytesRead > maxBytes) {
        await reader.cancel();
        return { ok: false };
      }

      text += decoder.decode(value, { stream: true });
    }
  } finally {
    text += decoder.decode();
  }

  return { ok: true, text };
}

function parseJsonBodyText(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed === "") {
    return {};
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return {};
  }
}
