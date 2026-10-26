import { NextRequest, NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth/require-auth";
import { getWalletFromSession } from "@/lib/auth/session-wallet";
import { checkBlocklist } from "@/lib/security/blocklist";
import { securityHeadersForRequest } from "@/lib/security/headers";
import { getNativeBalance } from "@/lib/stellar/client";
import { resolveStellarNetworkConfig } from "@/lib/stellar/network-config";
import { getUserWallet, upsertUserWallet } from "@/lib/storage/user-wallet-store";

export async function GET(request: NextRequest) {
  const auth = requireAuth(request);

  if (!auth.ok) {
    return auth.response;
  }

  const userId = auth.session.userId;
  const networkConfig = resolveStellarNetworkConfig();
  const network = networkConfig.ok ? networkConfig.profile : "mismatch";
  let assignedWallet = await getUserWallet(userId);

  if (assignedWallet && "expired" in assignedWallet) {
    return NextResponse.json(
      { error: "Session wallet mapping has expired." },
      { status: 401, headers: securityHeadersForRequest(request) }
    );
  }

  if (!assignedWallet && process.env.NODE_ENV === "development") {
    try {
      assignedWallet = await upsertUserWallet(userId, {
        publicKey: "GDEV...",
        source: "external",
        provider: "freighter",
      });
    } catch {
      // ignore
    }
  }

  let publicKey = assignedWallet?.publicKey;
  if (!publicKey) {
    const sessionWallet = await getWalletFromSession(auth.session);
    if (sessionWallet) {
      publicKey = sessionWallet;
    }
  }

  if (!publicKey) {
    return NextResponse.json(
      {
        configured: false,
        userId,
        network,
        publicKey: null,
        balance: null,
        warning:
          "No wallet assigned to current user. Connect Freighter or configure operator wallet.",
      },
      { status: 200, headers: securityHeadersForRequest(request) }
    );
  }

  const blocklistCheck = await checkBlocklist(publicKey);
  if (!blocklistCheck.allow) {
    return NextResponse.json(
      {
        configured: true,
        userId,
        network,
        publicKey,
        balance: "0",
        warning: "Wallet address is blocked by security policy.",
        riskLevel: "CRITICAL",
        error: "Wallet address is blocked by security policy.",
      },
      { status: 403, headers: securityHeadersForRequest(request) }
    );
  }

  try {
    const balance = await getNativeBalance(publicKey);

    return NextResponse.json(
      {
        configured: true,
        userId,
        source: assignedWallet ? assignedWallet.source : "session",
        provider: assignedWallet ? (assignedWallet.provider ?? "freighter") : "freighter",
        network,
        publicKey,
        balance,
      },
      { headers: securityHeadersForRequest(request) }
    );
  } catch (error) {
    return NextResponse.json(
      {
        configured: true,
        userId,
        source: assignedWallet ? assignedWallet.source : "session",
        provider: assignedWallet ? (assignedWallet.provider ?? "unknown") : "unknown",
        network,
        publicKey,
        error: error instanceof Error ? error.message : "Failed to load balance.",
      },
      { status: 200, headers: securityHeadersForRequest(request) }
    );
  }
}
