import type { NextRequest } from "next/server";

import { getSessionFromRequest, SESSION_MAX_AGE_SECONDS, type AuthSession, type VerifySessionTokenOptions } from "@/lib/auth/session";
import {
  clearSharedSessionRevocations,
  readSharedSessionRevocation,
  writeSharedSessionRevocation,
  type SharedSessionRevocationState,
} from "@/lib/security/shared-security-state";

// Session tokens are signed, not stored, so a valid signature alone cannot tell
// a live session from one that was logged out. This store is the server-side
// authority: a session id listed here is dead for every token generation that
// carries it. Shared state (Redis or file) makes revocations visible across
// instances; the in-memory map covers single-process deployments without it,
// the same layering the wallet challenge store uses.
const revokedSessions = new Map<string, SharedSessionRevocationState>();

/**
 * Revokes a session id, and with it every token generation minted for it.
 *
 * The record must outlive every generation, not just the token presented at
 * logout: an older generation can be used to log out while a newer one, minted
 * later by refresh, expires later. No generation can outlive its mint time plus
 * SESSION_MAX_AGE_SECONDS, and none can be minted after revocation, so keeping
 * the record until now + SESSION_MAX_AGE_SECONDS covers them all.
 */
export async function revokeSession(session: Pick<AuthSession, "sid" | "exp">) {
  const now = Date.now();
  const record: SharedSessionRevocationState = {
    revokedAtMs: now,
    expiresAtMs: Math.max(now + SESSION_MAX_AGE_SECONDS * 1000, session.exp * 1000),
  };

  revokedSessions.set(session.sid, record);
  await writeSharedSessionRevocation(session.sid, record);
}

export async function isSessionRevoked(sessionId: string) {
  const local = revokedSessions.get(sessionId);
  if (local && local.expiresAtMs > Date.now()) {
    return true;
  }

  const shared = await readSharedSessionRevocation(sessionId);
  return Boolean(shared && shared.expiresAtMs > Date.now());
}

/**
 * The session for this request if its token verifies and its session id has
 * not been revoked. Cookie presence, or even a valid signature, is not enough.
 */
export async function getActiveSessionFromRequest(request: NextRequest, options?: VerifySessionTokenOptions): Promise<AuthSession | null> {
  const session = getSessionFromRequest(request, options);
  if (!session) {
    return null;
  }

  return (await isSessionRevoked(session.sid)) ? null : session;
}

export async function resetSessionRevocationStore() {
  revokedSessions.clear();
  await clearSharedSessionRevocations();
}
