import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// The card module imports the Freighter-backed session hook and Next router;
// the panel under test uses neither, and no browser extension is loaded.
vi.mock("@stellar/freighter-api", () => {
  throw new Error("browser extension must not be used in tests");
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

import { WalletActionsPanel } from "@/components/wallet-status-card";
import { resolveWalletCardState } from "@/lib/auth/session-wallet";

const SESSION_WALLET = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
const OTHER_ACCOUNT = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7";

function buttonDisabled(html: string, action: string) {
  const match = html.match(new RegExp(`<button[^>]*data-action="${action}"[^>]*>`));
  expect(match, `${action} button rendered`).not.toBeNull();
  return /\sdisabled=""/.test(match![0]);
}

describe("resolveWalletCardState", () => {
  it("enables pay and policy for an operator whose connected account matches", () => {
    const state = resolveWalletCardState({
      authenticated: true,
      role: "operator",
      sessionWallet: SESSION_WALLET,
      connectedAccount: SESSION_WALLET.toLowerCase(),
    });
    expect(state).toMatchObject({ status: "match", canPay: true, canEditPolicy: true });
  });

  it("enables only what the role allows for a matching viewer", () => {
    const state = resolveWalletCardState({
      authenticated: true,
      role: "viewer",
      sessionWallet: SESSION_WALLET,
      connectedAccount: SESSION_WALLET,
    });
    expect(state).toMatchObject({ status: "match", canPay: false, canEditPolicy: false });
  });

  it("disables pay and policy when the connected account differs", () => {
    const state = resolveWalletCardState({
      authenticated: true,
      role: "operator",
      sessionWallet: SESSION_WALLET,
      connectedAccount: OTHER_ACCOUNT,
    });
    expect(state).toMatchObject({ status: "mismatch", canPay: false, canEditPolicy: false });
  });

  it("disables actions when no account is connected or no wallet is bound", () => {
    expect(
      resolveWalletCardState({
        authenticated: true,
        role: "operator",
        sessionWallet: SESSION_WALLET,
        connectedAccount: null,
      })
    ).toMatchObject({ status: "not_connected", canPay: false, canEditPolicy: false });
    expect(
      resolveWalletCardState({
        authenticated: true,
        role: "operator",
        sessionWallet: null,
        connectedAccount: SESSION_WALLET,
      })
    ).toMatchObject({ status: "unbound", canPay: false, canEditPolicy: false });
  });

  it("returns signed out with nothing enabled after revoke", () => {
    const state = resolveWalletCardState({
      authenticated: true,
      revoked: true,
      role: "operator",
      sessionWallet: SESSION_WALLET,
      connectedAccount: SESSION_WALLET,
    });
    expect(state).toEqual({
      status: "signed_out",
      sessionWallet: null,
      connectedAccount: null,
      canPay: false,
      canEditPolicy: false,
    });
  });
});

describe("WalletActionsPanel", () => {
  it("renders enabled pay and policy actions for a matching operator", () => {
    const html = renderToStaticMarkup(
      <WalletActionsPanel
        state={resolveWalletCardState({
          authenticated: true,
          role: "operator",
          sessionWallet: SESSION_WALLET,
          connectedAccount: SESSION_WALLET,
        })}
      />
    );
    expect(html).toContain('data-status="match"');
    expect(buttonDisabled(html, "pay")).toBe(false);
    expect(buttonDisabled(html, "policy")).toBe(false);
  });

  it("renders a mismatch state with pay and policy disabled", () => {
    const html = renderToStaticMarkup(
      <WalletActionsPanel
        state={resolveWalletCardState({
          authenticated: true,
          role: "operator",
          sessionWallet: SESSION_WALLET,
          connectedAccount: OTHER_ACCOUNT,
        })}
      />
    );
    expect(html).toContain('data-status="mismatch"');
    expect(html).toContain('role="alert"');
    expect(buttonDisabled(html, "pay")).toBe(true);
    expect(buttonDisabled(html, "policy")).toBe(true);
  });

  it("shows signed out after revoke with no action enabled", () => {
    const html = renderToStaticMarkup(
      <WalletActionsPanel
        state={resolveWalletCardState({
          authenticated: true,
          revoked: true,
          role: "operator",
          sessionWallet: SESSION_WALLET,
          connectedAccount: SESSION_WALLET,
        })}
      />
    );
    expect(html).toContain('data-status="signed_out"');
    expect(html).toContain("Signed out");
    expect(buttonDisabled(html, "pay")).toBe(true);
    expect(buttonDisabled(html, "policy")).toBe(true);
    expect(html).not.toContain('data-action="revoke"');
  });
});
