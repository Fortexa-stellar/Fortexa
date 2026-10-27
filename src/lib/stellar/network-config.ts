import { createHash } from "node:crypto";
import { Networks } from "@stellar/stellar-sdk";

import { assertNoEmbeddedCredentials, hasEmbeddedCredentials } from "@/lib/validation/remote-urls";

export const DEFAULT_STELLAR_HORIZON_URL = "https://horizon-testnet.stellar.org";

export type StellarNetworkProfile = "testnet" | "public" | "custom";

export function getStellarHorizonUrl(): string {
  const configured = process.env.STELLAR_HORIZON_URL;
  if (configured) {
    assertNoEmbeddedCredentials(configured, "STELLAR_HORIZON_URL");
    return configured;
  }
  return DEFAULT_STELLAR_HORIZON_URL;
}

export function getStellarNetworkPassphrase(): string {
  return process.env.STELLAR_NETWORK_PASSPHRASE ?? Networks.TESTNET;
}

export function getStellarNetworkFingerprint(): string {
  return createHash("sha256")
    .update(getStellarHorizonUrl())
    .update("\0")
    .update(getStellarNetworkPassphrase())
    .digest("hex");
}

export function inferStellarNetworkProfile(horizonUrl: string): StellarNetworkProfile {
  const normalized = horizonUrl.trim().toLowerCase();

  if (normalized.includes("testnet")) {
    return "testnet";
  }

  if (
    normalized.includes("localhost") ||
    normalized.includes("127.0.0.1") ||
    normalized.includes(".local") ||
    normalized.includes("-mock.") ||
    normalized.includes("horizon-mock")
  ) {
    return "custom";
  }

  if (
    normalized.includes("horizon.stellar.org") ||
    normalized.includes("horizon-mainnet") ||
    normalized.includes("/public")
  ) {
    return "public";
  }

  return "custom";
}

export type StellarNetworkConfig =
  | {
      ok: true;
      horizonUrl: string;
      networkPassphrase: string;
      profile: StellarNetworkProfile;
    }
  | {
      ok: false;
      error: string;
    };

export function resolveStellarNetworkConfig(): StellarNetworkConfig {
  const configuredHorizon = process.env.STELLAR_HORIZON_URL;
  if (configuredHorizon && hasEmbeddedCredentials(configuredHorizon)) {
    return {
      ok: false,
      error: "STELLAR_HORIZON_URL must not contain embedded username or password credentials.",
    };
  }

  const horizonUrl = getStellarHorizonUrl();
  const networkPassphrase = getStellarNetworkPassphrase();
  const profile = inferStellarNetworkProfile(horizonUrl);

  if (profile === "testnet" && networkPassphrase !== Networks.TESTNET) {
    return {
      ok: false,
      error:
        `Stellar network mismatch: STELLAR_HORIZON_URL (${horizonUrl}) points to testnet, ` +
        `but STELLAR_NETWORK_PASSPHRASE does not match the testnet passphrase. ` +
        `Unset STELLAR_NETWORK_PASSPHRASE or set it to the testnet value.`,
    };
  }

  if (profile === "public" && networkPassphrase !== Networks.PUBLIC) {
    return {
      ok: false,
      error:
        `Stellar network mismatch: STELLAR_HORIZON_URL (${horizonUrl}) points to public/mainnet Horizon, ` +
        `but STELLAR_NETWORK_PASSPHRASE does not match the public network passphrase. ` +
        `Fix STELLAR_HORIZON_URL or STELLAR_NETWORK_PASSPHRASE so they agree.`,
    };
  }

  return { ok: true, horizonUrl, networkPassphrase, profile };
}

export function assertStellarNetworkConfig(): {
  horizonUrl: string;
  networkPassphrase: string;
} {
  const config = resolveStellarNetworkConfig();
  if (!config.ok) {
    throw new Error(config.error);
  }

  return {
    horizonUrl: config.horizonUrl,
    networkPassphrase: config.networkPassphrase,
  };
}
