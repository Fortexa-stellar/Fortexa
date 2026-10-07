import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { recordApiMetric } from "@/lib/observability/metrics";
import { redactSensitiveFields } from "@/lib/observability/redact";
import { applySecurityHeaders } from "@/lib/security/headers";

export type HttpExchangeLog = {
  method: string;
  path: string;
  status: number;
  requestBody?: unknown;
  responseBody?: unknown;
  /** When set, the corresponding body is omitted entirely. */
  requestBodyTooLarge?: boolean;
  responseBodyTooLarge?: boolean;
};

/** Logs method, path, and status with redacted bodies. Oversized bodies are dropped. */
export function logHttpExchange(input: HttpExchangeLog) {
  const entry: Record<string, unknown> = {
    method: input.method,
    path: input.path,
    status: input.status,
  };

  if (!input.requestBodyTooLarge && input.requestBody !== undefined) {
    entry.requestBody = redactSensitiveFields(input.requestBody);
  }

  if (!input.responseBodyTooLarge && input.responseBody !== undefined) {
    entry.responseBody = redactSensitiveFields(input.responseBody);
  }

  console.log(JSON.stringify(entry));
}

export function jsonWithRequestContext(
  request: NextRequest,
  input: {
    route: string;
    startedAtMs: number;
    status: number;
    body: unknown;
    headers?: Record<string, string>;
    logExchange?: boolean;
    requestBody?: unknown;
    requestBodyTooLarge?: boolean;
  }
) {
  if (input.logExchange) {
    logHttpExchange({
      method: request.method,
      path: input.route,
      status: input.status,
      requestBody: input.requestBody,
      responseBody: input.body,
      requestBodyTooLarge: input.requestBodyTooLarge,
    });
  }

  const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
  const durationMs = Math.max(0, Date.now() - input.startedAtMs);

  recordApiMetric({
    route: input.route,
    method: request.method,
    statusCode: input.status,
    durationMs,
  });

  const response = NextResponse.json(input.body, {
    status: input.status,
    headers: {
      "x-request-id": requestId,
      ...input.headers,
    },
  });

  // Every route that uses this helper (auth, decision, payment) gets the shared
  // security header set on success and error responses alike.
  return applySecurityHeaders(response, requestId, { noStore: input.noStore });
}
