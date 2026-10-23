import { NextRequest, NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth/require-auth";
import { getWalletFromSession } from "@/lib/auth/session-wallet";
import { checkBlocklist } from "@/lib/security/blocklist";
import { getNativeBalance } from "@/lib/stellar/client";
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

  if (!publicKey || assignedWallet?.source !== "external") {
    const sessionWallet = await getWalletFromSession(auth.session);
    if (sessionWallet) {
      assignedWallet = await upsertUserWallet(userId, {
        publicKey: sessionWallet,
        source: "external",
        provider: assignedWallet?.provider ?? "login",
      });
      publicKey = assignedWallet.publicKey;
    }
  }

  if (!publicKey || assignedWallet?.source !== "external") {
    return NextResponse.json(
      {
        configured: false,
        userId,
        network,
        message: "Link your Stellar wallet address to continue with real on-chain transactions.",
      },
      { status: 200, headers: securityHeadersForRequest(request) }
    );
  }

  if (!(await checkBlocklist(publicKey)).allow) {
    return NextResponse.json({ error: "Wallet address is blocklisted." }, { status: 403 });
  }

  try {
    const balance = await getNativeBalance(publicKey);
    return NextResponse.json(
      {
        configured: true,
        userId,
        source: assignedWallet.source,
        provider: assignedWallet.provider ?? "unknown",
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
        source: assignedWallet.source,
        provider: assignedWallet.provider ?? "unknown",
        network,
        publicKey,
        error: error instanceof Error ? error.message : "Failed to load balance.",
      },
      { status: 200, headers: securityHeadersForRequest(request) }
    );
  }
}
