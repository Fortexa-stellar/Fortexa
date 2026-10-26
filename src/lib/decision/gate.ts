import { getUserWallet, isUserWalletRevoked } from "@/lib/storage/user-wallet-store";

export async function canPassDecisionGate(userId: string): Promise<boolean> {
  if (typeof isUserWalletRevoked === "function") {
    const isRevoked = await isUserWalletRevoked(userId);
    if (isRevoked) return false;
  }
  const wallet = await getUserWallet(userId);
  if (!wallet || ("expired" in wallet && wallet.expired)) return false;
  return true;
}
