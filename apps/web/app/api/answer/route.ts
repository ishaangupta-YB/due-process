import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { answerQuestion } from "@/lib/grounding";

// POST /api/answer — { caseId, questionText, language } -> { ok, answer: GroundedAnswer }
// (CLAUDE.md §8). Delegates to lib/grounding.ts, which performs retrieve -> answer/abstain
// with code-enforced citations and resolves the AI Search + Workers AI bindings itself.
// answerQuestion never throws and never returns an uncited "answered", so the route stays thin.

const JsonBody = z.object({
  caseId: z.string().optional(),
  questionText: z.string().min(1),
  language: z.string().optional(),
  priorContext: z.string().optional(),
});

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const parsed = JsonBody.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "Invalid request body. Expected JSON { caseId?, questionText, language?, priorContext? }.",
        },
        { status: 400 },
      );
    }

    const { questionText, language, priorContext } = parsed.data;
    const answer = await answerQuestion({ questionText, language, priorContext });
    return NextResponse.json({ ok: true, answer });
  } catch (err) {
    const message = err instanceof Error ? err.message : "answer failed";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
