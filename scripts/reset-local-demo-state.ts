import { readFileSync } from "fs";
import { NetworkConfig, getNetworkConfig } from "../src/lib/stellar/network-config";
import { getDbPath, getStoragePaths } from "../src/lib/storage/paths";
import { rm } from "fs/promises";
import { join } from "path";

const PRODUCTION_PASSPHRASE = "Standalone Network ; February 2017";
const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";

export async function resetLocalDemoState(): Promise<void> {
  const networkConfig: NetworkConfig = getNetworkConfig();
  const passphrase = networkConfig.networkPassphrase;

  if (passphrase === PRODUCTION_PASSPHRASE) {
    console.error("Error: Reset aborted - production network detected");
    process.exit(1);
  }

  if (passphrase !== TESTNET_PASSPHRASE) {
    console.error("Error: Reset only supported for testnet fixture");
    process.exit(1);
  }

  const storagePaths = getStoragePaths();
  const dbPath = getDbPath();

  try {
    await rm(storagePaths.dataDir, { recursive: true, force: true });
    await rm(dbPath, { recursive: true, force: true });
    console.log("Local demo state reset successfully");
  } catch (error) {
    console.error(
      "Error resetting local demo state:",
      error instanceof Error ? error.message : String(error)
    );
    process.exit(1);
  }
}

resetLocalDemoState().catch((error) => {
  console.error("Reset failed:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
