import { NextResponse } from "next/server";

// POST /api/answer — { caseId, questionText, language } -> GroundedAnswer.
// Wave 2 (P2): calls lib/grounding.ts (retrieve -> answer/abstain + citation enforcement).
export async function POST() {
  return NextResponse.json(
    { ok: false, error: "not implemented" },
    { status: 501 },
  );
}
