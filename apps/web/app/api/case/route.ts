import { NextResponse } from "next/server";

// GET /api/case?id= and POST /api/case — case CRUD via lib/db.ts + Case DO + mem0.
export async function GET() {
  return NextResponse.json(
    { ok: false, error: "not implemented" },
    { status: 501 },
  );
}

export async function POST() {
  return NextResponse.json(
    { ok: false, error: "not implemented" },
    { status: 501 },
  );
}
