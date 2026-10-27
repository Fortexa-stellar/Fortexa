/**
 * Remote service URL validation helper.
 * Rejects usernames or passwords embedded in remote service URLs
 * (Horizon, Redis, blocklist) before they reach logs or network clients.
 */

/**
 * Checks whether a URL contains embedded credentials (username or password).
 */
export function hasEmbeddedCredentials(urlString: string | null | undefined): boolean {
  if (!urlString || typeof urlString !== "string") {
    return false;
  }

  const trimmed = urlString.trim();
  if (trimmed.length === 0) {
    return false;
  }

  try {
    const parsed = new URL(trimmed);
    return Boolean(parsed.username || parsed.password);
  } catch {
    // If WHATWG URL parser fails (e.g. malformed or custom URI scheme),
    // check for the standard userinfo pattern `scheme://<userinfo>@<host>`.
    return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^@\/\s]+@/.test(trimmed);
  }
}

/**
 * Strips credentials (username and password) from a URL for safe display or logging.
 */
export function sanitizeUrl(urlString: string | null | undefined): string {
  if (!urlString || typeof urlString !== "string") {
    return "";
  }

  const trimmed = urlString.trim();
  if (trimmed.length === 0) {
    return "";
  }

  try {
    const parsed = new URL(trimmed);
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return trimmed.replace(
      /^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^@\/\s]+@/,
      "$1[REDACTED]@"
    );
  }
}

export type RemoteUrlValidationResult =
  | { ok: true; url: string }
  | { ok: false; error: string };

/**
 * Validates that a remote service URL is valid and does not contain embedded credentials.
 * Error messages never echo or leak embedded credentials.
 */
export function validateRemoteServiceUrl(
  urlString: string | null | undefined,
  serviceName: string
): RemoteUrlValidationResult {
  if (!urlString || typeof urlString !== "string" || urlString.trim().length === 0) {
    return { ok: false, error: `${serviceName} is not configured.` };
  }

  const trimmed = urlString.trim();

  if (hasEmbeddedCredentials(trimmed)) {
    return {
      ok: false,
      error: `${serviceName} must not contain embedded username or password credentials. Provide credentials through separate configuration options.`,
    };
  }

  try {
    new URL(trimmed);
  } catch {
    return {
      ok: false,
      error: `${serviceName} is not a valid URL.`,
    };
  }

  return { ok: true, url: trimmed };
}

/**
 * Asserts that a remote service URL does not contain embedded credentials.
 * Throws an Error with a sanitized message if credentials are detected.
 */
export function assertNoEmbeddedCredentials(
  urlString: string | null | undefined,
  serviceName: string
): void {
  if (hasEmbeddedCredentials(urlString)) {
    throw new Error(
      `${serviceName} must not contain embedded username or password credentials.`
    );
  }
}
