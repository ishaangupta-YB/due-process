// lib/grounding.ts — retrieve -> answer/abstain + citation enforcement.
//
// SAFETY HEART OF THE PRODUCT (CLAUDE.md §1.2): cite or abstain. Every substantive
// legal statement returned to the user MUST be backed by a citation to a retrieved
// source. If retrieval confidence is low, the question is out of corpus, or the model
// fails to ground its claims, we return { status: "abstained" } with a legal-aid
// referral. We NEVER guess and we NEVER call the model to "try anyway" once we've
// decided retrieval is too weak. The referral is ALWAYS present.
//
// Citation enforcement is done in CODE, never by trusting the model:
//   - the model only tells us WHICH retrieved sources it relied on (by number);
//   - we rebuild every Citation from the retrieved chunk metadata, so a citation
//     URL can only ever be a real, indexed source URL — never something the model
//     invented (CLAUDE.md §1.4);
//   - if an "answered" response ends up with zero valid citations, we DOWNGRADE it
//     to "abstained" rather than show an uncited legal claim.
//
// Structured model output is requested via the documented Workers AI JSON Mode
// (`response_format` with a `json_schema`), per
//   https://developers.cloudflare.com/workers-ai/features/json-mode/
// but we still parse defensively and abstain on ANY failure — abstention is the
// safe default for a legal tool.

import { z } from "zod";
import { MODELS } from "./models";
import type { GroundedAnswer, Citation } from "./types";
import type { RetrievedChunk } from "./ai-search";

export interface GroundingInput {
  questionText: string;
  language?: string;
  /** Optional prior Q&A / case context to help with follow-ups. NEVER a citable source. */
  priorContext?: string;
}

/** Minimal shape of the Workers AI binding we depend on — keeps this module mockable. */
export interface AiLike {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}

export type RetrieveFn = (query: string, k?: number) => Promise<RetrievedChunk[]>;

/** Optional dependencies; in production we resolve them from the Cloudflare context. */
export interface GroundingDeps {
  ai?: AiLike;
  retrieve?: RetrieveFn;
}

/* ------------------------------------------------------------------ */
/* Configuration (all tunable via env without code changes).           */

// How many chunks to retrieve.
const TOP_K = numEnv("GROUNDING_TOP_K", 5);
// Minimum best-chunk score required before we even attempt to answer. Below this we
// abstain WITHOUT calling the model. AI Search already applies its own match_threshold;
// this is an additional confidence gate. Tune per the deployed index's score scale.
const MIN_SCORE = numEnv("GROUNDING_MIN_SCORE", 0.5);
// Citation snippets must be short, paraphrase-safe excerpts (CLAUDE.md §7).
const MAX_SNIPPET_WORDS = 25;

// Legal-aid handoff — ALWAYS present on every GroundedAnswer (answered or abstained).
// The URL is a real, official California Courts self-help page (verified, not fabricated).
const REFERRAL: GroundedAnswer["referral"] = {
  text:
    "DueProcess provides legal information and document preparation, not legal advice, " +
    "and is not your lawyer. For advice about your specific situation, contact a licensed " +
    "attorney or a free legal-aid clinic.",
  url:
    process.env.GROUNDING_REFERRAL_URL ??
    "https://selfhelp.courts.ca.gov/eviction-tenant",
};

// Appended to every answered response so the disclaimer travels with the text.
const NOT_A_LAWYER_NOTE =
  "\n\n---\n*This is legal information, not legal advice, and DueProcess is not your " +
  "lawyer. Laws change and your situation may differ — confirm with a licensed attorney " +
  "or a free legal-aid clinic before you act.*";

/* ------------------------------------------------------------------ */
/* Model contract.                                                     */

// The model reports WHICH sources it used (by 1-based number); it does NOT supply URLs.
// We reconstruct citations from the retrieved chunks ourselves.
const RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: { type: "string", enum: ["answered", "abstained"] },
    answer: { type: "string" },
    citedSources: { type: "array", items: { type: "integer" } },
    abstainReason: { type: "string" },
  },
  required: ["status", "answer", "citedSources", "abstainReason"],
} as const;

const ModelOutSchema = z.object({
  status: z.enum(["answered", "abstained"]).optional(),
  answer: z.string().optional(),
  // Be lenient: some models emit numbers, some numeric strings.
  citedSources: z.array(z.union([z.number(), z.string()])).optional(),
  abstainReason: z.string().optional(),
});

function systemPrompt(language?: string): string {
  const lang = language?.trim()
    ? `the user's language ("${language.trim()}")`
    : "the same language the question is written in";
  return [
    "You are a careful legal-information assistant for California (USA) tenants facing an",
    "eviction (unlawful detainer). You are NOT a lawyer and must never claim to be one.",
    "",
    "You will receive the user's QUESTION and a numbered list of SOURCES retrieved from",
    "official California legal materials (statutes, court self-help pages, official forms).",
    "",
    "STRICT RULES:",
    '- Answer ONLY using the provided SOURCES. Do NOT use outside or training knowledge.',
    '- If the SOURCES do not contain enough information to answer the question, you MUST set',
    '  status to "abstained" and briefly explain why in abstainReason. Do NOT guess and do',
    "  NOT answer anyway.",
    "- Every factual or legal statement in your answer must be supported by at least one of",
    "  the provided SOURCES. List the source NUMBERS you relied on in citedSources.",
    "- Do NOT compute or state a specific calendar deadline date; the application computes",
    "  deadlines separately. You may describe the rules from the sources (e.g. the number of",
    "  court days to respond).",
    `- Use plain, simple language a non-lawyer can understand. Reply in ${lang}.`,
    "- Be concise.",
    "",
    "Respond with ONLY a JSON object matching the provided schema. No prose outside the JSON.",
  ].join("\n");
}

/* ------------------------------------------------------------------ */
/* Public API.                                                         */

/**
 * Answer a tenant's question using ONLY grounded, cited California legal sources,
 * or abstain (with a legal-aid referral) when it cannot do so safely.
 * Always returns a valid GroundedAnswer; never throws to the caller.
 */
export async function answerQuestion(
  input: GroundingInput,
  deps: GroundingDeps = {},
): Promise<GroundedAnswer> {
  const question = input.questionText?.trim();
  if (!question) return abstain("No question was provided.");

  // 1) Retrieve. Any retrieval failure -> abstain (never answer blind).
  let retrieveFn = deps.retrieve;
  if (!retrieveFn) {
    try {
      const mod = await import("./ai-search");
      retrieveFn = mod.retrieve;
    } catch {
      return abstain(
        "We couldn't reach the legal-sources search right now. Please try again or contact legal aid.",
      );
    }
  }

  let chunks: RetrievedChunk[];
  try {
    chunks = await retrieveFn(question, TOP_K);
  } catch {
    return abstain(
      "We couldn't search the California legal sources right now. Please try again or contact legal aid.",
    );
  }

  // 2) Confidence gate. Only consider chunks that carry a real source URL + text.
  const usable = (chunks ?? []).filter(
    (c) => c && c.url && c.snippet && Number.isFinite(c.score),
  );
  const bestScore = usable.reduce((m, c) => Math.max(m, c.score), 0);

  if (usable.length === 0 || bestScore < MIN_SCORE) {
    // Out of corpus / low confidence: abstain WITHOUT calling the model.
    return abstain(
      "This question doesn't appear to be covered by our California eviction legal sources, " +
        "so we can't answer it reliably.",
    );
  }

  // 3) Resolve the reasoning model binding.
  let ai = deps.ai;
  if (!ai) {
    try {
      const { getCloudflareContext } = await import("@opennextjs/cloudflare");
      const { env } = getCloudflareContext();
      ai = (env as { AI?: AiLike }).AI;
    } catch {
      ai = undefined;
    }
  }
  if (!ai) {
    return abstain("The answering service is unavailable right now. Please contact legal aid.");
  }

  // 4) Ask the model to answer strictly from the sources (or abstain).
  const sourcesText = usable.map((c, i) => formatSource(i + 1, c)).join("\n\n");
  const userContent = buildUserPrompt(question, input.priorContext, sourcesText);

  let raw: unknown;
  try {
    raw = await ai.run(MODELS.REASONING, {
      messages: [
        { role: "system", content: systemPrompt(input.language) },
        { role: "user", content: userContent },
      ],
      response_format: { type: "json_schema", json_schema: RESPONSE_SCHEMA },
      temperature: 0,
      max_tokens: 1024,
    });
  } catch {
    return abstain("We couldn't generate a grounded answer right now. Please contact legal aid.");
  }

  const parsed = parseModelJson(raw);
  if (!parsed) {
    return abstain("We couldn't produce a reliable, grounded answer for this question.");
  }

  if (parsed.status === "abstained") {
    return abstain(
      nonEmpty(parsed.abstainReason) ??
        "The available sources don't contain enough information to answer this question.",
    );
  }

  const answerText = nonEmpty(parsed.answer);
  if (!answerText) {
    return abstain("The model did not return an answer, so we are not guessing.");
  }

  // 5) ENFORCEMENT (in code, not by trusting the model): rebuild citations from the
  //    retrieved chunks. An answered response with zero valid citations is DOWNGRADED.
  const citations = buildCitations(parsed.citedSources, usable);
  if (citations.length === 0) {
    return abstain(
      "We can't show this answer because it wasn't backed by a citation to one of our sources.",
    );
  }

  return {
    status: "answered",
    answerMarkdown: answerText + NOT_A_LAWYER_NOTE,
    citations,
    referral: REFERRAL,
  };
}

/* ------------------------------------------------------------------ */
/* Helpers.                                                            */

/** Build a safe abstained answer. Fabricates nothing; referral always present. */
function abstain(reason: string): GroundedAnswer {
  return {
    status: "abstained",
    citations: [],
    abstainReason: reason,
    referral: REFERRAL,
  };
}

/**
 * Map the model's cited source NUMBERS to real Citations built from retrieved chunks.
 * Only sources that actually exist in the retrieved set (and carry a URL) survive — so a
 * citation URL is always a real, indexed source URL and can never be model-fabricated.
 */
function buildCitations(
  cited: Array<number | string> | undefined,
  chunks: RetrievedChunk[],
): Citation[] {
  const indices = new Set<number>();
  for (const ref of cited ?? []) {
    const n = typeof ref === "number" ? ref : Number.parseInt(ref, 10);
    if (!Number.isFinite(n)) continue;
    const idx = n - 1; // sources are presented 1-based to the model
    if (idx >= 0 && idx < chunks.length) indices.add(idx);
  }

  const out: Citation[] = [];
  for (const idx of [...indices].sort((a, b) => a - b)) {
    const chunk = chunks[idx];
    if (!chunk.url) continue; // never emit a citation without a real source URL
    out.push({
      sourceId: chunk.sourceId,
      sourceTitle: nonEmpty(chunk.title) ?? chunk.url,
      url: chunk.url,
      snippet: truncateWords(chunk.snippet, MAX_SNIPPET_WORDS),
    });
  }
  return out;
}

function formatSource(n: number, chunk: RetrievedChunk): string {
  const title = nonEmpty(chunk.title) ?? chunk.url;
  return `[${n}] ${title} (${chunk.url})\n${chunk.snippet}`;
}

function buildUserPrompt(
  question: string,
  priorContext: string | undefined,
  sourcesText: string,
): string {
  const parts: string[] = [];
  const ctx = nonEmpty(priorContext);
  if (ctx) {
    parts.push(
      `PRIOR CONTEXT (background only — NOT a source you may cite):\n${ctx}`,
    );
  }
  parts.push(`QUESTION:\n${question}`);
  parts.push(`SOURCES:\n${sourcesText}`);
  parts.push(
    "Answer ONLY from the SOURCES above and cite the source numbers you used. " +
      "If the SOURCES do not answer the question, abstain.",
  );
  return parts.join("\n\n");
}

/** Pull and JSON-parse the model output defensively. Returns null on any failure. */
function parseModelJson(result: unknown): z.infer<typeof ModelOutSchema> | null {
  const text = extractResponseText(result);
  if (text === null) return null;

  let json: unknown;
  if (typeof text === "string") {
    const cleaned = stripCodeFence(text);
    try {
      json = JSON.parse(cleaned);
    } catch {
      const sub = extractFirstJsonObject(cleaned);
      if (!sub) return null;
      try {
        json = JSON.parse(sub);
      } catch {
        return null;
      }
    }
  } else {
    json = text;
  }

  const parsed = ModelOutSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

/** Pull the generated text/object out of a Workers AI / OpenAI-compatible result. */
function extractResponseText(result: unknown): string | object | null {
  if (result == null) return null;
  if (typeof result === "string") return result;
  if (typeof result !== "object") return null;
  const r = result as Record<string, unknown>;
  if (typeof r.response === "string") return r.response;
  if (r.response && typeof r.response === "object") return r.response as object;
  const choices = r.choices as
    | Array<{ message?: { content?: unknown } }>
    | undefined;
  const content = choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  return null;
}

function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return fence ? fence[1].trim() : trimmed;
}

function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return text.slice(start, end + 1);
}

function truncateWords(text: string, maxWords: number): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return words.join(" ");
  return words.slice(0, maxWords).join(" ") + "…";
}

function nonEmpty(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function numEnv(name: string, def: number): number {
  const v = process.env[name];
  if (!v) return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}
