import { NextResponse } from "next/server";
import { generateChallenge } from "@/lib/auth/challenge";

// In-memory store for demo purposes (replace with DB in production)
const usedChallenges = new Set<string>();

export async function GET() {
  try {
    const challenge = generateChallenge();
    usedChallenges.add(challenge);
    return NextResponse.json({ challenge });
  } catch (error) {
    return NextResponse.json({ error: "Failed to generate challenge" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const { challenge } = await request.json();

  if (usedChallenges.has(challenge)) {
    usedChallenges.delete(challenge); // Mark as consumed
    return NextResponse.json(
      { error: "Challenge already used", code: "CHALLENGE_CONSUMED" },
      { status: 400 }
    );
  }

  return NextResponse.json(
    { error: "Invalid challenge", code: "INVALID_CHALLENGE" },
    { status: 400 }
  );
}
