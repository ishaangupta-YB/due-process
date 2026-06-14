// lib/stt.test.ts — STT wrapper against a mocked Workers AI binding.
// No real model calls: we assert the request shape per engine and that the
// transcript is read out of each engine's response format.

import { describe, it, expect, afterEach, vi } from "vitest";
import { transcribeAudio, type AiLike } from "./stt";

// "hello" in base64 — stands in for a short audio clip's bytes.
const SAMPLE_AUDIO = "aGVsbG8=";

interface RunCall {
  model: string;
  input: Record<string, unknown>;
}

function mockAi(response: unknown): { ai: AiLike; calls: RunCall[] } {
  const calls: RunCall[] = [];
  const ai: AiLike = {
    run: async (model, input) => {
      calls.push({ model, input });
      return response;
    },
  };
  return { ai, calls };
}

describe("transcribeAudio", () => {
  afterEach(() => {
    delete process.env.STT_ENGINE;
  });

  it("uses whisper by default and reads { text }", async () => {
    const { ai, calls } = mockAi({ text: "Me sirvieron una demanda de desalojo." });
    const out = await transcribeAudio({ audioBase64: SAMPLE_AUDIO, language: "es" }, { ai });

    expect(out.text).toBe("Me sirvieron una demanda de desalojo.");
    expect(calls).toHaveLength(1);
    expect(calls[0].model).toBe("@cf/openai/whisper");
    // whisper takes a raw byte array.
    expect(Array.isArray(calls[0].input.audio)).toBe(true);
    expect(calls[0].input.audio).toEqual([104, 101, 108, 108, 111]); // "hello"
  });

  it("accepts a data: URL and strips the prefix", async () => {
    const { ai, calls } = mockAi({ text: "hi" });
    await transcribeAudio(
      { audioBase64: `data:audio/webm;base64,${SAMPLE_AUDIO}` },
      { ai },
    );
    expect(calls[0].input.audio).toEqual([104, 101, 108, 108, 111]);
  });

  it("uses nova-3 when STT_ENGINE=nova-3 and reads the Deepgram results shape", async () => {
    process.env.STT_ENGINE = "nova-3";
    const { ai, calls } = mockAi({
      results: {
        channels: [{ alternatives: [{ transcript: "मुझे बेदखली का नोटिस मिला।" }] }],
      },
    });
    const out = await transcribeAudio(
      { audioBase64: SAMPLE_AUDIO, language: "hi", mimeType: "audio/webm" },
      { ai },
    );

    expect(out.text).toBe("मुझे बेदखली का नोटिस मिला।");
    expect(calls[0].model).toBe("@cf/deepgram/nova-3");
    const audio = calls[0].input.audio as { body: unknown; contentType: string };
    expect(audio.contentType).toBe("audio/webm");
    expect(calls[0].input.language).toBe("hi"); // supported -> explicit
  });

  it("nova-3 auto-detects for unsupported languages", async () => {
    process.env.STT_ENGINE = "nova-3";
    const { ai, calls } = mockAi({
      results: { channels: [{ alternatives: [{ transcript: "xin chào" }] }] },
    });
    await transcribeAudio({ audioBase64: SAMPLE_AUDIO, language: "vi" }, { ai });
    expect(calls[0].input.detect_language).toBe(true);
    expect(calls[0].input.language).toBeUndefined();
  });

  it("throws on empty audio", async () => {
    const { ai } = mockAi({ text: "" });
    await expect(transcribeAudio({ audioBase64: "" }, { ai })).rejects.toThrow(/empty audio/);
  });

  it("throws (never fabricates) when the model returns no text", async () => {
    const { ai } = mockAi({ text: "" });
    await expect(
      transcribeAudio({ audioBase64: SAMPLE_AUDIO }, { ai }),
    ).rejects.toThrow(/no text/);
  });
});
