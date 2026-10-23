import type { NextRequest } from "next/server";

import { redactSensitiveFields } from "@/lib/observability/redact";

type LogLevel = "info" | "warn" | "error";

export type LogContext = {
  requestId?: string;
  route?: string;
  method?: string;
  userId?: string;
  role?: string;
  statusCode?: number;
  [key: string]: unknown;
};

function serialize(level: LogLevel, message: string, context?: LogContext) {
  return JSON.stringify(
    redactSensitiveFields({
      ts: new Date().toISOString(),
      level,
      message,
      ...context,
    })
  );
}

export function getRequestId(request: NextRequest) {
  return request.headers.get("x-request-id") ?? "unknown";
}

export function getRequestLogContext(request: NextRequest, route: string): LogContext {
  return {
    requestId: getRequestId(request),
    route,
    method: request.method,
  };
}

export function logInfo(message: string, context?: LogContext) {
  console.log(serialize("info", message, context));
}

export function logWarn(message: string, context?: LogContext) {
  console.warn(serialize("warn", message, context));
}

export function logError(message: string, context?: LogContext) {
  console.error(serialize("error", message, context));
}
