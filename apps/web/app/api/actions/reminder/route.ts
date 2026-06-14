import { NextResponse } from "next/server";

// POST /api/actions/reminder — Composio calendar reminder for the response deadline. Enhancement tier.
// Wave 3: calls lib/actions.ts.
export async function POST() {
  return NextResponse.json(
    { ok: false, error: "not implemented" },
    { status: 501 },
  );
}
