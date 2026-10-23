import { createHmac, timingSafeEqual } from "node:crypto";

import { TransactionBuilder } from "@stellar/stellar-sdk";

type BuildAuthorization = {
  userId: string;
  decisionId: string;
  quoteExpiresAt: string;
  transactionHash: string;
};

function sign(payload: string): string {
  const secret = process.env.FORTEXA_AUTH_SECRET?.trim();
  if (!secret) throw new Error("FORTEXA_AUTH_SECRET is required for payment authorization.");
  return createHmac("sha256", secret).update(`payment-build:${payload}`).digest("base64url");
}

export function getTransactionHash(xdr: string, networkPassphrase: string): string {
  return TransactionBuilder.fromXDR(xdr, networkPassphrase).hash().toString("hex");
}

export function createBuildAuthorization(input: BuildAuthorization): string {
  const payload = Buffer.from(JSON.stringify(input)).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

export function verifyBuildAuthorization(token: string, expected: BuildAuthorization): boolean {
  const parts = token.split(".");
  if (parts.length !== 2 || token.length > 2048) return false;
  const [payload, signature] = parts;
  const actual = Buffer.from(signature);
  const wanted = Buffer.from(sign(payload));
  if (actual.length !== wanted.length || !timingSafeEqual(actual, wanted)) return false;
  try {
    const decoded = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8")
    ) as BuildAuthorization;
    return (
      decoded.userId === expected.userId &&
      decoded.decisionId === expected.decisionId &&
      decoded.quoteExpiresAt === expected.quoteExpiresAt &&
      decoded.transactionHash === expected.transactionHash
    );
  } catch {
    return false;
  }
}
