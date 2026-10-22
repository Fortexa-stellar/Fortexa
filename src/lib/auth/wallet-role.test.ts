import { beforeEach, describe, expect, it } from "vitest";

import { resolveRolesByWallet } from "@/lib/auth/wallet-role";

const WALLET = `G${"A".repeat(55)}`;

describe("wallet role resolution", () => {
  beforeEach(() => {
    process.env.FORTEXA_OPERATOR_WALLETS = WALLET;
    process.env.FORTEXA_SIGNER_WALLETS = "";
    process.env.FORTEXA_VIEWER_WALLETS = "";
  });

  it("assigns signer-only wallets without operator privileges", () => {
    process.env.FORTEXA_OPERATOR_WALLETS = "";
    process.env.FORTEXA_SIGNER_WALLETS = WALLET;

    expect(resolveRolesByWallet(WALLET)).toEqual(["signer"]);
  });

  it("supports a wallet configured for both operator and signer roles", () => {
    process.env.FORTEXA_SIGNER_WALLETS = WALLET;

    expect(resolveRolesByWallet(WALLET)).toEqual(["operator", "signer"]);
  });

  it("does not grant either role to an unlisted wallet when allowlists are configured", () => {
    expect(resolveRolesByWallet(`G${"B".repeat(55)}`)).toEqual([]);
  });
});
