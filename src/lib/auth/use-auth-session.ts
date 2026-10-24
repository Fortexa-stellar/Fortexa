"use client";

import { useCallback, useEffect, useState } from "react";

type SessionPayload = {
  authenticated?: boolean;
  user?: {
    email?: string;
    role?: "operator" | "viewer";
    userId?: string;
    exp?: number;
  };
};

export function useAuthSession() {
  const [loading, setLoading] = useState(true);
  const [authenticated, setAuthenticated] = useState(false);
  const [email, setEmail] = useState<string | null>(null);
  const [role, setRole] = useState<"operator" | "viewer" | null>(null);
  const [wallet, setWallet] = useState<string | null>(null);

  useEffect(() => {
    const fetchSession = async () => {
      setLoading(true);

      try {
        const response = await fetch("/api/auth/session", { cache: "no-store" });
        const payload = (await response.json()) as SessionPayload;

        if (payload.authenticated && payload.user?.role) {
          setAuthenticated(true);
          setEmail(payload.user.email ?? null);
          setRole(payload.user.role);
          setWallet(parseWalletFromEmail(payload.user.email));

          const now = Math.floor(Date.now() / 1000);
          const exp = payload.user.exp ?? 0;
          if (exp > 0 && exp - now < 60 * 60 * 24) {
            void fetch("/api/auth/refresh", { method: "POST" });
          }
          return;
        }

        setAuthenticated(false);
        setEmail(null);
        setRole(null);
        setWallet(null);
      } catch {
        setAuthenticated(false);
        setEmail(null);
        setRole(null);
        setWallet(null);
      } finally {
        setLoading(false);
      }
    };

    void fetchSession();
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);

    try {
      const response = await fetch("/api/auth/session", { cache: "no-store" });
      const payload = (await response.json()) as SessionPayload;

      if (payload.authenticated && payload.user?.role) {
        setAuthenticated(true);
        setEmail(payload.user.email ?? null);
        setRole(payload.user.role);
        setWallet(getWalletFromSession(payload.user));

        const now = Math.floor(Date.now() / 1000);
        const exp = payload.user.exp ?? 0;
        if (exp > 0 && exp - now < 60 * 60 * 24) {
          void fetch("/api/auth/refresh", { method: "POST" });
        }
        return;
      }

      setAuthenticated(false);
      setEmail(null);
      setRole(null);
      setWallet(null);
    } catch {
      setAuthenticated(false);
      setEmail(null);
      setRole(null);
      setWallet(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial session refresh on mount
    void refresh();
  }, [refresh]);

  return {
    loading,
    authenticated,
    email,
    role,
    wallet,
    isOperator: role === "operator",
    isViewer: role === "viewer",
    refresh,
  };
}
