// lib/models.ts — slugs CONFIRMED against developers.cloudflare.com/workers-ai/models (re-confirm only the K2.7 upgrade).
export const MODELS = {
  // Multimodal vision: read the eviction notice image -> structured facts. CONFIRMED.
  VISION: process.env.MODEL_VISION ?? "@cf/meta/llama-4-scout-17b-16e-instruct",
  // High-reasoning grounded answers + document drafting. CONFIRMED (vision + structured outputs).
  // Upgrade to "@cf/moonshotai/kimi-k2.7" ONLY after confirming a NON-code k2.7 slug exists.
  // "@cf/moonshotai/kimi-k2.7-code" is a coding-tuned variant — do NOT use it for legal prose.
  REASONING: process.env.MODEL_REASONING ?? "@cf/moonshotai/kimi-k2.6",
  // Fallback reasoning (TEXT-ONLY; gpt-oss accepts Chat Completions `messages` and Responses API). CONFIRMED.
  REASONING_FALLBACK: process.env.MODEL_REASONING_FALLBACK ?? "@cf/openai/gpt-oss-120b",
  // Speech-to-text (enhancement). Whisper = transcription. CONFIRMED.
  STT: process.env.MODEL_STT ?? "@cf/openai/whisper",
  // Better multilingual ASR (Hindi, Spanish, etc.) for voice intake. CONFIRMED.
  STT_MULTILINGUAL: process.env.MODEL_STT_MULTI ?? "@cf/deepgram/nova-3",
  // Translation (enhancement). CONFIRMED.
  TRANSLATE: process.env.MODEL_TRANSLATE ?? "@cf/meta/m2m100-1.2b",
} as const;

// OPTIONAL external vision fallback via Nebius AI Studio (user has ~$26 credit). Use ONLY if
// Workers AI multimodal input proves finicky. Routed outside the `AI` binding via NEBIUS_API_KEY.
// Confirm the exact Nebius vision model id (e.g. a Qwen-VL) before wiring; do not assume.
export const NEBIUS_VISION_FALLBACK = process.env.NEBIUS_VISION_MODEL ?? null;
