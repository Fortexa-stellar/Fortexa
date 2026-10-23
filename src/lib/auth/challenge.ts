import { randomBytes } from "crypto";

export function generateChallenge(): string {
  return randomBytes(32).toString("hex");
}
