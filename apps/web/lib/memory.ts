// lib/memory.ts — mem0 wrapper (CLAUDE.md §6).
// STUB (P0). Confirm exact mem0 method names against https://docs.mem0.ai before coding.
// Scope all memory by user_id = caseId. Store structured facts only — never raw images
// or full PII blobs. MEM0_API_KEY is a secret, never committed.

export interface MemoryItem {
  kind: "fact" | "deadline" | "qa" | "document";
  text: string;
  metadata?: Record<string, unknown>;
}

export async function addCaseMemory(_caseId: string, _items: MemoryItem[]): Promise<void> {
  throw new Error("memory.addCaseMemory: not implemented (P0 stub)");
}

export async function recallCaseMemory(_caseId: string, _query: string): Promise<MemoryItem[]> {
  throw new Error("memory.recallCaseMemory: not implemented (P0 stub)");
}

export async function getAllCaseMemory(_caseId: string): Promise<MemoryItem[]> {
  throw new Error("memory.getAllCaseMemory: not implemented (P0 stub)");
}
