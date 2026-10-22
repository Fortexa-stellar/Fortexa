import {
  Account,
  Asset,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/stellar/network-config", () => ({
  assertStellarNetworkConfig: () => ({
    networkPassphrase: Networks.TESTNET,
    horizonUrl: "https://horizon-testnet.stellar.org",
  }),
  getStellarHorizonUrl: () => "https://horizon-testnet.stellar.org",
}));

import { decodeSignedXdrSourceAccount } from "@/lib/stellar/client";

function buildSignedXdr(signerKp: Keypair, sourcePublicKey: string) {
  const account = new Account(sourcePublicKey, "1");
  const destination = Keypair.random();
  const tx = new TransactionBuilder(account, { fee: "100", networkPassphrase: Networks.TESTNET })
    .addOperation(
      Operation.payment({
        destination: destination.publicKey(),
        asset: Asset.native(),
        amount: "1",
      })
    )
    .setTimeout(180)
    .build();
  tx.sign(signerKp);
  return tx.toXDR();
}

describe("decodeSignedXdrSourceAccount", () => {
  it("resolves the source account for a normal signed transaction", () => {
    const walletKp = Keypair.random();
    const xdr = buildSignedXdr(walletKp, walletKp.publicKey());

    const result = decodeSignedXdrSourceAccount(xdr);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sourceAccount).toBe(walletKp.publicKey());
      expect(result.isFeeBump).toBe(false);
    }
  });

  it("returns a source account that differs when the XDR was built for a different wallet", () => {
    const sessionWalletKp = Keypair.random();
    const someoneElseKp = Keypair.random();
    const xdr = buildSignedXdr(someoneElseKp, someoneElseKp.publicKey());

    const result = decodeSignedXdrSourceAccount(xdr);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sourceAccount).not.toBe(sessionWalletKp.publicKey());
    }
  });

  it("rejects malformed XDR instead of throwing", () => {
    const result = decodeSignedXdrSourceAccount("not-a-valid-xdr-string");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("malformed");
    }
  });

  it("rejects an empty string", () => {
    const result = decodeSignedXdrSourceAccount("");

    expect(result.ok).toBe(false);
  });

  it("resolves to the inner transaction's source for a fee-bump transaction, not the fee payer", () => {
    const innerSourceKp = Keypair.random();
    const feePayerKp = Keypair.random();
    const innerAccount = new Account(innerSourceKp.publicKey(), "1");
    const destination = Keypair.random();

    const innerTx = new TransactionBuilder(innerAccount, {
      fee: "100",
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        Operation.payment({
          destination: destination.publicKey(),
          asset: Asset.native(),
          amount: "1",
        })
      )
      .setTimeout(180)
      .build();
    innerTx.sign(innerSourceKp);

    const feeBumpTx = TransactionBuilder.buildFeeBumpTransaction(
      feePayerKp,
      "200",
      innerTx,
      Networks.TESTNET
    );
    feeBumpTx.sign(feePayerKp);

    const result = decodeSignedXdrSourceAccount(feeBumpTx.toXDR());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sourceAccount).toBe(innerSourceKp.publicKey());
      expect(result.sourceAccount).not.toBe(feePayerKp.publicKey());
      expect(result.isFeeBump).toBe(true);
    }
  });
});
