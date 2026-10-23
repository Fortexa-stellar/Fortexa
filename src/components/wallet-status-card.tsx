import { useSessionWallet } from "@/lib/auth/session-wallet";
import { useWalletRole } from "@/lib/auth/wallet-role";
import { useWallet } from "@solana/wallet-adapter-react";
import { Button } from "./ui/button";

interface WalletStatusCardProps {
  onPay: () => void;
  onPolicy: () => void;
  onRevoke: () => void;
}

export function WalletStatusCard({ onPay, onPolicy, onRevoke }: WalletStatusCardProps) {
  const { publicKey, connected } = useWallet();
  const { sessionWallet, clearSession } = useSessionWallet();
  const { hasPayRole, hasPolicyRole } = useWalletRole();

  const isMatchingWallet =
    connected && publicKey && sessionWallet && publicKey.equals(sessionWallet);
  const showMismatch = connected && publicKey && sessionWallet && !isMatchingWallet;

  const handleRevoke = () => {
    onRevoke();
    clearSession();
  };

  if (!connected) {
    return <div className="p-4 border rounded-lg">Wallet not connected</div>;
  }

  return (
    <div className="p-4 border rounded-lg space-y-4">
      <div>
        Connected: {publicKey?.toBase58().slice(0, 6)}...
        {showMismatch && <div className="text-sm text-amber-600">Session wallet mismatch</div>}
      </div>

      <div className="flex gap-2">
        <Button onClick={onPay} disabled={!isMatchingWallet || !hasPayRole}>
          Pay
        </Button>
        <Button onClick={onPolicy} disabled={!isMatchingWallet || !hasPolicyRole}>
          Policy
        </Button>
        <Button onClick={handleRevoke} variant="destructive">
          Revoke
        </Button>
      </div>
    </div>
  );
}
