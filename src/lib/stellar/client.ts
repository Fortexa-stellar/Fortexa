import {
  Asset,
  FeeBumpTransaction,
  Horizon,
  Memo,
  Operation,
  Transaction,
  TransactionBuilder,
} from "@stellar/stellar-sdk";

import type { StellarPaymentRequest } from "@/lib/types/domain";
import { assertStellarNetworkConfig, getStellarHorizonUrl } from "@/lib/stellar/network-config";

export function getHorizonServer() {
  const { horizonUrl } = assertStellarNetworkConfig();
  return new Horizon.Server(horizonUrl);
}

export async function getNativeBalance(publicKey: string) {
  const server = getHorizonServer();
  const account = await server.loadAccount(publicKey);
  const native = account.balances.find((balance) => balance.asset_type === "native");
  return native?.balance ?? "0";
}

export async function buildUnsignedPaymentTransaction(request: StellarPaymentRequest, sourcePublicKey: string) {
  const { networkPassphrase } = assertStellarNetworkConfig();
  const server = getHorizonServer();
  const sourceAccount = await server.loadAccount(sourcePublicKey);

  const transaction = new TransactionBuilder(sourceAccount, {
    fee: (await server.fetchBaseFee()).toString(),
    networkPassphrase,
  })
    .addOperation(
      Operation.payment({
        destination: request.destination,
        asset: Asset.native(),
        amount: request.amountXLM,
      })
    )
    .addMemo(Memo.text(request.memo?.slice(0, 28) ?? "Fortexa payment"))
    .setTimeout(180)
    .build();

  return {
    xdr: transaction.toXDR(),
    networkPassphrase,
  };
}

export type SignedXdrSourceResult =
  | {
      ok: true;
      sourceAccount: string;
      isFeeBump: boolean;
      payment: { destination: string; amountXLM: string; asset: "native"; memo?: string } | null;
    }
  | { ok: false; reason: "malformed" };

/**
 * Decodes a signed transaction XDR (without submitting it to Horizon) and
 * extracts the transaction-level source account.
 *
 * For a regular Transaction, this is `transaction.source`.
 * For a FeeBumpTransaction, the outer envelope's `source`/`feeSource` pays
 * the fee but does not "own" the operations, so we resolve to the inner
 * transaction's source account instead — that's the account whose signed
 * intent actually matches the session wallet.
 *
 * Returns `{ ok: false, reason: "malformed" }` instead of throwing so
 * callers can return a clean 400 response.
 */
export function decodeSignedXdrSourceAccount(signedXdr: string): SignedXdrSourceResult {
  const { networkPassphrase } = assertStellarNetworkConfig();

  let decoded: Transaction | FeeBumpTransaction;
  try {
    decoded = TransactionBuilder.fromXDR(signedXdr, networkPassphrase);
  } catch {
    return { ok: false, reason: "malformed" };
  }

  let isFeeBump = false;
  if (decoded instanceof FeeBumpTransaction) {
    isFeeBump = true;
    decoded = decoded.innerTransaction;
  }

  const operation = decoded.operations.length === 1 ? decoded.operations[0] : undefined;
  const memoValue = decoded.memo.type === "text" ? decoded.memo.value : undefined;
  const payment = operation?.type === "payment" && operation.asset.isNative()
    ? {
        destination: operation.destination,
        amountXLM: operation.amount,
        asset: "native" as const,
        memo: memoValue === undefined || memoValue === null
          ? undefined
          : typeof memoValue === "string"
            ? memoValue
            : memoValue.toString("utf8"),
      }
    : null;

  return {
    ok: true,
    sourceAccount: decoded.source,
    isFeeBump,
    payment,
  };
}

export async function submitSignedTransactionXdr(signedXdr: string) {
  const { networkPassphrase } = assertStellarNetworkConfig();
  const server = getHorizonServer();
  const transaction = TransactionBuilder.fromXDR(signedXdr, networkPassphrase);
  const submitted = await server.submitTransaction(transaction);

  return {
    hash: submitted.hash,
    status: submitted.successful ? "submitted" : "unknown",
    ledger: submitted.ledger,
    resultXdr: submitted.result_xdr,
  };
}

export { getStellarHorizonUrl };

import { Keypair } from "@stellar/stellar-sdk";

export function verifySignedXdrSigner(signedXdr: string, publicKey: string): boolean {
  const { networkPassphrase } = assertStellarNetworkConfig();

  let decoded;
  try {
    decoded = TransactionBuilder.fromXDR(signedXdr, networkPassphrase);
  } catch {
    return false;
  }

  const kp = Keypair.fromPublicKey(publicKey);
  const hash = decoded.hash();
  
  for (const sig of decoded.signatures) {
    try {
      if (kp.verify(hash, sig.signature())) {
        return true;
      }
    } catch {
      // ignore
    }
  }
  return false;
}

export type SignedXdrDestinationResult =
  | { ok: true; destination: string; isFeeBump: boolean }
  | { ok: false; reason: "malformed" };

export function decodeSignedXdrDestination(signedXdr: string): SignedXdrDestinationResult {
  const source = decodeSignedXdrSourceAccount(signedXdr);
  if (!source.ok) {
    return { ok: false, reason: "malformed" };
  }
  return {
    ok: true,
    destination: source.payment?.destination ?? "",
    isFeeBump: source.isFeeBump,
  };
}
