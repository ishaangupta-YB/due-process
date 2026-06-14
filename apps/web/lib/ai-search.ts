// lib/ai-search.ts — Cloudflare AI Search (RAG) retrieval wrapper.
// STUB (P0). Wave 1 (P1-A) implements this. Confirm the binding name + query API
// against https://developers.cloudflare.com/ai-search/ before coding.

import type { Citation } from "./types";

export interface RetrievalResult {
  citations: Citation[];
  /** Aggregate retrieval confidence, 0..1, used by grounding to answer vs abstain. */
  confidence: number;
}

export async function retrieve(_query: string): Promise<RetrievalResult> {
  throw new Error("ai-search.retrieve: not implemented (P0 stub)");
}
