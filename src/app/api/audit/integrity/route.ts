import { NextRequest } from "next/server";

import { verifyHashChain } from "@/lib/audit/hash-chain";
import { requireAuth } from "@/lib/auth/require-auth";
import { jsonWithRequestContext } from "@/lib/observability/http";
import { getRequestLogContext, logInfo, logWarn } from "@/lib/observability/logger";
import { listAllAuditEntriesByUser, listAuditEntries } from "@/lib/storage/audit-store";

type IntegrityResponse = {
  valid: boolean;
  checkedEntries: number;
  legacyEntries: number;
  firstBrokenEntryId: string | null;
  reason: string | null;
  scope: "mine" | "all";
  timestamp: string;
  userId?: string;
};

function nowIso() {
  return new Date().toISOString();
}

export async function GET(request: NextRequest) {
  const startedAtMs = Date.now();
  const context = getRequestLogContext(request, "/api/audit/integrity");
  const auth = requireAuth(request);

  if (!auth.ok) {
    logWarn("Audit integrity unauthorized", context);
    return auth.response;
  }

  const scopeParam = request.nextUrl.searchParams.get("scope")?.toLowerCase() ?? "mine";
  if (scopeParam !== "mine" && scopeParam !== "all") {
    return jsonWithRequestContext(request, {
      route: "/api/audit/integrity",
      startedAtMs,
      status: 400,
      body: { error: "scope must be 'mine' or 'all'" },
    });
  }

  const isOperator = auth.session.role === "operator";
  const wantAll = scopeParam === "all";

  if (wantAll && !isOperator) {
    logWarn("Audit integrity all-scope forbidden", {
      ...context,
      userId: auth.session.userId,
      role: auth.session.role,
    });
    return jsonWithRequestContext(request, {
      route: "/api/audit/integrity",
      startedAtMs,
      status: 403,
      body: { error: "Only operators may verify cross-user audit integrity." },
    });
  }

  const timestamp = nowIso();

  if (!wantAll) {
    const entries = await listAuditEntries(auth.session.userId);
    const result = verifyHashChain(entries);

    if (result.valid) {
      logInfo("Audit integrity verified (mine)", {
        ...context,
        userId: auth.session.userId,
        checkedEntries: result.checkedCount,
        legacyEntries: result.legacyCount,
      });
      return jsonWithRequestContext(request, {
        route: "/api/audit/integrity",
        startedAtMs,
        status: 200,
        body: {
          valid: true,
          checkedEntries: result.checkedCount,
          legacyEntries: result.legacyCount,
          firstBrokenEntryId: null,
          reason: null,
          scope: "mine",
          userId: auth.session.userId,
          timestamp,
        } satisfies IntegrityResponse,
      });
    }

    logWarn("Audit integrity tampered (mine)", {
      ...context,
      userId: auth.session.userId,
      reason: result.reason,
      firstBrokenEntryId: result.entryId ?? null,
    });
    return jsonWithRequestContext(request, {
      route: "/api/audit/integrity",
      startedAtMs,
      status: 200,
      body: {
        valid: false,
        checkedEntries: result.checkedCount,
        legacyEntries: result.legacyCount,
        firstBrokenEntryId: result.entryId ?? null,
        reason: result.reason,
        scope: "mine",
        userId: auth.session.userId,
        timestamp,
      } satisfies IntegrityResponse,
    });
  }

  const allByUser = await listAllAuditEntriesByUser();
  let checkedEntries = 0;
  let legacyEntries = 0;
  let firstBroken: { entryId: string | null; reason: string } | null = null;

  for (const entries of Object.values(allByUser)) {
    const result = verifyHashChain(entries);
    checkedEntries += result.checkedCount;
    legacyEntries += result.legacyCount;
    if (!result.valid && !firstBroken) {
      firstBroken = {
        entryId: result.entryId ?? null,
        reason: result.reason,
      };
    }
  }

  const responseBody = (firstBroken
    ? {
        valid: false,
        checkedEntries,
        legacyEntries,
        firstBrokenEntryId: firstBroken.entryId,
        reason: firstBroken.reason,
        scope: "all" as const,
        timestamp,
      }
    : {
        valid: true,
        checkedEntries,
        legacyEntries,
        firstBrokenEntryId: null,
        reason: null,
        scope: "all" as const,
        timestamp,
      }) satisfies IntegrityResponse;

  if (firstBroken) {
    logWarn("Audit integrity tampered (all)", {
      ...context,
      userId: auth.session.userId,
      reason: firstBroken.reason,
      firstBrokenEntryId: firstBroken.entryId,
    });
  } else {
    logInfo("Audit integrity verified (all)", {
      ...context,
      userId: auth.session.userId,
      checkedEntries,
      legacyEntries,
    });
  }

  return jsonWithRequestContext(request, {
    route: "/api/audit/integrity",
    startedAtMs,
    status: 200,
    body: responseBody,
  });
}
