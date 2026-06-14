import { NextResponse } from "next/server";

// POST /api/intake — image (base64/multipart) and/or { text, language } -> NoticeFacts.
// Wave 1 (P1-C): calls lib/extraction.ts.
export async function POST() {
  return NextResponse.json(
    { ok: false, error: "not implemented" },
    { status: 501 },
  );
}
