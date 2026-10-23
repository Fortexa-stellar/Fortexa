import { useState, useCallback } from "react";
import { signChallenge } from "@/lib/auth/wallet-challenge";
import { getChallenge } from "@/app/api/auth/challenge/route";

export default function LoginForm() {
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [challenge, setChallenge] = useState<string | null>(null);

  const handleSubmit = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      // Always fetch fresh challenge before sign
      const newChallenge = await getChallenge();
      setChallenge(newChallenge);

      const signature = await signChallenge(newChallenge);
      // Clear challenge immediately after use
      setChallenge(null);

      // Submit to login endpoint
      const response = await fetch("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ challenge: newChallenge, signature }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        // Show only the error code, never the signed payload
        setError(errorData.code || "Login failed");
        setChallenge(null);
        return;
      }

      // Success - challenge already cleared
      window.location.href = "/dashboard";
    } catch (err) {
      setError("Network error");
      setChallenge(null);
    } finally {
      setIsLoading(false);
    }
  }, []);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        handleSubmit();
      }}
    >
      <button type="submit" disabled={isLoading}>
        {isLoading ? "Signing..." : "Login with Wallet"}
      </button>
      {error && <div className="error">{error}</div>}
    </form>
  );
}
