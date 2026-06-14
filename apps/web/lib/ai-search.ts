// lib/ai-search.ts — Cloudflare AI Search (RAG) retrieval wrapper.
// Uses the namespace binding configured in wrangler.jsonc (ai_search_namespaces).
//
// Retrieval type is VECTOR (semantic) — the `dueprocess-prod` instance is created with
// keyword indexing DISABLED (index_method.keyword=false), so requesting "hybrid" throws
// AI Search error 7070 ("retrieval_type 'hybrid' is not available: keyword indexing is
// disabled"). To re-enable hybrid (semantic + BM25), recreate the instance with keyword
// indexing on, then set this back to "hybrid". Vector-only retrieves the CA corpus well
// (in-corpus questions score ~0.6+, out-of-corpus ~0.4).

import { getCloudflareContext } from "@opennextjs/cloudflare";

/**
 * A single retrieved chunk with real source metadata.
 * `url` and `title` come from the indexed item metadata — never synthesized.
 */
export interface RetrievedChunk {
  sourceId: string;
  title: string;
  url: string;
  snippet: string;
  score: number;
}

/* ------------------------------------------------------------------ */
// Thin type shim for the AI Search namespace binding (avoids hand-writing
// the full generated Env interface). Public API remains fully typed.

interface AiSearchChunk {
  id: string;
  text: string;
  score: number;
  item: {
    key: string;
    metadata: Record<string, string>;
  };
}

interface AiSearchInstance {
  search(opts: {
    messages: Array<{ role: string; content: string }>;
    query?: string;
    ai_search_options?: {
      retrieval?: {
        retrieval_type?: "vector" | "keyword" | "hybrid";
        max_num_results?: number;
        match_threshold?: number;
        filters?: Record<string, unknown>;
        metadata_only?: boolean;
      };
    };
  }): Promise<{
    search_query: string;
    chunks: AiSearchChunk[];
  }>;
}

interface AiSearchNamespaceBinding {
  get(name: string): AiSearchInstance;
}

/* ------------------------------------------------------------------ */
// The instance name must match the one created by scripts/upload-corpus.ts.
// If you change it in one place, change it in the other.
const INSTANCE_NAME = "dueprocess-prod";

/**
 * Retrieve relevant chunks from the CA legal corpus via Cloudflare AI Search.
 *
 * @param query — natural-language question
 * @param k     — max results to return (default 5)
 * @returns typed chunks with real `url` and `title` from source metadata
 */
export async function retrieve(
  query: string,
  k?: number
): Promise<RetrievedChunk[]> {
  const { env } = getCloudflareContext();

  // Extract the namespace binding. The wrangler.jsonc names it "AI_SEARCH".
  const binding = (env as Record<string, unknown>)
    .AI_SEARCH as AiSearchNamespaceBinding;
  if (!binding) {
    throw new Error(
      "ai-search.retrieve: AI_SEARCH binding missing. Check wrangler.jsonc."
    );
  }

  const instance = binding.get(INSTANCE_NAME);

  const results = await instance.search({
    messages: [{ role: "user", content: query }],
    ai_search_options: {
      retrieval: {
        // VECTOR only — see header note. "hybrid" throws on this index (keyword disabled).
        retrieval_type: "vector",
        max_num_results: k ?? 5,
        match_threshold: 0.4,
      },
    },
  });

  return results.chunks.map((chunk) => ({
    sourceId: chunk.id,
    title: chunk.item.metadata.title ?? chunk.item.key ?? "",
    url: chunk.item.metadata.url ?? "",
    snippet: chunk.text ?? "",
    score: chunk.score ?? 0,
  }));
}
