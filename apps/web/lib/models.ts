// lib/models.ts — slugs CONFIRMED against developers.cloudflare.com/workers-ai/models (re-confirm only the K2.7 upgrade).
export const MODELS = {
  // Multimodal vision: read the eviction notice image -> structured facts. CONFIRMED.
  VISION: process.env.MODEL_VISION ?? "@cf/meta/llama-4-scout-17b-16e-instruct",
  // Grounded answers + document drafting. Default is llama-3.3-70b (JSON-mode supported,
  // reliable). Switched off "@cf/moonshotai/kimi-k2.6" because it was returning
  // "Capacity temporarily exceeded" (AiError 3040) on live runs AND is not on the Workers AI
  // JSON-mode model list, so response_format wasn't reliably honored. Set MODEL_REASONING back
  // to a kimi slug via env when you specifically want it (and it has capacity).
  REASONING: process.env.MODEL_REASONING ?? "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
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
