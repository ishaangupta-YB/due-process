import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { z } from "zod";
import { generateAnswerDraft } from "@/lib/documents";

// POST /api/document — { caseId } -> { ok, r2Key, downloadUrl }.
// Generates a DRAFT UD-105 Answer, watermarked, stored in R2 (DOCS_BUCKET). Drafts only —
// never filed (CLAUDE.md §1.5). The deadline/legal content is grounded; nothing fabricated.
const BodySchema = z.object({ caseId: z.string().min(1) });

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }

  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: "caseId is required" },
      { status: 400 },
    );
  }

  try {
    const { r2Key, downloadUrl } = await generateAnswerDraft({ caseId: parsed.data.caseId });
    return NextResponse.json({ ok: true, r2Key, downloadUrl });
  } catch (err) {
    const message = err instanceof Error ? err.message : "failed to generate draft";
    const status = /not found/i.test(message) ? 404 : 500;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}

// GET /api/document?key=<r2Key> — stream the stored draft PDF back to the user.
export async function GET(request: Request): Promise<Response> {
  const key = new URL(request.url).searchParams.get("key");
  if (!key) {
    return NextResponse.json({ ok: false, error: "key is required" }, { status: 400 });
  }

  let bucket: R2Bucket | undefined;
  try {
    const { env } = getCloudflareContext();
    bucket = (env as { DOCS_BUCKET?: R2Bucket }).DOCS_BUCKET;
  } catch {
    return NextResponse.json({ ok: false, error: "storage unavailable" }, { status: 500 });
  }
  if (!bucket) {
    return NextResponse.json({ ok: false, error: "storage unavailable" }, { status: 500 });
  }

  const object = await bucket.get(key);
  if (!object) {
    return NextResponse.json({ ok: false, error: "draft not found" }, { status: 404 });
  }

  const filename = key.split("/").pop() ?? "ud-105-answer-draft.pdf";
  return new Response(object.body, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
