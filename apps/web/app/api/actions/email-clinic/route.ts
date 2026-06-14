import { NextResponse } from "next/server";
import { z } from "zod";
import { emailClinic } from "@/lib/actions";

// POST /api/actions/email-clinic — Composio email to a legal-aid clinic. Enhancement tier.
// "Prepare + hand off," never "files your case" (CLAUDE.md §1.5).
//
// CONSENT GATE: this action sends a real email on the user's behalf, so it requires an
// explicit `consent: true` in the body. Without it we refuse — no message is sent.
const BodySchema = z.object({
  caseId: z.string().min(1),
  clinicEmail: z.string().email(),
  consent: z.literal(true, {
    errorMap: () => ({ message: "explicit consent is required to send this email" }),
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
    const { sent } = await emailClinic(parsed.data.caseId, parsed.data.clinicEmail);
    return NextResponse.json({ ok: true, sent });
  } catch (err) {
    // Enhancement: never 500 the CORE flow. Report a clean, non-PII error.
    const message = err instanceof Error ? err.message : "failed to send email";
    const status = /not found/i.test(message) ? 404 : 502;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
