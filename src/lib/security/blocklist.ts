const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_BLOCKLIST_RESPONSE_BYTES = 1024 * 1024; // 1 MiB

/** Longest a blocklist refresh waits before giving up, unless configured. */
export const DEFAULT_BLOCKLIST_TIMEOUT_MS = 5000;
/** Floor for `FORTEXA_BLOCKLIST_TIMEOUT_MS`: a smaller value could not finish a normal fetch. */
export const MIN_BLOCKLIST_TIMEOUT_MS = 100;
/** Ceiling for `FORTEXA_BLOCKLIST_TIMEOUT_MS`, so a typo cannot turn the timeout into a hang. */
export const MAX_BLOCKLIST_TIMEOUT_MS = 30_000;

async function readLimitedResponseBody(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      totalBytes += value.byteLength;
      if (totalBytes > MAX_BLOCKLIST_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error(`Blocklist response exceeds ${MAX_BLOCKLIST_RESPONSE_BYTES} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

/** Production rejected an empty, non-HTTPS, or malformed blocklist URL. */
export class BlocklistUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlocklistUrlError";
  }
}

/**
 * Production requires `FORTEXA_BLOCKLIST_URL` to be an absolute HTTPS URL.
 * Returns a clear error message, or null when the value is acceptable.
 * Does not include the configured value, which may carry a query secret.
 */
export function productionBlocklistUrlProblem(
  value: string | undefined
): string | null {
  const url = value?.trim() ?? "";
  if (!url) {
    return "FORTEXA_BLOCKLIST_URL is required in production and must be an HTTPS URL.";
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "FORTEXA_BLOCKLIST_URL must be a valid HTTPS URL in production.";
  }

  if (parsed.protocol !== "https:") {
    return "FORTEXA_BLOCKLIST_URL must use HTTPS in production.";
  }

  if (!parsed.hostname) {
    return "FORTEXA_BLOCKLIST_URL must be a valid HTTPS URL in production.";
  }

  return null;
}

/**
 * Read the configured feed URL.
 * Outside production an empty value stays disabled. In production, empty,
 * HTTP, and malformed values throw instead of being fetched.
 */
function readConfiguredBlocklistUrl(): string | null {
  const raw = process.env.FORTEXA_BLOCKLIST_URL;
  if (process.env.NODE_ENV === "production") {
    const problem = productionBlocklistUrlProblem(raw);
    if (problem) {
      throw new BlocklistUrlError(problem);
    }
    return (raw ?? "").trim();
  }

  const url = raw?.trim() ?? "";
  return url.length > 0 ? url : null;
}

let cachedDomains: string[] = [];
let cacheExpiresAt = 0;
let lastRefreshAt: string | null = null;
let lastErrorSummary: string | null = null;

export type BlocklistHealth = {
  configured: boolean;
  lastRefreshAt: string | null;
  domainCount: number;
  lastError: string | null;
};

/** Thrown when the feed does not answer (headers and body) within the timeout. */
export class BlocklistTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Blocklist fetch timed out after ${timeoutMs}ms`);
    this.name = "BlocklistTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/** Whether `err` is the abort a refresh raises when the timeout elapses. */
export function isBlocklistTimeout(err: unknown): boolean {
  return (
    err instanceof BlocklistTimeoutError ||
    (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError"))
  );
}

/**
 * The blocklist fetch timeout in milliseconds.
 *
 * `FORTEXA_BLOCKLIST_TIMEOUT_MS` must be a whole number; anything else (unset,
 * empty, negative, `5s`, `1e3`) falls back to the default rather than guessing.
 * A valid value is clamped to [MIN_BLOCKLIST_TIMEOUT_MS, MAX_BLOCKLIST_TIMEOUT_MS].
 */
export function getBlocklistTimeoutMs(): number {
  const raw = process.env.FORTEXA_BLOCKLIST_TIMEOUT_MS?.trim();
  if (!raw || !/^\d+$/.test(raw)) return DEFAULT_BLOCKLIST_TIMEOUT_MS;
  return Math.min(MAX_BLOCKLIST_TIMEOUT_MS, Math.max(MIN_BLOCKLIST_TIMEOUT_MS, Number(raw)));
}

/** Return current blocklist feed health without triggering a refresh. */
export function getBlocklistHealth(): BlocklistHealth {
  return {
    configured: Boolean(readConfiguredBlocklistUrl()),
    lastRefreshAt,
    domainCount: cachedDomains.length,
    lastError: lastErrorSummary,
  };
}

/**
 * The last list fetched successfully, even if it has expired. This is the
 * fallback when a refresh fails: a stale list can only add matches, so using
 * it never lets a known-bad domain through.
 */
export function getStaleBlocklist(): string[] {
  return [...cachedDomains];
}

/**
 * Fetch and cache the external blocklist.
 *
 * Returns [] when no feed is configured. A failed refresh throws and leaves the
 * previous cache untouched; a refresh that takes longer than
 * {@link getBlocklistTimeoutMs} is aborted and throws a
 * {@link BlocklistTimeoutError}, so a feed that never answers cannot hold up the
 * caller. The response is read through a 1 MiB limit.
 */
export async function fetchBlocklist(): Promise<string[]> {
  const url = readConfiguredBlocklistUrl();
  if (!url) return [];

  if (Date.now() < cacheExpiresAt) return cachedDomains;

  const timeoutMs = getBlocklistTimeoutMs();
  try {
    // One signal for the whole exchange: it also aborts a body that stalls
    // after the headers arrive.
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const text = await readLimitedResponseBody(res);
    let domains: string[];

    try {
      const json = JSON.parse(text);
      domains = Array.isArray(json) ? json.map(String) : [];
    } catch {
      // plain-text: one domain per line, strip comments and blanks
      domains = text
        .split("\n")
        .map((l) => l.trim().replace(/^#.*/, ""))
        .filter(Boolean);
    }

    cachedDomains = domains;
    cacheExpiresAt = Date.now() + CACHE_TTL_MS;
    lastRefreshAt = new Date().toISOString();
    lastErrorSummary = null;
  } catch (err) {
    const failure = isBlocklistTimeout(err) ? new BlocklistTimeoutError(timeoutMs) : err;
    lastErrorSummary =
      failure instanceof Error ? failure.message : "Unknown fetch error";
    throw failure;
  }

  return cachedDomains;
}

/** Reset cache (for tests). */
export function resetBlocklistCache(): void {
  cachedDomains = [];
  cacheExpiresAt = 0;
  lastRefreshAt = null;
  lastErrorSummary = null;
}

export type BlocklistVerdict =
  | { allow: true; reasonCode: null }
  | { allow: false; reasonCode: "BLOCKLIST_MATCH" };

/**
 * Check a destination domain against the blocklist. On a failed refresh the
 * last cached list is still consulted so a known-bad domain is never allowed
 * just because the feed is unreachable. A misconfigured production URL is not
 * a feed failure and still throws.
 */
export async function checkBlocklist(domain: string): Promise<BlocklistVerdict> {
  let domains: string[];
  try {
    domains = await fetchBlocklist();
  } catch (err) {
    if (err instanceof BlocklistUrlError) {
      throw err;
    }
    domains = getStaleBlocklist();
  }

  const normalized = domain.trim().toLowerCase();
  const listed = domains.some((entry) => entry.trim().toLowerCase() === normalized);

  return listed
    ? { allow: false, reasonCode: "BLOCKLIST_MATCH" }
    : { allow: true, reasonCode: null };
}
