const STELLAR_PUBLIC_KEY_REGEX = /^G[A-Z2-7]{55}$/u;

export async function getWalletFromSession(session: { userId?: string; email?: string }) {
  const candidates = [session.userId, session.email]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .map((value) =>
      value
        .replace(/^wallet:/u, "")
        .trim()
        .toUpperCase()
    );

  for (const candidate of candidates) {
    if (STELLAR_PUBLIC_KEY_REGEX.test(candidate)) {
      return candidate;
    }
  }

  return null;
}

export type WalletCardStatus = "signed_out" | "unbound" | "not_connected" | "mismatch" | "match";

export type WalletCardState = {
  status: WalletCardStatus;
  sessionWallet: string | null;
  connectedAccount: string | null;
  canPay: boolean;
  canEditPolicy: boolean;
};

function normalizeAccount(value: string | null | undefined) {
  const normalized = value?.trim().toUpperCase() ?? "";
  return STELLAR_PUBLIC_KEY_REGEX.test(normalized) ? normalized : null;
}

/**
 * Gate wallet actions on the session binding: pay and policy actions are only
 * enabled when the connected account is the wallet stored on the session, and
 * then only as far as the session role allows.
 */
export function resolveWalletCardState(input: {
  authenticated: boolean;
  revoked?: boolean;
  role: "operator" | "viewer" | null;
  sessionWallet: string | null | undefined;
  connectedAccount: string | null | undefined;
}): WalletCardState {
  const sessionWallet = normalizeAccount(input.sessionWallet);
  const connectedAccount = normalizeAccount(input.connectedAccount);
  const locked = { canPay: false, canEditPolicy: false };

  if (!input.authenticated || input.revoked || !input.role) {
    return { status: "signed_out", sessionWallet: null, connectedAccount: null, ...locked };
  }

  if (!sessionWallet) {
    return { status: "unbound", sessionWallet: null, connectedAccount, ...locked };
  }

  if (!connectedAccount) {
    return { status: "not_connected", sessionWallet, connectedAccount: null, ...locked };
  }

  if (connectedAccount !== sessionWallet) {
    return { status: "mismatch", sessionWallet, connectedAccount, ...locked };
  }

  const isOperator = input.role === "operator";
  return {
    status: "match",
    sessionWallet,
    connectedAccount,
    canPay: isOperator,
    canEditPolicy: isOperator,
  };
}
