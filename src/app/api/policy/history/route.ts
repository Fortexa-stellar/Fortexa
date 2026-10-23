import { NextRequest } from "next/server";

import { requireAuth } from "@/lib/auth/require-auth";
import { jsonWithRequestContext } from "@/lib/observability/http";
import { getRequestLogContext, logError, logInfo, logWarn } from "@/lib/observability/logger";
import { getDailyUsage, listAllAuditEntriesByUser } from "@/lib/storage/audit-store";
import {
  getPolicyConfig,
  getPolicyHistory,
  getPolicyVersionByNumber,
} from "@/lib/storage/policy-store";
import {
  diffDecisionImpact,
  openAllowDecisions,
  type DecisionImpactReport,
  type OpenAllowDecision,
} from "@/lib/validation/diff";

/**
 * History entry plus the candidate preview: which open allow decisions would
 * flip to a denial under that candidate version, and which rule is responsible.
 * The candidate is evaluated read-only and is never activated here.
 */
type CandidateDecisionImpact = DecisionImpactReport & {
  candidateVersion: number;
  activeVersion: number;
};

export async function GET(request: NextRequest) {
  const startedAtMs = Date.now();
  const context = getRequestLogContext(request, "/api/policy/history");
  const auth = requireAuth(request, { allowedRoles: ["operator"] });

  if (!auth.ok) {
    logWarn("Policy history unauthorized", context);
    return auth.response;
  }

  const candidateRaw = request.nextUrl.searchParams.get("candidate");
  let candidateVersion: number | null = null;

  if (candidateRaw !== null) {
    const parsedCandidate = Number(candidateRaw);

    if (!Number.isInteger(parsedCandidate) || parsedCandidate < 1) {
      return jsonWithRequestContext(request, {
        route: "/api/policy/history",
        startedAtMs,
        status: 400,
        body: { error: "Invalid candidate version. Expected a positive integer." },
      });
    }

    candidateVersion = parsedCandidate;
  }

  try {
    const limitRaw = request.nextUrl.searchParams.get("limit");
    const limit = limitRaw ? Math.min(200, Math.max(1, Number(limitRaw))) : 20;
    const entries = await getPolicyHistory(limit);

    let decisionImpact: CandidateDecisionImpact | null = null;

    if (candidateVersion !== null) {
      const candidate = await getPolicyVersionByNumber(candidateVersion);
      const { policy: activePolicy, version: activeVersion } = await getPolicyConfig();

      const entriesByUser = await listAllAuditEntriesByUser();
      const decisions: OpenAllowDecision[] = [];

      for (const userId of Object.keys(entriesByUser)) {
        decisions.push(...openAllowDecisions(entriesByUser[userId], await getDailyUsage(userId)));
      }

      const impact = await diffDecisionImpact({
        activePolicy,
        candidatePolicy: candidate.policy,
        decisions,
      });

      decisionImpact = { ...impact, candidateVersion, activeVersion };

      logInfo("Policy candidate decision impact read", {
        ...context,
        userId: auth.session.userId,
        candidateVersion,
        activeVersion,
        status: impact.status,
        flipped: impact.flippedIds.length,
      });
    }

    logInfo("Policy history read", {
      ...context,
      userId: auth.session.userId,
      count: entries.length,
    });

    return jsonWithRequestContext(request, {
      route: "/api/policy/history",
      startedAtMs,
      status: 200,
      body: { entries, decisionImpact },
    });
  } catch (error) {
    const notFound = error instanceof Error && error.message.includes("not found");

    logError("Policy history internal error", {
      ...context,
      userId: auth.session.userId,
      detail: error instanceof Error ? error.message : "unknown",
    });

    return jsonWithRequestContext(request, {
      route: "/api/policy/history",
      startedAtMs,
      status: notFound ? 404 : 500,
      body: { error: error instanceof Error ? error.message : "Failed to read policy history." },
    });
  }
}
