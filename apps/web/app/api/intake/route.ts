import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { extractNoticeFacts, type ExtractionInput } from "@/lib/extraction";

// POST /api/intake — image (base64 JSON or multipart file) and/or { text, language }
// -> { ok, noticeFacts: NoticeFacts } (CLAUDE.md §8). Delegates perception to
// lib/extraction.ts (P1-C), which resolves the AI binding from the Cloudflare context
// itself and always returns a zod-valid NoticeFacts (never throws raw model output).

const JsonBody = z.object({
  imageBase64: z.string().min(1).optional(),
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

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const contentType = req.headers.get("content-type") ?? "";
    let input: ExtractionInput;

    if (contentType.includes("multipart/form-data")) {
      const form = await req.formData();
      const file = form.get("image");
      const text = form.get("text");
      const language = form.get("language");
      input = {
        imageBase64:
          file instanceof File && file.size > 0
            ? arrayBufferToBase64(await file.arrayBuffer())
            : undefined,
        text: typeof text === "string" ? text : undefined,
        language: typeof language === "string" ? language : undefined,
      };
    } else {
      const parsed = JsonBody.safeParse(await req.json().catch(() => null));
      if (!parsed.success) {
        return NextResponse.json(
          { ok: false, error: "Invalid request body. Expected JSON { imageBase64?, text?, language? }." },
          { status: 400 },
        );
      }
      input = parsed.data;
    }

    if (!input.imageBase64 && !input.text?.trim()) {
      return NextResponse.json(
        { ok: false, error: "Provide an image or text to extract from." },
        { status: 400 },
      );
    }

    const noticeFacts = await extractNoticeFacts(input);
    return NextResponse.json({ ok: true, noticeFacts });
  } catch (err) {
    const message = err instanceof Error ? err.message : "intake failed";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
