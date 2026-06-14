import { NextResponse } from "next/server";

// POST /api/actions/email-clinic — Composio email to a legal-aid clinic. Enhancement tier.
// Wave 3: calls lib/actions.ts. "Prepare + hand off," never "files your case."
export async function POST() {
  return NextResponse.json(
    { ok: false, error: "not implemented" },
    { status: 501 },
  );
}
