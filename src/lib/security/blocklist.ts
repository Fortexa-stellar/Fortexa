const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_FETCH_TIMEOUT_MS = 5000; // 5 second timeout for blocklist fetch
const MAX_BLOCKLIST_RESPONSE_BYTES = 1024 * 1024; // 1 MiB

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

/** Get the configured blocklist fetch timeout in milliseconds. */
function getBlocklistTimeout(): number {
  const envTimeout = process.env.FORTEXA_BLOCKLIST_TIMEOUT_MS;
  if (envTimeout) {
    const parsed = parseInt(envTimeout, 10);
    return isNaN(parsed) ? DEFAULT_FETCH_TIMEOUT_MS : Math.max(100, parsed);
  }
  return DEFAULT_FETCH_TIMEOUT_MS;
}

/** Return current blocklist feed health without triggering a refresh. */
export function getBlocklistHealth(): BlocklistHealth {
  return {
    configured: Boolean(process.env.FORTEXA_BLOCKLIST_URL),
    lastRefreshAt,
    domainCount: cachedDomains.length,
    lastError: lastErrorSummary,
  };
}

/** Fetch and cache the external blocklist. Returns [] on any failure. */
export async function fetchBlocklist(): Promise<string[]> {
  const url = process.env.FORTEXA_BLOCKLIST_URL;
  if (!url) return [];

  if (Date.now() < cacheExpiresAt) return cachedDomains;

  try {
    const timeoutMs = getBlocklistTimeout();
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
    lastErrorSummary =
      err instanceof Error ? err.message : "Unknown fetch error";
    throw err;
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
 * just because the feed is unreachable.
 */
export async function checkBlocklist(domain: string): Promise<BlocklistVerdict> {
  let domains: string[];
  try {
    domains = await fetchBlocklist();
  } catch {
    domains = cachedDomains;
  }

  const normalized = domain.trim().toLowerCase();
  const listed = domains.some((entry) => entry.trim().toLowerCase() === normalized);

  return listed
    ? { allow: false, reasonCode: "BLOCKLIST_MATCH" }
    : { allow: true, reasonCode: null };
}
