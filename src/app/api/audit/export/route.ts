import { NextRequest, NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth/require-auth";
import { jsonWithRequestContext } from "@/lib/observability/http";
import { getRequestLogContext, logError, logInfo, logWarn } from "@/lib/observability/logger";
import { listAllAuditEntriesByUser, listAuditEntries, validateAuditFilter } from "@/lib/storage/audit-store";
import { toCsv } from "@/utils/csv.utils";
import type { CsvRow } from "@/utils/csv.utils";
import type { AuditFilter } from "@/lib/storage/audit-store";
import { redactAuditExportEntriesByUser, redactAuditExportPayload } from "@/lib/audit/redact";
import { AuditChainError, verifyAuditChain } from "@/lib/audit/hash-chain";
import type { ChainVerificationResult } from "@/lib/audit/hash-chain";
import { buildAuditExportFilename } from "@/lib/audit/export-filename";

const AUDIT_CHAIN_VERIFICATION_FAILED = "audit_chain_verification_failed";

/**
 * Turns a verifier failure into an error response. No CSV is ever written when
 * this path is taken, so a broken chain can never be published in either
 * format. The row-cap violation is a client error (413); a broken chain is an
 * unprocessable export (422).
 */
function chainErrorResponse(
  request: NextRequest,
  startedAtMs: number,
  error: AuditChainError,
) {
  const status = error.code === "audit_chain_row_cap_exceeded" ? 413 : 422;
  return jsonWithRequestContext(request, {
    route: "/api/audit/export",
    startedAtMs,
    status,
    body: {
      error: error.message,
      code: error.code,
      ...(error.details ?? {}),
    },
  });
}

function chainFailureDetails(result: Extract<ChainVerificationResult, { valid: false }>) {
  return {
    entryId: result.entryId ?? null,
    index: result.index ?? null,
    checkedCount: result.checkedCount,
    legacyCount: result.legacyCount,
  };
}

export async function GET(request: NextRequest) {
  const startedAtMs = Date.now();
  const context = getRequestLogContext(request, "/api/audit/export");
  const auth = requireAuth(request);

  if (!auth.ok) {
    logWarn("Audit export unauthorized", context);
    return auth.response;
  }

  const format = request.nextUrl.searchParams.get("format")?.toLowerCase() ?? "json";
  const scope = request.nextUrl.searchParams.get("scope")?.toLowerCase() ?? "mine";

  const filter: AuditFilter = {
    from: request.nextUrl.searchParams.get("from") ?? undefined,
    to: request.nextUrl.searchParams.get("to") ?? undefined,
    decision: request.nextUrl.searchParams.get("decision") ?? undefined,
    domain: request.nextUrl.searchParams.get("domain") ?? undefined,
    actionId: request.nextUrl.searchParams.get("actionId") ?? undefined,
  };

  const validationError = validateAuditFilter(filter);
  if (validationError) {
    return jsonWithRequestContext(request, {
      route: "/api/audit/export",
      startedAtMs,
      status: 400,
      body: { error: validationError },
    });
  }

  try {
    const isOperator = auth.session.role === "operator";
    const viewerScopeAll = !isOperator && scope === "all";
    const exportAll = isOperator && scope === "all";

    if (viewerScopeAll) {
      return jsonWithRequestContext(request, {
        route: "/api/audit/export",
        startedAtMs,
        status: 400,
        body: { error: "Viewer role is limited to scope=mine." },
      });
    }

    if (format !== "json" && format !== "csv") {
      return jsonWithRequestContext(request, {
        route: "/api/audit/export",
        startedAtMs,
        status: 400,
        body: { error: "format must be json or csv" },
      });
    }

    if (exportAll) {
      const all = await listAllAuditEntriesByUser(filter);

      // Verify every user's chain before any encoder runs. The verifier enforces
      // the shared row cap and both formats abort together on a broken chain.
      const verifiedByUser = Object.fromEntries(
        Object.entries(all).map(([userId, entries]) => {
          const verified = verifyAuditChain(entries);
          if (!verified.result.valid) {
            throw new AuditChainError(
              AUDIT_CHAIN_VERIFICATION_FAILED,
              `Audit chain for user "${userId}" failed verification: ${verified.result.reason}`,
              { userId, ...chainFailureDetails(verified.result) },
            );
          }
          return [userId, verified] as const;
        }),
      );

      if (format === "json") {
        logInfo("Audit export success (all/json)", { ...context, userId: auth.session.userId });
        return jsonWithRequestContext(request, {
          route: "/api/audit/export",
          startedAtMs,
          status: 200,
          body: {
            scope: "all",
            exportedBy: auth.session.userId,
            entriesByUser: redactAuditExportEntriesByUser(all),
            chainBoundariesByUser: Object.fromEntries(
              Object.entries(verifiedByUser).map(([userId, verified]) => [
                userId,
                verified.boundaries,
              ]),
            ),
          },
        });
      }

      const rows: CsvRow[] = [];
      for (const [userId, entries] of Object.entries(all)) {
        for (const entry of entries) {
          rows.push({
            userId,
            id: entry.id,
            timestamp: entry.timestamp,
            decision: entry.decision,
            actionId: entry.action.id,
            actionName: entry.action.name,
            domain: entry.action.domain,
            amountXLM: entry.action.amountXLM,
            explanation: entry.explanation,
            entryHash: entry.entryHash ?? "",
            previousHash: entry.previousHash ?? "",
          });
        }
      }

      logInfo("Audit export success (all/csv)", { ...context, userId: auth.session.userId });
      return new NextResponse(toCsv(redactAuditExportPayload(rows)), {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename=${buildAuditExportFilename("all")}`,
          "x-request-id": request.headers.get("x-request-id") ?? crypto.randomUUID(),
        },
      });
    }

    const mine = await listAuditEntries(auth.session.userId, filter);

    // Verify the chain before the CSV encoder runs so a rewritten log can never
    // be published. The row cap is enforced by the same verifier as the JSON path.
    const verified = verifyAuditChain(mine);
    if (!verified.result.valid) {
      throw new AuditChainError(
        AUDIT_CHAIN_VERIFICATION_FAILED,
        `Audit chain failed verification: ${verified.result.reason}`,
        chainFailureDetails(verified.result),
      );
    }

    if (format === "json") {
      logInfo("Audit export success (mine/json)", { ...context, userId: auth.session.userId });
      return jsonWithRequestContext(request, {
        route: "/api/audit/export",
        startedAtMs,
        status: 200,
        body: {
          scope: "mine",
          userId: auth.session.userId,
          entries: redactAuditExportPayload(mine),
          chainBoundary: verified.boundaries,
        },
      });
    }

    const rows: CsvRow[] = mine.map((entry) => ({
      userId: auth.session.userId,
      id: entry.id,
      timestamp: entry.timestamp,
      decision: entry.decision,
      actionId: entry.action.id,
      actionName: entry.action.name,
      domain: entry.action.domain,
      amountXLM: entry.action.amountXLM,
      explanation: entry.explanation,
      entryHash: entry.entryHash ?? "",
      previousHash: entry.previousHash ?? "",
    }));

    logInfo("Audit export success (mine/csv)", { ...context, userId: auth.session.userId });
    const filenameMine = buildAuditExportFilename("mine");
    return new NextResponse(toCsv(rows), {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename=${filenameMine}`,
        "x-request-id": request.headers.get("x-request-id") ?? crypto.randomUUID(),
      },
    });
  } catch (error) {
    if (error instanceof AuditChainError) {
      logWarn("Audit export blocked by chain verification", {
        ...context,
        userId: auth.session.userId,
        code: error.code,
        detail: error.message,
      });
      return chainErrorResponse(request, startedAtMs, error);
    }

    logError("Audit export internal error", {
      ...context,
      userId: auth.session.userId,
      detail: error instanceof Error ? error.message : "unknown",
    });

    return jsonWithRequestContext(request, {
      route: "/api/audit/export",
      startedAtMs,
      status: 500,
      body: {
        error: error instanceof Error ? error.message : "Failed to export audit data.",
      },
    });
  }
}
