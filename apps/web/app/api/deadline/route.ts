import { NextResponse } from "next/server";

// POST /api/deadline — { serviceDateISO, serviceMethod } -> DeadlineResult.
// Wave 1 (P1-B): calls lib/deadline-engine.ts. NO LLM.
export async function POST() {
  return NextResponse.json(
    { ok: false, error: "not implemented" },
    { status: 501 },
  );
}
