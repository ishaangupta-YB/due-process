import { NextResponse } from "next/server";

// POST /api/document — { caseId } -> { r2Key, downloadUrl }.
// Wave 2 (P2): calls lib/documents.ts (draft UD-105 -> PDF -> R2). Drafts only.
export async function POST() {
  return NextResponse.json(
    { ok: false, error: "not implemented" },
    { status: 501 },
  );
}
