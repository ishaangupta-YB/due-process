// lib/db.ts — D1 access (cases, qa_history, documents).
// STUB (P0). Wave 2/3 implements this. Access the D1 binding via getCloudflareContext().
// Store the minimum sensitive data needed (CLAUDE.md §1.6).

import type { CaseRecord } from "./types";

export async function createCase(_record: CaseRecord): Promise<void> {
  throw new Error("db.createCase: not implemented (P0 stub)");
}

export async function getCase(_id: string): Promise<CaseRecord | null> {
  throw new Error("db.getCase: not implemented (P0 stub)");
}

export async function updateCase(_id: string, _patch: Partial<CaseRecord>): Promise<void> {
  throw new Error("db.updateCase: not implemented (P0 stub)");
}
