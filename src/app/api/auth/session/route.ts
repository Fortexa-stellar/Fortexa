import { NextRequest, NextResponse } from "next/server";

import { getActiveSessionFromRequest } from "@/lib/auth/session-revocation";
import { securityHeadersForRequest } from "@/lib/security/headers";

export async function GET(request: NextRequest) {
  const session = await getActiveSessionFromRequest(request, { allowStaleGeneration: true });

  if (!session) {
    return NextResponse.json(
      { authenticated: false },
      {
        status: 200,
        headers: securityHeadersForRequest(request, { noStore: true }),
      },
    );
  }

  return NextResponse.json(
    {
      authenticated: true,
      user: {
        email: session.email,
        role: session.role,
        userId: session.userId,
        exp: session.exp,
      },
    },
    { headers: securityHeadersForRequest(request, { noStore: true }) },
  );
}
