// lib/memory.ts — mem0 wrapper (CLAUDE.md §6).
// Thin client over the mem0 Platform v3 REST API (verified against
// https://docs.mem0.ai/api-reference/memory/{add,search,get}-memories on 2026-06-14):
//   - add:    POST {base}/v3/memories/add/   body { user_id, messages, metadata, infer }
//   - search: POST {base}/v3/memories/search/ body { query, filters: { user_id }, top_k }
//   - getAll: POST {base}/v3/memories/        body { filters: { user_id } }
// All memory is scoped by user_id = caseId. We store structured facts only — never raw
// images or full PII blobs — and pass `infer: false` so the text we provide is stored
// verbatim (no extra LLM extraction). MEM0_API_KEY is a secret, never committed or logged.

export interface MemoryItem {
  kind: "fact" | "deadline" | "qa" | "document";
  text: string;
  metadata?: Record<string, unknown>;
}

const MEMORY_KINDS = new Set<MemoryItem["kind"]>([
  "fact",
  "deadline",
  "qa",
  "document",
]);

const DEFAULT_BASE_URL = "https://api.mem0.ai";

interface Mem0Result {
  id?: string;
  memory?: string;
  metadata?: Record<string, unknown> | null;
}

/** Resolve mem0 config from the environment. Never logs the key. */
function mem0Config(): { baseUrl: string; apiKey: string } {
  const apiKey = process.env.MEM0_API_KEY;
  if (!apiKey) {
    throw new Error("memory: MEM0_API_KEY is not set.");
  }
  const baseUrl = (process.env.MEM0_BASE_URL ?? DEFAULT_BASE_URL).replace(
    /\/+$/,
    "",
  );
  return { baseUrl, apiKey };
}

async function mem0Request<T>(path: string, body: unknown): Promise<T> {
  const { baseUrl, apiKey } = mem0Config();
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Token ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    // Surface status only — never echo request bodies (may contain case facts).
    throw new Error(`memory: mem0 request to ${path} failed (${res.status}).`);
  }
  return (await res.json()) as T;
}

/** Coerce a raw mem0 result into our MemoryItem shape. */
function toMemoryItem(result: Mem0Result): MemoryItem {
  const metadata = result.metadata ?? undefined;
  const rawKind = metadata?.kind;
  const kind =
    typeof rawKind === "string" && MEMORY_KINDS.has(rawKind as MemoryItem["kind"])
      ? (rawKind as MemoryItem["kind"])
      : "fact";
  return { kind, text: result.memory ?? "", metadata };
}

/**
 * Persist structured case facts to mem0, scoped to user_id = caseId. Each item
 * is stored verbatim (infer: false) with its `kind` recorded in metadata so it
 * can be classified on recall.
 */
export async function addCaseMemory(
  caseId: string,
  items: MemoryItem[],
): Promise<void> {
  if (items.length === 0) return;
  await Promise.all(
    items.map((item) =>
      mem0Request("/v3/memories/add/", {
        user_id: caseId,
        messages: [{ role: "user", content: item.text }],
        metadata: { kind: item.kind, ...(item.metadata ?? {}) },
        infer: false,
      }),
    ),
  );
}

/**
 * Relevance-ranked recall of case memories for a query, scoped to the case.
 */
export async function recallCaseMemory(
  caseId: string,
  query: string,
): Promise<MemoryItem[]> {
  const data = await mem0Request<{ results?: Mem0Result[] }>(
    "/v3/memories/search/",
    { query, filters: { user_id: caseId }, top_k: 20 },
  );
  return (data.results ?? []).map(toMemoryItem);
}

/**
 * Return all stored memories for a case (most recent page).
 */
export async function getAllCaseMemory(caseId: string): Promise<MemoryItem[]> {
  const data = await mem0Request<{ results?: Mem0Result[] }>(
    "/v3/memories/?page=1&page_size=100",
    { filters: { user_id: caseId } },
  );
  return (data.results ?? []).map(toMemoryItem);
}
