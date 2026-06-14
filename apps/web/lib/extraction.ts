// lib/extraction.ts — multimodal notice image/text -> NoticeFacts (MODELS.VISION).
//
// PERCEPTION ONLY (CLAUDE.md §1.3): this module reads the document and reports the
// facts it can observe. It NEVER computes the response deadline, NEVER infers legal
// conclusions, and NEVER guesses an identifier or date. Deadline math lives in
// lib/deadline-engine.ts (P1-B). If the service date cannot be read, serviceDateISO
// stays null and "serviceDateISO" is listed in unreadableFields.
//
// Llama 4 Scout is natively multimodal and takes Chat-Completions content parts
// (an `image_url` part with a base64 data URL), per the model page in CLAUDE.md §9:
//   https://developers.cloudflare.com/workers-ai/models/llama-4-scout-17b-16e-instruct/
// Structured output is forced with `guided_json` and temperature is held low.
//
// Model output is validated with zod BEFORE returning. On any failure (bad JSON,
// schema mismatch, model/network error) we return a safe low-confidence result with
// the failure recorded in unreadableFields — we never throw raw model text to callers.

import { z } from "zod";
import { MODELS } from "./models";
import type { NoticeFacts, ServiceMethod } from "./types";

export interface ExtractionInput {
  imageBase64?: string;
  text?: string;
  language?: string;
}

/** Minimal shape of the Workers AI binding we depend on — keeps this module mockable. */
export interface AiLike {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}

/** Optional dependencies; in production we resolve the AI binding from the CF context. */
export interface ExtractionDeps {
  ai?: AiLike;
}

const SERVICE_METHODS = ["personal", "substituted", "posted_mail", "unknown"] as const;

// JSON schema handed to the model via `guided_json` to constrain its output. The model
// only reports observable facts; jurisdiction is fixed to CA by this product and is set
// in code, not trusted from the model.
const GUIDED_JSON = {
  type: "object",
  additionalProperties: false,
  properties: {
    noticeType: { type: "string" },
    serviceDateISO: { type: ["string", "null"] },
    serviceMethod: { type: "string", enum: SERVICE_METHODS },
    parties: {
      type: "object",
      additionalProperties: false,
      properties: {
        landlord: { type: ["string", "null"] },
        tenant: { type: ["string", "null"] },
      },
    },
    statedReason: { type: ["string", "null"] },
    extractionConfidence: { type: "number" },
    unreadableFields: { type: "array", items: { type: "string" } },
  },
  required: [
    "noticeType",
    "serviceDateISO",
    "serviceMethod",
    "parties",
    "statedReason",
    "extractionConfidence",
    "unreadableFields",
  ],
} as const;

// Zod schema mirroring the model contract. Lenient about empty strings / nullables so a
// single soft field doesn't nuke the whole extraction, but never invents values.
const ModelOutputSchema = z.object({
  noticeType: z.string(),
  serviceDateISO: z.string().nullable().optional(),
  serviceMethod: z.string().optional(),
  parties: z
    .object({
      landlord: z.string().nullable().optional(),
      tenant: z.string().nullable().optional(),
    })
    .optional(),
  statedReason: z.string().nullable().optional(),
  extractionConfidence: z.number().optional(),
  unreadableFields: z.array(z.string()).optional(),
});

const SYSTEM_PROMPT = [
  "You are a careful document-reading assistant for a California (USA) eviction-help tool.",
  "Read the attached court document image and/or the user's text and extract ONLY facts",
  "that are directly observable. This is a perception task, not legal analysis.",
  "STRICT RULES:",
  "- Do NOT infer legal conclusions. Do NOT compute or mention any deadline.",
  "- Do NOT guess. If a field is not clearly readable, return null for it (or omit a party",
  "  name) and add that field's name to unreadableFields.",
  '- serviceDateISO is the date the tenant was SERVED, formatted "YYYY-MM-DD". Only fill it',
  '  if the document clearly states it; otherwise return null and add "serviceDateISO" to',
  "  unreadableFields. Never invent or approximate a date.",
  "- serviceMethod must be one of: personal, substituted, posted_mail, unknown. Use unknown",
  "  if it is not clearly indicated.",
  "- statedReason is the landlord's stated reason (e.g. nonpayment of rent) verbatim/paraphrased,",
  "  or null if not stated.",
  "- extractionConfidence is your overall confidence from 0 to 1 that the facts are correct.",
  "Respond with ONLY a JSON object with EXACTLY these keys (no extra keys, no markdown fences, no prose):",
  '{"noticeType": string, "serviceDateISO": "YYYY-MM-DD" or null, "serviceMethod": one of "personal"|"substituted"|"posted_mail"|"unknown", "parties": {"landlord": string or null, "tenant": string or null}, "statedReason": string or null, "extractionConfidence": number between 0 and 1, "unreadableFields": array of strings}',
].join("\n");

/**
 * Extract structured NoticeFacts from an uploaded eviction-notice image and/or text.
 * Always returns a zod-valid NoticeFacts; never throws raw model output to the caller.
 */
export async function extractNoticeFacts(
  input: ExtractionInput,
  deps: ExtractionDeps = {},
): Promise<NoticeFacts> {
  const { imageBase64, text, language } = input;

  if (!imageBase64 && !text?.trim()) {
    return fallbackFacts("no input provided (neither image nor text)");
  }

  let ai = deps.ai;
  if (!ai) {
    try {
      const { getCloudflareContext } = await import("@opennextjs/cloudflare");
      const { env } = getCloudflareContext();
      ai = (env as { AI?: AiLike }).AI;
    } catch {
      return fallbackFacts("AI binding unavailable (no Cloudflare context)");
    }
  }
  if (!ai) return fallbackFacts("AI binding unavailable");

  const userContent = buildUserContent(imageBase64, text, language);

  let result: unknown;
  try {
    result = await ai.run(MODELS.VISION, {
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userContent },
      ],
      guided_json: GUIDED_JSON,
      temperature: 0,
      max_tokens: 1024,
    });
  } catch (err) {
    return fallbackFacts(`model call failed: ${errMessage(err)}`);
  }

  const rawText = extractResponseText(result);
  if (rawText === null) {
    return fallbackFacts("model returned no readable response");
  }

  // Llama 4 Scout ignores `guided_json` and often wraps its JSON in a ```json code fence,
  // so parse defensively (strip the fence / pull the first {...}) rather than a bare parse.
  let parsedJson: unknown;
  if (typeof rawText === "string") {
    parsedJson = parseJsonLoose(rawText);
    if (parsedJson === null) {
      return fallbackFacts("model output was not valid JSON");
    }
  } else {
    parsedJson = rawText;
  }

  const validated = ModelOutputSchema.safeParse(parsedJson);
  if (!validated.success) {
    return fallbackFacts("model output failed schema validation");
  }

  return normalizeFacts(validated.data);
}

/** Build the user message content: image part (if any) + text instruction. */
function buildUserContent(
  imageBase64: string | undefined,
  text: string | undefined,
  language: string | undefined,
): Array<Record<string, unknown>> {
  const parts: Array<Record<string, unknown>> = [];

  if (imageBase64) {
    parts.push({ type: "image_url", image_url: { url: toDataUrl(imageBase64) } });
  }

  const instructions: string[] = [];
  if (imageBase64) {
    instructions.push("Extract the notice facts from the attached court document image.");
  }
  if (text?.trim()) {
    instructions.push(`The user also described their situation:\n"""${text.trim()}"""`);
  }
  if (language) {
    instructions.push(
      `The user's language is "${language}". Extract proper nouns as written; do not translate names.`,
    );
  }
  parts.push({ type: "text", text: instructions.join("\n\n") });
  return parts;
}

/** Normalize a possibly-bare base64 string into a data URL the model accepts. */
function toDataUrl(imageBase64: string): string {
  if (imageBase64.startsWith("data:")) return imageBase64;
  const mime = sniffImageMime(imageBase64);
  return `data:${mime};base64,${imageBase64}`;
}

function sniffImageMime(base64: string): string {
  if (base64.startsWith("/9j/")) return "image/jpeg";
  if (base64.startsWith("iVBOR")) return "image/png";
  if (base64.startsWith("R0lGOD")) return "image/gif";
  if (base64.startsWith("UklGR")) return "image/webp";
  return "image/jpeg";
}

/** Pull the generated text/object out of a Workers AI text-generation result. */
function extractResponseText(result: unknown): string | object | null {
  if (result == null) return null;
  if (typeof result === "string") return result;
  if (typeof result === "object") {
    const r = result as Record<string, unknown>;
    const response = r.response;
    if (typeof response === "string") return response;
    if (response && typeof response === "object") return response as object;
  }
  return null;
}

/** Parse model text that may be fenced (```json ... ```) or have prose around the object. */
function parseJsonLoose(text: string): unknown | null {
  const cleaned = stripCodeFence(text);
  try {
    return JSON.parse(cleaned);
  } catch {
    const sub = extractFirstJsonObject(cleaned);
    if (!sub) return null;
    try {
      return JSON.parse(sub);
    } catch {
      return null;
    }
  }
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

/** Map validated model output to a safe NoticeFacts, never trusting it blindly. */
function normalizeFacts(data: z.infer<typeof ModelOutputSchema>): NoticeFacts {
  const unreadable = new Set<string>(data.unreadableFields ?? []);

  const noticeType = nonEmpty(data.noticeType) ?? "Unknown notice";

  // Never guess a date: keep only a syntactically + calendrically valid YYYY-MM-DD.
  const rawDate = data.serviceDateISO ?? null;
  const serviceDateISO = isValidISODate(rawDate) ? rawDate : null;
  if (serviceDateISO === null) unreadable.add("serviceDateISO");

  const serviceMethod: ServiceMethod = (SERVICE_METHODS as readonly string[]).includes(
    data.serviceMethod ?? "",
  )
    ? (data.serviceMethod as ServiceMethod)
    : "unknown";
  if (serviceMethod === "unknown" && data.serviceMethod !== "unknown") {
    unreadable.add("serviceMethod");
  }

  const parties: { landlord?: string; tenant?: string } = {};
  const landlord = nonEmpty(data.parties?.landlord ?? undefined);
  const tenant = nonEmpty(data.parties?.tenant ?? undefined);
  if (landlord) parties.landlord = landlord;
  if (tenant) parties.tenant = tenant;

  const statedReason = nonEmpty(data.statedReason ?? undefined) ?? null;

  const extractionConfidence = clamp01(data.extractionConfidence ?? 0.5);

  return {
    noticeType,
    serviceDateISO,
    serviceMethod,
    jurisdiction: "CA",
    parties,
    statedReason,
    extractionConfidence,
    unreadableFields: [...unreadable],
  };
}

/** Safe low-confidence result for any failure path. Records the reason, fabricates nothing. */
function fallbackFacts(reason: string): NoticeFacts {
  return {
    noticeType: "Unknown notice",
    serviceDateISO: null,
    serviceMethod: "unknown",
    jurisdiction: "CA",
    parties: {},
    statedReason: null,
    extractionConfidence: 0,
    unreadableFields: [
      "noticeType",
      "serviceDateISO",
      "serviceMethod",
      "parties",
      "statedReason",
      `extraction_failed: ${reason}`,
    ],
  };
}

function nonEmpty(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (["unknown", "n/a", "none", "null"].includes(trimmed.toLowerCase())) return undefined;
  return trimmed;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function isValidISODate(value: string | null): value is string {
  if (typeof value !== "string") return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const [, y, mo, d] = m;
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return false;
  // Guard against rollover like 2025-02-30 -> March.
  return (
    date.getUTCFullYear() === Number(y) &&
    date.getUTCMonth() + 1 === Number(mo) &&
    date.getUTCDate() === Number(d)
  );
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
