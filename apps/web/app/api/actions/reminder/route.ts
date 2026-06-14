import { NextResponse } from "next/server";
import { z } from "zod";
import { createReminder } from "@/lib/actions";

// POST /api/actions/reminder — Composio calendar reminder for the response deadline.
// Enhancement tier. Calls lib/actions.ts.
//
// CONSENT GATE: creating a calendar event acts on the user's behalf, so it requires an
// explicit `consent: true` in the body. Without it we refuse — nothing is created.
const BodySchema = z.object({
  caseId: z.string().min(1),
  whenISO: z.string().min(1),
  consent: z.literal(true, {
    errorMap: () => ({ message: "explicit consent is required to create this reminder" }),
  }),
});

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }

  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: parsed.error.issues[0]?.message ?? "invalid request" },
      { status: 400 },
    );
  }

  try {
    const { created } = await createReminder(parsed.data.caseId, parsed.data.whenISO);
    return NextResponse.json({ ok: true, created });
  } catch (err) {
    // Enhancement: never 500 the CORE flow. Report a clean, non-PII error.
    const message = err instanceof Error ? err.message : "failed to create reminder";
    const status = /not found/i.test(message) ? 404 : 502;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
