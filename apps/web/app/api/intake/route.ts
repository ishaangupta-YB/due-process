import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { extractNoticeFacts, type ExtractionInput } from "@/lib/extraction";
import { transcribeAudio } from "@/lib/stt";

// POST /api/intake — image (base64 JSON or multipart file), spoken audio, and/or
// { text, language } -> { ok, noticeFacts: NoticeFacts, transcript? } (CLAUDE.md §8).
//
// Voice intake: when audio is supplied we first transcribe it (lib/stt.ts, MODELS.STT)
// and treat the transcript exactly like typed text — extraction is multilingual, and the
// downstream answer pipeline already honors `language`, so a spoken non-English notice
// flows end-to-end. Transcription is PERCEPTION ONLY: it never sets facts or deadlines.
//
// Delegates fact extraction to lib/extraction.ts, which resolves the AI binding from the
// Cloudflare context and always returns a zod-valid NoticeFacts (never raw model output).

const JsonBody = z.object({
  imageBase64: z.string().min(1).optional(),
  audioBase64: z.string().min(1).optional(),
  audioMimeType: z.string().optional(),
  text: z.string().optional(),
  language: z.string().optional(),
});

/** ArrayBuffer -> base64 without Node Buffer (works in the Workers runtime). */
function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000; // avoid arg-count limits on String.fromCharCode
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

interface IntakeFields {
  imageBase64?: string;
  audioBase64?: string;
  audioMimeType?: string;
  text?: string;
  language?: string;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const contentType = req.headers.get("content-type") ?? "";
    let fields: IntakeFields;

    if (contentType.includes("multipart/form-data")) {
      const form = await req.formData();
      const imageFile = form.get("image");
      const audioFile = form.get("audio");
      const text = form.get("text");
      const language = form.get("language");
      fields = {
        imageBase64:
          imageFile instanceof File && imageFile.size > 0
            ? arrayBufferToBase64(await imageFile.arrayBuffer())
            : undefined,
        audioBase64:
          audioFile instanceof File && audioFile.size > 0
            ? arrayBufferToBase64(await audioFile.arrayBuffer())
            : undefined,
        audioMimeType:
          audioFile instanceof File && audioFile.type ? audioFile.type : undefined,
        text: typeof text === "string" ? text : undefined,
        language: typeof language === "string" ? language : undefined,
      };
    } else {
      const parsed = JsonBody.safeParse(await req.json().catch(() => null));
      if (!parsed.success) {
        return NextResponse.json(
          {
            ok: false,
            error:
              "Invalid request body. Expected JSON { imageBase64?, audioBase64?, text?, language? }.",
          },
          { status: 400 },
        );
      }
      fields = parsed.data;
    }

    if (!fields.imageBase64 && !fields.audioBase64 && !fields.text?.trim()) {
      return NextResponse.json(
        { ok: false, error: "Provide an image, audio, or text to extract from." },
        { status: 400 },
      );
    }

    // Voice intake: transcribe first, then treat the transcript like typed text.
    let transcript: string | undefined;
    if (fields.audioBase64) {
      try {
        const result = await transcribeAudio({
          audioBase64: fields.audioBase64,
          mimeType: fields.audioMimeType,
          language: fields.language,
        });
        transcript = result.text;
      } catch (err) {
        const message = err instanceof Error ? err.message : "transcription failed";
        return NextResponse.json(
          { ok: false, error: `We couldn't understand the audio: ${message}` },
          { status: 422 },
        );
      }
    }

    const mergedText = [fields.text?.trim(), transcript?.trim()]
      .filter((s): s is string => !!s)
      .join("\n\n");

    const input: ExtractionInput = {
      imageBase64: fields.imageBase64,
      text: mergedText || undefined,
      language: fields.language,
    };

    if (!input.imageBase64 && !input.text?.trim()) {
      return NextResponse.json(
        { ok: false, error: "We couldn't read anything from your input. Please try again." },
        { status: 422 },
      );
    }

    const noticeFacts = await extractNoticeFacts(input);
    // `transcript` is an additive field (the contract's noticeFacts is unchanged) so the
    // UI can show the user what we heard before they confirm the extracted facts.
    return NextResponse.json({ ok: true, noticeFacts, transcript });
  } catch (err) {
    const message = err instanceof Error ? err.message : "intake failed";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
