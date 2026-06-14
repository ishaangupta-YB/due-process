// lib/extraction.ts — multimodal notice image -> NoticeFacts (MODELS.VISION).
// STUB (P0). Wave 1 (P1-C) implements this. Read the llama-4-scout model page for
// the exact image input shape before coding. The LLM extracts facts only; it must
// NEVER compute the deadline (CLAUDE.md §1.3).

import type { NoticeFacts } from "./types";

export interface ExtractionInput {
  imageBase64?: string;
  text?: string;
  language?: string;
}

export async function extractNoticeFacts(_input: ExtractionInput): Promise<NoticeFacts> {
  throw new Error("extraction.extractNoticeFacts: not implemented (P0 stub)");
}
