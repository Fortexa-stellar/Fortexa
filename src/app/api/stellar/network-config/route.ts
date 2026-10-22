import { NextResponse } from "next/server";

import {
  getStellarHorizonUrl,
  getStellarNetworkFingerprint,
  inferStellarNetworkProfile,
  resolveStellarNetworkConfig,
} from "@/lib/stellar/network-config";

export function GET() {
  return NextResponse.json(
    {
      profile: inferStellarNetworkProfile(getStellarHorizonUrl()),
      fingerprint: getStellarNetworkFingerprint(),
      valid: resolveStellarNetworkConfig().ok,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
