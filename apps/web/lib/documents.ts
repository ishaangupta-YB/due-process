// lib/documents.ts — draft UD-105 Answer -> PDF -> R2.
// STUB (P0). Wave 2 (P2) implements this.
//
// INVARIANT (CLAUDE.md §1.5): generated documents are DRAFTS. Watermark
// "DRAFT — review before filing." The system never submits to a court e-filing system.

export interface DocumentResult {
  r2Key: string;
  downloadUrl: string;
}

export async function draftAnswerDocument(_caseId: string): Promise<DocumentResult> {
  throw new Error("documents.draftAnswerDocument: not implemented (P0 stub)");
}
