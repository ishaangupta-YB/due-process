// lib/stt.ts — speech-to-text for voice intake (MODELS.STT / MODELS.STT_MULTILINGUAL).
//
// PERCEPTION ONLY (CLAUDE.md §1.3): this module turns spoken audio into a text
// transcript. It does NOT extract facts, infer legal conclusions, or compute deadlines —
// the transcript is handed to lib/extraction.ts exactly like typed text would be.
//
// Two engines, both confirmed against the model pages in CLAUDE.md §9:
//   - whisper (@cf/openai/whisper, DEFAULT): natively multilingual, simple output
//     ({ text }). Input is a raw byte array: { audio: number[] }.
//       https://developers.cloudflare.com/workers-ai/models/whisper/
//   - nova-3 (@cf/deepgram/nova-3, opt-in via STT_ENGINE=nova-3): higher-accuracy
//     multilingual ASR. Input { audio: { body, contentType }, detect_language, language? };
//     transcript is nested under results.channels[0].alternatives[0].transcript.
//       https://developers.cloudflare.com/workers-ai/models/nova-3/
//
// Whisper is the safe default because its byte-array input and { text } output are the
// most robust in the Workers runtime. We never fabricate a transcript: on any failure we
// throw a clear error and the caller (api/intake) surfaces it — we do NOT invent words.

import { MODELS } from "./models";

export interface TranscribeInput {
  /** Bare base64 (no data: prefix) or a data URL. */
  audioBase64: string;
  /** MIME type of the audio (e.g. "audio/webm", "audio/mpeg"). Used by the nova-3 engine. */
  mimeType?: string;
  /** Optional BCP-47 language hint (e.g. "es", "hi"). Improves nova-3 accuracy. */
  language?: string;
}

export interface TranscribeResult {
  text: string;
}

/** Minimal shape of the Workers AI binding we depend on — keeps this module mockable. */
export interface AiLike {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}

export interface TranscribeDeps {
  ai?: AiLike;
}

/** Languages nova-3 supports on Workers AI; outside this set we fall back to whisper. */
const NOVA3_LANGS = new Set([
  "en", "es", "fr", "de", "hi", "ru", "pt", "ja", "it", "nl",
]);

/**
 * Transcribe spoken audio to text. Always returns a non-empty transcript or throws.
 * The caller treats the transcript exactly like user-typed text.
 */
export async function transcribeAudio(
  input: TranscribeInput,
  deps: TranscribeDeps = {},
): Promise<TranscribeResult> {
  const bytes = decodeBase64(stripDataUrl(input.audioBase64));
  if (bytes.length === 0) {
    throw new Error("stt: empty audio payload");
  }

  const ai = await resolveAi(deps.ai);

  const engine = (process.env.STT_ENGINE ?? "whisper").toLowerCase();
  if (engine === "nova-3" || engine === "nova3") {
    return transcribeWithNova3(ai, bytes, input);
  }
  return transcribeWithWhisper(ai, bytes);
}

/* ------------------------------------------------------------------ */

async function resolveAi(injected?: AiLike): Promise<AiLike> {
  if (injected) return injected;
  try {
    const { getCloudflareContext } = await import("@opennextjs/cloudflare");
    const { env } = getCloudflareContext();
    const ai = (env as { AI?: AiLike }).AI;
    if (ai) return ai;
  } catch {
    // fall through to a clear error
  }
  throw new Error("stt: AI binding unavailable (no Cloudflare context)");
}

/** whisper: { audio: number[] } -> { text }. Multilingual by default. */
async function transcribeWithWhisper(
  ai: AiLike,
  bytes: Uint8Array,
): Promise<TranscribeResult> {
  const result = await ai.run(MODELS.STT, { audio: Array.from(bytes) });
  const text = readWhisperText(result);
  if (!text) throw new Error("stt: transcription produced no text");
  return { text };
}

/** nova-3: object audio input; transcript nested in the Deepgram results shape. */
async function transcribeWithNova3(
  ai: AiLike,
  bytes: Uint8Array,
  input: TranscribeInput,
): Promise<TranscribeResult> {
  const lang = input.language?.split("-")[0]?.toLowerCase();
  const runInput: Record<string, unknown> = {
    audio: {
      body: Array.from(bytes),
      contentType: input.mimeType ?? "audio/webm",
    },
    smart_format: true,
    punctuate: true,
  };
  // Set the language explicitly when supported, otherwise let nova-3 auto-detect.
  if (lang && NOVA3_LANGS.has(lang)) runInput.language = lang;
  else runInput.detect_language = true;

  const result = await ai.run(MODELS.STT_MULTILINGUAL, runInput);
  const text = readNova3Text(result);
  if (!text) throw new Error("stt: transcription produced no text");
  return { text };
}

/* ------------------------------------------------------------------ */

function readWhisperText(result: unknown): string {
  if (typeof result === "string") return result.trim();
  if (result && typeof result === "object") {
    const r = result as Record<string, unknown>;
    if (typeof r.text === "string") return r.text.trim();
    if (typeof r.response === "string") return r.response.trim();
  }
  return "";
}

function readNova3Text(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  // { results: { channels: [ { alternatives: [ { transcript } ] } ] } }
  const results = (result as { results?: unknown }).results;
  const channels = (results as { channels?: unknown[] } | undefined)?.channels;
  const alt = (channels?.[0] as { alternatives?: unknown[] } | undefined)
    ?.alternatives?.[0] as { transcript?: unknown } | undefined;
  if (typeof alt?.transcript === "string") return alt.transcript.trim();
  // Fallbacks for other possible shapes.
  const r = result as Record<string, unknown>;
  if (typeof r.text === "string") return r.text.trim();
  return "";
}

function stripDataUrl(value: string): string {
  const comma = value.indexOf(",");
  return value.startsWith("data:") && comma !== -1 ? value.slice(comma + 1) : value;
}

/** Decode base64 to bytes without Node Buffer (works in the Workers runtime). */
function decodeBase64(b64: string): Uint8Array {
  const clean = b64.trim();
  if (!clean) return new Uint8Array(0);
  const binary = atob(clean);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
