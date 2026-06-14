import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { computeResponseDeadline } from "@/lib/deadline-engine";

// POST /api/deadline — { serviceDateISO, serviceMethod } -> { ok, deadline: DeadlineResult }
// (CLAUDE.md §8). Thin wrapper over lib/deadline-engine.ts, which is PURE deterministic
// code (CLAUDE.md §1.3 — the LLM NEVER computes the deadline). No model calls, no bindings.
// The engine never throws and always returns a DeadlineResult (null date + assumptions when
// inputs are insufficient), so this route stays a thin, validated pass-through.

const BodySchema = z.object({
  serviceDateISO: z.string().nullable().optional(),
  serviceMethod: z.enum(["personal", "substituted", "posted_mail", "unknown"]),
});

export async function POST(req: NextRequest): Promise<NextResponse> {
  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "Invalid request body. Expected JSON { serviceDateISO?: string|null, serviceMethod: 'personal'|'substituted'|'posted_mail'|'unknown' }.",
      },
      { status: 400 },
    );
  }

  const deadline = computeResponseDeadline({
    serviceDateISO: parsed.data.serviceDateISO ?? "",
    serviceMethod: parsed.data.serviceMethod,
  });

  return NextResponse.json({ ok: true, deadline });
}
