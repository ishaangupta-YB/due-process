// lib/documents.ts — draft California UD-105 "Answer — Unlawful Detainer" -> PDF -> R2.
//
// INVARIANTS (CLAUDE.md §1):
//   §1.1 Not a lawyer. The draft states it is document preparation, not legal advice,
//        and directs the user to a licensed attorney / legal-aid clinic.
//   §1.4 No fabricated identifiers. We fill ONLY fields we actually know from the case
//        NoticeFacts. Anything we don't know (case number, court branch, etc.) is left
//        clearly BLANK and labeled — never invented.
//   §1.5 Generated documents are DRAFTS. Every page is watermarked
//        "DRAFT - NOT FILED - review with a legal-aid clinic before filing." We never
//        submit to a court e-filing system.
//
// We deliberately do NOT reproduce the official Judicial Council form's copyrighted
// layout. We generate a clean PLAIN-LANGUAGE draft that maps to the UD-105 fields and
// tells the user to transcribe their answers onto the official form (UD-105) and file
// it with the court (with help from a legal-aid clinic).
//
// The REASONING model is used ONLY to phrase potential defenses in plain language,
// grounded in retrieved corpus chunks. Citation enforcement is done IN CODE: a defense
// is kept only if it cites a `sourceId` that actually came back from retrieval. Every
// defense is labeled "Potential defense to discuss with a legal-aid attorney" and is
// never asserted as legally applicable.

import { PDFDocument, StandardFonts, rgb, degrees, type PDFFont, type PDFPage } from "pdf-lib";
import { z } from "zod";
import type { CaseRecord, NoticeFacts, ServiceMethod } from "./types";
import type { RetrievedChunk } from "./ai-search";

/* ------------------------------------------------------------------ */
/* Public constants (exported so tests and callers share the strings). */

/** Stamped on every page. ASCII-only so it is reliably present in the PDF bytes. */
export const WATERMARK_TEXT =
  "DRAFT - NOT FILED - review with a legal-aid clinic before filing.";

/** Sentinel for any field we do not know. We NEVER fabricate a value (CLAUDE.md §1.4). */
export const BLANK_MARKER = "[ BLANK - fill in from your court papers ]";

/** Every suggested defense carries this label; it is never a legal conclusion. */
export const DEFENSE_LABEL = "Potential defense to discuss with a legal-aid attorney";

/** Official UD-105 form reference shown to the user (real .gov form, from the corpus). */
const OFFICIAL_FORM_URL = "https://www.courts.ca.gov/documents/ud105.pdf";

/* ------------------------------------------------------------------ */
/* Types. */

export interface GenerateAnswerDraftInput {
  caseId: string;
}

export interface GenerateAnswerDraftResult {
  r2Key: string;
  downloadUrl: string;
}

/** Minimal Workers AI shape we depend on — keeps this module mockable. */
export interface AiLike {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}

/** Minimal R2 bucket shape (subset of Cloudflare's R2Bucket) for storing the PDF. */
export interface DocsBucketLike {
  put(
    key: string,
    value: Uint8Array | ArrayBuffer,
    options?: Record<string, unknown>,
  ): Promise<unknown>;
}

/** Retrieval function signature (matches lib/ai-search.ts `retrieve`). */
export type RetrieveFn = (query: string, k?: number) => Promise<RetrievedChunk[]>;

/** Injectable dependencies. In production these resolve from the Cloudflare context. */
export interface GenerateAnswerDraftDeps {
  getCase?: (id: string) => Promise<CaseRecord | null>;
  retrieve?: RetrieveFn;
  ai?: AiLike;
  bucket?: DocsBucketLike;
  now?: () => Date;
  modelReasoning?: string;
}

/** Structured caption fields mapped from NoticeFacts; unknowns are BLANK_MARKER. */
export interface DraftCaption {
  defendantTenant: string;
  plaintiffLandlord: string;
  jurisdiction: string;
  courtCaseNumber: string; // never known from NoticeFacts -> always BLANK_MARKER
  noticeType: string;
  statedReason: string;
  serviceDate: string;
  serviceMethod: string;
}

export interface DraftDefense {
  title: string;
  plainLanguage: string;
  citation: { title: string; url: string };
}

export interface DraftModel {
  caption: DraftCaption;
  defenses: DraftDefense[];
}

/* ------------------------------------------------------------------ */
/* Caption mapping (PURE — unit-testable, fabricates nothing). */

const SERVICE_METHOD_LABELS: Record<ServiceMethod, string> = {
  personal: "Personal service (handed to you in person)",
  substituted: "Substituted service (left with another person / mailed)",
  posted_mail: "Posted and mailed",
  unknown: BLANK_MARKER,
};

/**
 * Map known NoticeFacts onto the UD-105 caption fields. Any value we do not actually
 * have becomes BLANK_MARKER — we never guess a name, date, case number, or court.
 */
export function buildCaption(facts: NoticeFacts | null): DraftCaption {
  return {
    defendantTenant: orBlank(facts?.parties?.tenant),
    plaintiffLandlord: orBlank(facts?.parties?.landlord),
    // Jurisdiction is fixed by this product to California; it is not a fabricated value.
    jurisdiction: "California",
    // The court case number is NEVER present in NoticeFacts. It must be left blank.
    courtCaseNumber: BLANK_MARKER,
    noticeType: orBlank(facts?.noticeType),
    statedReason: orBlank(facts?.statedReason),
    serviceDate: orBlank(facts?.serviceDateISO),
    serviceMethod:
      facts && facts.serviceMethod !== "unknown"
        ? SERVICE_METHOD_LABELS[facts.serviceMethod]
        : BLANK_MARKER,
  };
}

function orBlank(value: string | null | undefined): string {
  if (typeof value !== "string") return BLANK_MARKER;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : BLANK_MARKER;
}

/* ------------------------------------------------------------------ */
/* Grounded defenses (LLM phrases; code enforces citations). */

const DefenseModelSchema = z.object({
  defenses: z
    .array(
      z.object({
        sourceId: z.string(),
        title: z.string(),
        plainLanguage: z.string(),
      }),
    )
    .optional(),
});

const DEFENSE_GUIDED_JSON = {
  type: "object",
  additionalProperties: false,
  properties: {
    defenses: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          sourceId: { type: "string" },
          title: { type: "string" },
          plainLanguage: { type: "string" },
        },
        required: ["sourceId", "title", "plainLanguage"],
      },
    },
  },
  required: ["defenses"],
} as const;

const DEFENSE_SYSTEM_PROMPT = [
  "You help a California tenant DRAFT their Answer (form UD-105) to an eviction lawsuit.",
  "You are NOT a lawyer and must not give legal advice or legal conclusions.",
  "You will be given numbered SOURCE chunks from official California legal self-help text.",
  "Your ONLY job: restate, in plain everyday language, the POTENTIAL defenses described",
  "in those sources, so the tenant can discuss them with a legal-aid attorney.",
  "STRICT RULES:",
  "- Every defense you output MUST be grounded in exactly one provided source. Set",
  "  `sourceId` to that source's id. Do NOT invent a sourceId.",
  "- Do NOT assert that any defense applies to this tenant. Describe it as something to",
  "  consider and raise with an attorney. Never state a legal conclusion.",
  "- Do NOT invent statutes, form box numbers, deadlines, or facts not in the sources.",
  "- Keep each `plainLanguage` to 1-3 short sentences.",
  "Respond with ONLY a JSON object matching the provided schema. No prose.",
].join("\n");

/**
 * Build the list of potential defenses. Retrieval supplies the real sources; the model
 * (if available) phrases them in plain language. Citation enforcement happens here in
 * code: a model defense is kept only if its sourceId matches a retrieved chunk. If the
 * model is unavailable or returns nothing valid, we fall back to the retrieved sources
 * themselves (still fully grounded, never fabricated).
 */
export async function assembleDefenses(
  facts: NoticeFacts | null,
  deps: Pick<GenerateAnswerDraftDeps, "retrieve" | "ai" | "modelReasoning">,
): Promise<DraftDefense[]> {
  const retrieve = deps.retrieve;
  if (!retrieve) return [];

  const query = buildDefenseQuery(facts);
  let chunks: RetrievedChunk[] = [];
  try {
    chunks = await retrieve(query, 6);
  } catch {
    return [];
  }
  if (chunks.length === 0) return [];

  const byId = new Map(chunks.map((c) => [c.sourceId, c]));

  // Try the model first; fall back to raw sources on any problem.
  if (deps.ai) {
    try {
      const modelDefenses = await phraseDefensesWithModel(chunks, deps.ai, deps.modelReasoning);
      const grounded = modelDefenses
        .map((d) => {
          const chunk = byId.get(d.sourceId);
          if (!chunk || !chunk.url) return null; // citation enforcement: drop ungrounded
          return {
            title: d.title.trim() || chunk.title || "Potential defense",
            plainLanguage: d.plainLanguage.trim(),
            citation: { title: chunk.title || chunk.sourceId, url: chunk.url },
          };
        })
        .filter((d): d is DraftDefense => d !== null && d.plainLanguage.length > 0);
      if (grounded.length > 0) return grounded;
    } catch {
      // fall through to source-based fallback
    }
  }

  return fallbackDefensesFromChunks(chunks);
}

function buildDefenseQuery(facts: NoticeFacts | null): string {
  const reason = facts?.statedReason ? ` related to ${facts.statedReason}` : "";
  return `Common defenses a California tenant can raise in an Answer (UD-105) to an unlawful detainer eviction${reason}`;
}

async function phraseDefensesWithModel(
  chunks: RetrievedChunk[],
  ai: AiLike,
  model: string | undefined,
): Promise<Array<{ sourceId: string; title: string; plainLanguage: string }>> {
  const sourcesBlock = chunks
    .map((c) => `SOURCE id="${c.sourceId}" title="${c.title}":\n${c.snippet}`)
    .join("\n\n");

  const { MODELS } = await import("./models");
  const result = await ai.run(model ?? MODELS.REASONING, {
    messages: [
      { role: "system", content: DEFENSE_SYSTEM_PROMPT },
      {
        role: "user",
        content: `Here are the source chunks. Use ONLY these.\n\n${sourcesBlock}`,
      },
    ],
    guided_json: DEFENSE_GUIDED_JSON,
    temperature: 0,
    max_tokens: 1200,
  });

  const raw = extractResponseText(result);
  if (raw === null) return [];
  let parsed: unknown;
  try {
    parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return [];
  }
  const validated = DefenseModelSchema.safeParse(parsed);
  if (!validated.success) return [];
  return validated.data.defenses ?? [];
}

/** Fallback: present retrieved sources directly as potential defenses (still grounded). */
function fallbackDefensesFromChunks(chunks: RetrievedChunk[]): DraftDefense[] {
  return chunks
    .filter((c) => c.url)
    .slice(0, 5)
    .map((c) => ({
      title: c.title || "Potential defense",
      plainLanguage: truncate(c.snippet.trim(), 320),
      citation: { title: c.title || c.sourceId, url: c.url },
    }));
}

/* ------------------------------------------------------------------ */
/* Orchestration. */

/**
 * Generate a DRAFT UD-105 Answer for a case, render it to a watermarked PDF, store it in
 * R2 (DOCS_BUCKET), and return the object key plus a download URL.
 *
 * Drafts only — never filed. Unknown fields are left blank/labeled; nothing is fabricated.
 */
export async function generateAnswerDraft(
  input: GenerateAnswerDraftInput,
  deps: GenerateAnswerDraftDeps = {},
): Promise<GenerateAnswerDraftResult> {
  const caseId = input?.caseId?.trim();
  if (!caseId) throw new Error("generateAnswerDraft: caseId is required");

  const resolved = await resolveDeps(deps);

  const record = await resolved.getCase(caseId);
  if (!record) {
    throw new Error(`generateAnswerDraft: case not found (${caseId})`);
  }

  const caption = buildCaption(record.noticeFacts);
  const defenses = await assembleDefenses(record.noticeFacts, {
    retrieve: resolved.retrieve,
    ai: resolved.ai,
    modelReasoning: deps.modelReasoning,
  });

  const pdfBytes = await renderDraftPdf({ caption, defenses });

  const r2Key = buildR2Key(caseId, resolved.now());
  if (!resolved.bucket) {
    throw new Error("generateAnswerDraft: DOCS_BUCKET binding unavailable");
  }
  await resolved.bucket.put(r2Key, pdfBytes, {
    httpMetadata: { contentType: "application/pdf" },
  });

  return { r2Key, downloadUrl: buildDownloadUrl(r2Key) };
}

interface ResolvedDeps {
  getCase: (id: string) => Promise<CaseRecord | null>;
  retrieve?: RetrieveFn;
  ai?: AiLike;
  bucket?: DocsBucketLike;
  now: () => Date;
}

async function resolveDeps(deps: GenerateAnswerDraftDeps): Promise<ResolvedDeps> {
  const now = deps.now ?? (() => new Date());

  let getCase = deps.getCase;
  if (!getCase) {
    const db = await import("./db");
    getCase = db.getCase;
  }

  let retrieve = deps.retrieve;
  if (!retrieve) {
    try {
      const mod = await import("./ai-search");
      retrieve = mod.retrieve;
    } catch {
      retrieve = undefined;
    }
  }

  let ai = deps.ai;
  let bucket = deps.bucket;
  if (!ai || !bucket) {
    try {
      const { getCloudflareContext } = await import("@opennextjs/cloudflare");
      const { env } = getCloudflareContext();
      const e = env as { AI?: AiLike; DOCS_BUCKET?: DocsBucketLike };
      ai = ai ?? e.AI;
      bucket = bucket ?? e.DOCS_BUCKET;
    } catch {
      // Leave undefined; caller paths handle missing bucket explicitly.
    }
  }

  return { getCase, retrieve, ai, bucket, now };
}

/** R2 key namespaced per case; safe characters only. */
export function buildR2Key(caseId: string, when: Date): string {
  const safeId = caseId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const stamp = when.toISOString().replace(/[:.]/g, "-");
  return `drafts/${safeId}/ud-105-answer-${stamp}.pdf`;
}

/** Relative download URL served by GET /api/document. */
export function buildDownloadUrl(r2Key: string): string {
  return `/api/document?key=${encodeURIComponent(r2Key)}`;
}

/* ------------------------------------------------------------------ */
/* PDF rendering. */

const PAGE_WIDTH = 612; // US Letter, points
const PAGE_HEIGHT = 792;
const MARGIN = 54;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

interface RenderFonts {
  regular: PDFFont;
  bold: PDFFont;
}

/**
 * Render the draft model to a multi-page PDF (Uint8Array). Every page is watermarked.
 * Exported for testing the rendering independently of R2.
 */
export async function renderDraftPdf(model: DraftModel): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle("DRAFT - Answer (Unlawful Detainer) - UD-105");
  pdf.setSubject("Plain-language draft, not legal advice. Not filed.");

  const fonts: RenderFonts = {
    regular: await pdf.embedFont(StandardFonts.Helvetica),
    bold: await pdf.embedFont(StandardFonts.HelveticaBold),
  };

  const writer = new PageWriter(pdf, fonts);

  // Header / title.
  writer.heading("DRAFT - Answer to Eviction Lawsuit (Unlawful Detainer)");
  writer.subheading("Plain-language draft mapped to California Judicial Council form UD-105");

  // Disclaimer (CLAUDE.md §1.1 / §1.5).
  writer.gap(6);
  writer.paragraph(
    "This is NOT legal advice and was not prepared by a lawyer. It is a document-preparation " +
      "draft to help you understand and respond to your case. It has NOT been filed with any court. " +
      "Review it with a licensed attorney or a legal-aid clinic before you do anything.",
    fonts.bold,
  );
  writer.paragraph(
    "To actually respond, you must copy your answers onto the official form UD-105 (Answer - " +
      "Unlawful Detainer) and file it with the court before your deadline. Get the official form at: " +
      OFFICIAL_FORM_URL,
  );

  // Case information section (caption fields).
  writer.gap(8);
  writer.sectionTitle("1. Case information (transcribe onto UD-105)");
  writer.field("Defendant (you, the tenant)", model.caption.defendantTenant);
  writer.field("Plaintiff (the landlord suing you)", model.caption.plaintiffLandlord);
  writer.field("Court / jurisdiction", model.caption.jurisdiction);
  writer.field("Court case number", model.caption.courtCaseNumber);
  writer.field("Notice / lawsuit type", model.caption.noticeType);
  writer.field("Landlord's stated reason", model.caption.statedReason);
  writer.field("Date you were served", model.caption.serviceDate);
  writer.field("How you were served", model.caption.serviceMethod);
  writer.gap(4);
  writer.note(
    "Any field marked " + BLANK_MARKER + " was not found in your documents. Do not guess - " +
      "fill it in yourself from your court papers.",
  );

  // Defenses section.
  writer.gap(8);
  writer.sectionTitle("2. Potential defenses to discuss with a legal-aid attorney");
  if (model.defenses.length === 0) {
    writer.paragraph(
      "No specific defenses were retrieved from the legal sources for your situation. This does " +
        "NOT mean you have no defenses. Discuss possible defenses with a legal-aid attorney before filing.",
    );
  } else {
    writer.paragraph(
      "The items below are POTENTIAL defenses described in official California self-help sources. " +
        "They are not legal conclusions and may or may not apply to you. Discuss each with a legal-aid " +
        "attorney before checking any box on form UD-105.",
    );
    model.defenses.forEach((d, i) => {
      writer.gap(4);
      writer.bullet(`${i + 1}. ${d.title}`, fonts.bold);
      writer.indentedLabel(DEFENSE_LABEL);
      writer.indented(d.plainLanguage);
      writer.indented(`Source: ${d.citation.title} - ${d.citation.url}`);
    });
  }

  // Next steps.
  writer.gap(8);
  writer.sectionTitle("3. Next steps");
  writer.bullet("Do not miss your response deadline. Missing it can cause you to lose automatically.");
  writer.bullet("Transcribe your answers onto the official UD-105 form and file it with the court.");
  writer.bullet("Contact a legal-aid clinic for free help reviewing and filing your Answer.");

  // Watermark every page (after all content is laid out).
  stampWatermark(pdf, fonts);

  // useObjectStreams: false keeps content streams uncompressed so the watermark text is
  // present verbatim in the bytes (also a clean, broadly-compatible PDF).
  return pdf.save({ useObjectStreams: false });
}

/** Helper that lays out wrapped text across as many pages as needed. */
class PageWriter {
  private page: PDFPage;
  private y: number;

  constructor(
    private readonly pdf: PDFDocument,
    private readonly fonts: RenderFonts,
  ) {
    this.page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    this.y = PAGE_HEIGHT - MARGIN - 24; // leave room for the top watermark banner
  }

  private ensureSpace(lineHeight: number): void {
    if (this.y - lineHeight < MARGIN + 28) {
      this.page = this.pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      this.y = PAGE_HEIGHT - MARGIN - 24;
    }
  }

  private drawLines(
    text: string,
    size: number,
    font: PDFFont,
    indent = 0,
    color = rgb(0, 0, 0),
  ): void {
    const maxWidth = CONTENT_WIDTH - indent;
    const lineHeight = size + 4;
    for (const line of wrapText(sanitize(text), font, size, maxWidth)) {
      this.ensureSpace(lineHeight);
      this.page.drawText(line, {
        x: MARGIN + indent,
        y: this.y,
        size,
        font,
        color,
      });
      this.y -= lineHeight;
    }
  }

  heading(text: string): void {
    this.drawLines(text, 16, this.fonts.bold);
  }
  subheading(text: string): void {
    this.drawLines(text, 11, this.fonts.regular, 0, rgb(0.25, 0.25, 0.25));
  }
  sectionTitle(text: string): void {
    this.gap(2);
    this.drawLines(text, 13, this.fonts.bold);
    this.gap(2);
  }
  paragraph(text: string, font: PDFFont = this.fonts.regular): void {
    this.drawLines(text, 10.5, font);
    this.gap(3);
  }
  field(label: string, value: string): void {
    this.drawLines(`${label}: ${value}`, 10.5, this.fonts.regular);
    this.gap(1);
  }
  note(text: string): void {
    this.drawLines(text, 9, this.fonts.regular, 0, rgb(0.4, 0.2, 0.2));
  }
  bullet(text: string, font: PDFFont = this.fonts.regular): void {
    this.drawLines(text, 10.5, font);
  }
  indentedLabel(text: string): void {
    this.drawLines(text, 9.5, this.fonts.bold, 16, rgb(0.15, 0.3, 0.5));
  }
  indented(text: string): void {
    this.drawLines(text, 10, this.fonts.regular, 16);
  }
  gap(points: number): void {
    this.y -= points;
  }
}

/** Draw the DRAFT watermark on every page: a top banner plus a large diagonal stamp. */
function stampWatermark(pdf: PDFDocument, fonts: RenderFonts): void {
  for (const page of pdf.getPages()) {
    const { width, height } = page.getSize();

    // Top banner (full WATERMARK_TEXT, ASCII, present verbatim in bytes).
    page.drawRectangle({
      x: 0,
      y: height - 22,
      width,
      height: 22,
      color: rgb(0.85, 0.12, 0.12),
    });
    page.drawText(WATERMARK_TEXT, {
      x: MARGIN,
      y: height - 16,
      size: 9,
      font: fonts.bold,
      color: rgb(1, 1, 1),
    });

    // Large faint diagonal "DRAFT - NOT FILED" across the page.
    page.drawText("DRAFT - NOT FILED", {
      x: 70,
      y: 250,
      size: 52,
      font: fonts.bold,
      color: rgb(0.92, 0.7, 0.7),
      rotate: degrees(38),
    });

    // Bottom footer repeat.
    page.drawText(WATERMARK_TEXT, {
      x: MARGIN,
      y: 24,
      size: 8,
      font: fonts.regular,
      color: rgb(0.5, 0.5, 0.5),
    });
  }
}

/* ------------------------------------------------------------------ */
/* Text utilities. */

/** Replace non-WinAnsi characters (e.g. smart quotes, em dashes) so StandardFonts can encode them. */
function sanitize(text: string): string {
  return text
    .replace(/[\u2018\u2019\u2032]/g, "'")
    .replace(/[\u201C\u201D\u2033]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/\u00A0/g, " ")
    // Drop anything else outside printable Latin-1.
    .replace(/[^\x20-\x7E\xA1-\xFF]/g, "");
}

/** Greedy word-wrap to a max pixel width for the given font/size. */
function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const rawLine of text.split("\n")) {
    const words = rawLine.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      lines.push("");
      continue;
    }
    let current = "";
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth || !current) {
        // If a single word is too long, hard-break it.
        if (!current && font.widthOfTextAtSize(word, size) > maxWidth) {
          for (const piece of hardBreak(word, font, size, maxWidth)) lines.push(piece);
          current = "";
          continue;
        }
        current = candidate;
      } else {
        lines.push(current);
        current = word;
      }
    }
    if (current) lines.push(current);
  }
  return lines;
}

function hardBreak(word: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const pieces: string[] = [];
  let current = "";
  for (const ch of word) {
    const candidate = current + ch;
    if (font.widthOfTextAtSize(candidate, size) > maxWidth && current) {
      pieces.push(current);
      current = ch;
    } else {
      current = candidate;
    }
  }
  if (current) pieces.push(current);
  return pieces;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3).trimEnd()}...`;
}

/** Pull generated text/object out of a Workers AI text-generation result. */
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
