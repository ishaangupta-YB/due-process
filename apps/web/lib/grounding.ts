// lib/grounding.ts — retrieve -> answer/abstain + citation enforcement.
// STUB (P0). Wave 2 (P2) implements this.
//
// INVARIANT (CLAUDE.md §1.2): cite or abstain. Every substantive legal statement MUST
// be backed by a retrieved citation. If retrieval confidence is low, the question is
// out of corpus, or sources conflict, return { status: "abstained" } with a legal-aid
// referral. Never guess. The referral is ALWAYS present.

import type { GroundedAnswer } from "./types";

export interface GroundingInput {
  caseId: string;
  questionText: string;
  language?: string;
}

export async function answerQuestion(_input: GroundingInput): Promise<GroundedAnswer> {
  throw new Error("grounding.answerQuestion: not implemented (P0 stub)");
}
