// scripts/eval-endpoint.ts — THIN EVAL ENDPOINT (dev/offline only; never deployed).
//
// Purpose: expose the SAME production grounding pipeline (lib/grounding.ts) over
// HTTP so apps/eval/run_eval.py can score it, but pointed at the THROWAWAY
// housing_qa eval corpus instead of the production CA corpus. This is the
// "thin eval endpoint" sanctioned by apps/eval/CLAUDE.md ("via the deployed API
// or a thin eval endpoint").
//
// It runs the real answerQuestion() unchanged — same confidence gate, same
// code-enforced citations, same abstain-by-default behavior — and only injects
// the two external dependencies grounding.ts normally resolves from the
// Cloudflare bindings:
//   - retrieve(): Cloudflare AI Search REST search against the EVAL instance.
//   - ai.run():   Cloudflare Workers AI REST run for the reasoning model.
// Both calls hit the exact same Cloudflare services the deployed Worker bindings
// proxy to, so the measured behavior is faithful to production.
//
// SAFETY: targets ONLY the eval namespace/instance from env. It refuses to start
// if the target looks like the production instance (mirrors apps/eval guard).
//
// Run (from apps/web):
//   pnpm dlx tsx scripts/eval-endpoint.ts
// Env required:
//   CF_ACCOUNT_ID, CF_API_TOKEN
//   EVAL_AISEARCH_NAMESPACE   (e.g. dueprocess-eval)
//   EVAL_AISEARCH_INSTANCE    (e.g. dueprocess-housingqa-eval)
// Optional:
//   PORT                      (default 8787)
//   PROD_AISEARCH_INSTANCE    (denylist guard, e.g. dueprocess-prod)
//   EVAL_FALLBACK_MODEL       (used only if the primary reasoning model keeps
//                              returning transient capacity errors)

import http from "node:http";
import { answerQuestion, type AiLike, type RetrieveFn } from "../lib/grounding";
import type { RetrievedChunk } from "../lib/ai-search";

const CF_API_BASE = "https://api.cloudflare.com/client/v4";

function reqEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`[eval-endpoint] missing required env ${name}`);
    process.exit(2);
  }
  return v;
}

const ACCOUNT_ID = reqEnv("CF_ACCOUNT_ID");
const API_TOKEN = reqEnv("CF_API_TOKEN");
const NAMESPACE = reqEnv("EVAL_AISEARCH_NAMESPACE");
const INSTANCE = reqEnv("EVAL_AISEARCH_INSTANCE");
const PORT = Number(process.env.PORT ?? 8787);
const FALLBACK_MODEL = process.env.EVAL_FALLBACK_MODEL || null;

// Guard: never let the eval endpoint point at the production corpus.
const PROD_INSTANCE = process.env.PROD_AISEARCH_INSTANCE?.trim();
if (PROD_INSTANCE && INSTANCE.trim() === PROD_INSTANCE) {
  console.error(
    `[eval-endpoint] refusing to start: EVAL_AISEARCH_INSTANCE (${INSTANCE}) equals PROD_AISEARCH_INSTANCE.`,
  );
  process.exit(2);
}
if (/(prod|production|live)/i.test(INSTANCE)) {
  console.error(`[eval-endpoint] refusing to start: instance '${INSTANCE}' looks like production.`);
  process.exit(2);
}

const authHeaders = { Authorization: `Bearer ${API_TOKEN}`, "Content-Type": "application/json" };

// --- retrieve(): AI Search REST search against the EVAL instance ----------- //
const retrieve: RetrieveFn = async (query: string, k = 5): Promise<RetrievedChunk[]> => {
  const url = `${CF_API_BASE}/accounts/${ACCOUNT_ID}/ai-search/namespaces/${NAMESPACE}/instances/${INSTANCE}/search`;
  const resp = await fetch(url, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ query, rewrite_query: false }),
  });
  if (!resp.ok) throw new Error(`ai-search search failed: ${resp.status} ${await resp.text()}`);
  const json = (await resp.json()) as {
    result?: { chunks?: Array<{ id: string; text?: string; score?: number; item?: { key?: string } }> };
  };
  const chunks = json.result?.chunks ?? [];
  return chunks.slice(0, k).map((c) => ({
    sourceId: c.id,
    // item.key is the indexed filename (e.g. "statute_<idx>__<citation>.txt"); it
    // carries the gold statute idx the eval scorer matches on. Never fabricated.
    title: c.item?.key ?? "",
    // The eval corpus is the reglab/housing_qa dataset; cite the real dataset URL.
    url: "https://huggingface.co/datasets/reglab/housing_qa",
    snippet: c.text ?? "",
    score: typeof c.score === "number" ? c.score : 0,
  }));
};

// --- ai.run(): Workers AI REST, with transient-capacity retries ------------ //
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runModel(model: string, input: Record<string, unknown>): Promise<unknown> {
  const url = `${CF_API_BASE}/accounts/${ACCOUNT_ID}/ai/run/${model}`;
  const resp = await fetch(url, { method: "POST", headers: authHeaders, body: JSON.stringify(input) });
  const json = (await resp.json()) as { success?: boolean; result?: unknown; errors?: Array<{ code?: number; message?: string }> };
  if (resp.ok && json.success) return json.result;
  const msg = json.errors?.map((e) => `${e.code}:${e.message}`).join("; ") || `${resp.status}`;
  const transient = /capacity|temporarily|rate|timeout|503|429|3040/i.test(msg);
  const err = new Error(`workers-ai run failed (${model}): ${msg}`);
  (err as Error & { transient?: boolean }).transient = transient;
  throw err;
}

const ai: AiLike = {
  async run(model: string, input: Record<string, unknown>): Promise<unknown> {
    const maxAttempts = 6;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await runModel(model, input);
      } catch (err) {
        lastErr = err;
        const transient = (err as Error & { transient?: boolean }).transient;
        if (!transient || attempt === maxAttempts) break;
        await sleep(Math.min(8000, 500 * 2 ** (attempt - 1)));
      }
    }
    // Last resort: a configured fallback model (only on persistent transient failure).
    if (FALLBACK_MODEL) {
      console.warn(`[eval-endpoint] primary ${model} exhausted retries; using fallback ${FALLBACK_MODEL}`);
      return runModel(FALLBACK_MODEL, input);
    }
    throw lastErr;
  },
};

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, instance: INSTANCE, namespace: NAMESPACE }));
    return;
  }
  if (req.method !== "POST" || !req.url?.startsWith("/api/answer")) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "not found" }));
    return;
  }
  try {
    const body = JSON.parse((await readBody(req)) || "{}") as {
      questionText?: string;
      language?: string;
    };
    const answer = await answerQuestion(
      { questionText: body.questionText ?? "", language: body.language },
      { ai, retrieve },
    );
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, answer }));
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : "error" }));
  }
});

server.listen(PORT, () => {
  console.log(`[eval-endpoint] listening on http://127.0.0.1:${PORT}/api/answer`);
  console.log(`[eval-endpoint] eval corpus: namespace=${NAMESPACE} instance=${INSTANCE}`);
});
