import { sign } from "stellar-sdk";

export async function signChallenge(challenge: string): Promise<string> {
  if (!challenge) {
    throw new Error("No challenge to sign");
  }

  // In a real implementation, this would use the wallet's private key
  // For this example, we'll use a mock signature
  const keypair = localStorage.getItem("walletKeypair");
  if (!keypair) {
    throw new Error("No wallet connected");
  }

  const signature = sign(challenge, keypair);
  return signature.toString();
}

export function clearChallenge(): void {
  // Additional cleanup if needed
}
