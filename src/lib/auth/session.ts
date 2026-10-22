import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import type { NextRequest } from "next/server";

export type AuthRole = "operator" | "signer" | "viewer";

export type AuthSession = {
  userId: string;
  email: string;
  role: AuthRole;
  /**
   * Session id. Minted once at login and carried forward by refresh, so every
   * token generation of one login shares it. Logout revokes by this id.
   */
  sid: string;
  exp: number;
  publicKey?: string;
};

export const AUTH_COOKIE_KEY = "fortexa_session";

/** Longest lifetime any session token is issued with. */
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

function getAuthSecret() {
  const secret = process.env.FORTEXA_AUTH_SECRET?.trim();
  if (!secret) {
    throw new Error("FORTEXA_AUTH_SECRET is required for auth session signing.");
  }
  return secret;
}

function encodeBase64Url(value: string | Buffer) {
  const base64 = Buffer.from(value).toString("base64");
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(value: string) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  return Buffer.from(padded, "base64").toString("utf8");
}

function sign(payloadPart: string) {
  return createHmac("sha256", getAuthSecret()).update(payloadPart).digest("base64url");
}

export function createSessionToken(input: {
  email: string;
  role: AuthRole;
  userId?: string;
  expiresInSeconds?: number;
  publicKey?: string;
}) {
  const now = Math.floor(Date.now() / 1000);
  const payload: AuthSession = {
    userId: input.userId ?? randomUUID(),
    email: input.email,
    role: input.role,
    exp: now + (input.expiresInSeconds ?? 60 * 60 * 24 * 7),
    publicKey: input.publicKey,
  };

  const payloadPart = encodeBase64Url(JSON.stringify(payload));
  const signaturePart = sign(payloadPart);

  return `${payloadPart}.${signaturePart}`;
}

export function verifySessionToken(
  token: string,
  options?: VerifySessionTokenOptions
): AuthSession | null {
  const parts = token.split(".");
  if (parts.length !== 2) {
    return null;
  }

  const [payloadPart, signaturePart] = parts;
  const expectedSignature = sign(payloadPart);

  const actualBuffer = Buffer.from(signaturePart);
  const expectedBuffer = Buffer.from(expectedSignature);

  if (actualBuffer.length !== expectedBuffer.length) {
    return null;
  }

  if (!timingSafeEqual(actualBuffer, expectedBuffer)) {
    return null;
  }

  try {
    const parsed = JSON.parse(decodeBase64Url(payloadPart)) as Partial<AuthSession>;

    // A token without a session id cannot be revoked, so it is not accepted.
    if (
      !parsed.userId ||
      !parsed.email ||
      !parsed.role ||
      !parsed.exp ||
      typeof parsed.sid !== "string" ||
      !parsed.sid
    ) {
      return null;
    }

    if (parsed.exp <= Math.floor(Date.now() / 1000)) {
      return null;
    }

    if (parsed.role !== "operator" && parsed.role !== "signer" && parsed.role !== "viewer") {
      return null;
    }

    if (
      parsed.roles !== undefined &&
      (!Array.isArray(parsed.roles) ||
        parsed.roles.some((role) => role !== "operator" && role !== "signer" && role !== "viewer"))
    ) {
      return null;
    }

    if (
      parsed.roles !== undefined &&
      (!Array.isArray(parsed.roles) ||
        parsed.roles.some((role) => role !== "operator" && role !== "signer" && role !== "viewer"))
    ) {
      return null;
    }

    const session: AuthSession = {
      userId: parsed.userId,
      email: parsed.email,
      role: parsed.role,
      exp: parsed.exp,
      gen: normalizeGeneration(parsed.gen),
      sid: normalizeSessionId(parsed.sid),
    };

    if (!options?.allowStaleGeneration) {
      const generationCurrent = isSessionGenerationCurrent({
        userId: session.userId,
        sessionId: session.sid,
        generation: session.gen,
      });

      if (!generationCurrent) {
        return null;
      }
    }

    return session;
  } catch {
    return null;
  }
}

export function getSessionFromRequest(request: NextRequest) {
  const token = request.cookies.get(AUTH_COOKIE_KEY)?.value;
  if (!token) {
    return null;
  }

  return verifySessionToken(token);
}

export function startSession(input: {
  email: string;
  role: AuthRole;
  userId?: string;
  expiresInSeconds?: number;
}) {
  const userId = input.userId ?? randomUUID();
  const ttlSeconds = input.expiresInSeconds ?? DEFAULT_SESSION_TTL_SECONDS;
  const sessionId = randomUUID();

  const token = createSessionToken({
    email: input.email,
    role: input.role,
    userId,
    expiresInSeconds: ttlSeconds,
    generation: 0,
    sessionId,
  });

  registerSession({
    userId,
    sessionId,
    generation: 0,
    expiresAtMs: Date.now() + ttlSeconds * 1000,
  });

  return { token, userId, sessionId, generation: 0 };
}

export function rotateSessionToken(session: AuthSession) {
  const rotated = rotateSessionGeneration({
    userId: session.userId,
    sessionId: session.sid,
    currentGeneration: session.gen,
    expiresAtMs: Date.now() + DEFAULT_SESSION_TTL_SECONDS * 1000,
  });

  if (!rotated.ok) {
    return null;
  }

  const token = createSessionToken({
    email: session.email,
    role: session.role,
    userId: session.userId,
    generation: rotated.generation,
    sessionId: session.sid,
  });

  return { token, generation: rotated.generation };
}
