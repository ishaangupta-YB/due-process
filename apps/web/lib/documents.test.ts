import { describe, it, expect } from "vitest";
import { inflateSync } from "node:zlib";
import {
  generateAnswerDraft,
  buildCaption,
  assembleDefenses,
  renderDraftPdf,
  buildR2Key,
  buildDownloadUrl,
  WATERMARK_TEXT,
  BLANK_MARKER,
  DEFENSE_LABEL,
  type AiLike,
  type DocsBucketLike,
  type RetrieveFn,
} from "./documents";
import type { CaseRecord, NoticeFacts } from "./types";

/* ---- helpers ---- */

function partialFacts(overrides: Partial<NoticeFacts> = {}): NoticeFacts {
  return {
    noticeType: "Summons + Complaint (Unlawful Detainer)",
    serviceDateISO: "2026-06-01",
    serviceMethod: "personal",
    jurisdiction: "CA",
    parties: { tenant: "Jane Doe" }, // landlord intentionally MISSING (partial)
    statedReason: "nonpayment of rent",
    extractionConfidence: 0.8,
    unreadableFields: ["parties.landlord"],
    ...overrides,
  };
}

function caseWith(facts: NoticeFacts | null): CaseRecord {
  return {
    id: "case-123",
    createdAtISO: "2026-06-10T00:00:00.000Z",
    language: "en",
    noticeFacts: facts,
    deadline: null,
    qaHistory: [],
    documentKeys: [],
  };
}

/** Capturing mock R2 bucket. */
function mockBucket() {
  const store = new Map<string, Uint8Array>();
  const bucket: DocsBucketLike = {
    put: async (key, value) => {
      store.set(key, value instanceof Uint8Array ? value : new Uint8Array(value));
      return {};
    },
  };
  return { bucket, store };
}

const sampleChunks = [
  {
    sourceId: "defenses#1",
    title: "Defenses you can use in an eviction case",
    url: "https://selfhelp.courts.ca.gov/eviction-tenant/respond-defenses",
    snippet: "If you paid all the rent or fixed the problem before the deadline, you may have a defense.",
    score: 0.9,
  },
  {
    sourceId: "defenses#2",
    title: "Defenses you can use in an eviction case",
    url: "https://selfhelp.courts.ca.gov/eviction-tenant/respond-defenses",
    snippet: "Warranty of habitability: landlord did not fix serious problems like no heat or broken plumbing.",
    score: 0.85,
  },
];

const mockRetrieve: RetrieveFn = async () => sampleChunks;

/**
 * Decode a PDF for text searching. pdf-lib Flate-compresses content streams, so we also
 * inflate every `stream ... endstream` block and append the decoded text. The raw latin1
 * view is kept too (for the "%PDF" header check and any uncompressed text).
 */
function decode(bytes: Uint8Array): string {
  const buf = Buffer.from(bytes);
  const raw = buf.toString("latin1");
  let out = raw;

  const marker = Buffer.from("stream");
  const endMarker = Buffer.from("endstream");
  let idx = 0;
  while (true) {
    const start = buf.indexOf(marker, idx);
    if (start === -1) break;
    // Skip the "stream" substring inside "endstream".
    if (start >= 3 && buf.subarray(start - 3, start).toString("latin1") === "end") {
      idx = start + marker.length;
      continue;
    }
    const end = buf.indexOf(endMarker, start);
    if (end === -1) break;
    // Stream data begins after "stream" + EOL (CRLF or LF).
    let dataStart = start + marker.length;
    if (buf[dataStart] === 0x0d) dataStart++;
    if (buf[dataStart] === 0x0a) dataStart++;
    const slice = buf.subarray(dataStart, end);
    try {
      const inflated = inflateSync(slice).toString("latin1");
      out += "\n" + inflated + "\n" + decodeHexStrings(inflated);
    } catch {
      // not a flate stream (or trailing whitespace) — ignore
    }
    idx = end + endMarker.length;
  }
  return out;
}

/** pdf-lib renders drawn text as hex string literals `<...>`; decode them to ASCII. */
function decodeHexStrings(content: string): string {
  let out = "";
  for (const match of content.matchAll(/<([0-9A-Fa-f]+)>/g)) {
    const hex = match[1];
    if (hex.length % 2 !== 0) continue;
    out += Buffer.from(hex, "hex").toString("latin1") + " ";
  }
  return out;
}

/* ---- buildCaption (no fabrication) ---- */

describe("buildCaption", () => {
  it("maps known facts and leaves unknowns blank/labeled (no fabrication)", () => {
    const cap = buildCaption(partialFacts());
    expect(cap.defendantTenant).toBe("Jane Doe");
    expect(cap.statedReason).toBe("nonpayment of rent");
    expect(cap.serviceDate).toBe("2026-06-01");
    // landlord was missing -> blank, never invented
    expect(cap.plaintiffLandlord).toBe(BLANK_MARKER);
    // case number is never in NoticeFacts -> always blank
    expect(cap.courtCaseNumber).toBe(BLANK_MARKER);
    expect(cap.jurisdiction).toBe("California");
  });

  it("returns all-blank caption (except jurisdiction) when facts are null", () => {
    const cap = buildCaption(null);
    expect(cap.defendantTenant).toBe(BLANK_MARKER);
    expect(cap.plaintiffLandlord).toBe(BLANK_MARKER);
    expect(cap.noticeType).toBe(BLANK_MARKER);
    expect(cap.statedReason).toBe(BLANK_MARKER);
    expect(cap.serviceDate).toBe(BLANK_MARKER);
    expect(cap.serviceMethod).toBe(BLANK_MARKER);
    expect(cap.courtCaseNumber).toBe(BLANK_MARKER);
  });

  it("blanks an 'unknown' service method rather than fabricating one", () => {
    const cap = buildCaption(partialFacts({ serviceMethod: "unknown" }));
    expect(cap.serviceMethod).toBe(BLANK_MARKER);
  });
});

/* ---- assembleDefenses (grounded + citation enforcement) ---- */

describe("assembleDefenses", () => {
  it("returns [] when no retrieval is available", async () => {
    const out = await assembleDefenses(partialFacts(), {});
    expect(out).toEqual([]);
  });

  it("returns [] when retrieval yields nothing", async () => {
    const out = await assembleDefenses(partialFacts(), { retrieve: async () => [] });
    expect(out).toEqual([]);
  });

  it("falls back to retrieved sources (grounded) when no model is provided", async () => {
    const out = await assembleDefenses(partialFacts(), { retrieve: mockRetrieve });
    expect(out.length).toBeGreaterThan(0);
    for (const d of out) {
      expect(d.citation.url).toContain("selfhelp.courts.ca.gov");
      expect(d.citation.title.length).toBeGreaterThan(0);
    }
  });

  it("uses the model to phrase defenses but enforces citations in code", async () => {
    const ai: AiLike = {
      run: async () => ({
        response: JSON.stringify({
          defenses: [
            { sourceId: "defenses#1", title: "You already paid", plainLanguage: "You paid the rent before the deadline." },
            // This one cites a fabricated source id -> MUST be dropped by citation enforcement.
            { sourceId: "made-up-999", title: "Bogus", plainLanguage: "Some ungrounded claim." },
          ],
        }),
      }),
    };
    const out = await assembleDefenses(partialFacts(), { retrieve: mockRetrieve, ai });
    expect(out.length).toBe(1);
    expect(out[0].title).toBe("You already paid");
    expect(out[0].citation.url).toContain("selfhelp.courts.ca.gov");
  });

  it("falls back to sources when the model output is unusable", async () => {
    const ai: AiLike = { run: async () => ({ response: "not json" }) };
    const out = await assembleDefenses(partialFacts(), { retrieve: mockRetrieve, ai });
    expect(out.length).toBeGreaterThan(0); // fell back to grounded sources
  });
});

/* ---- renderDraftPdf (watermark + content) ---- */

describe("renderDraftPdf", () => {
  it("produces a valid PDF with the watermark and blank markers present", async () => {
    const bytes = await renderDraftPdf({
      caption: buildCaption(partialFacts()),
      defenses: [],
    });
    expect(bytes).toBeInstanceOf(Uint8Array);
    const text = decode(bytes);
    expect(text.startsWith("%PDF")).toBe(true);
    expect(text).toContain(WATERMARK_TEXT);
    // unknown landlord should appear as the blank marker, not a fabricated name
    expect(text).toContain(BLANK_MARKER);
  });

  it("includes the defense label when defenses are present", async () => {
    const bytes = await renderDraftPdf({
      caption: buildCaption(partialFacts()),
      defenses: [
        {
          title: "You already paid",
          plainLanguage: "You paid the rent before the deadline.",
          citation: {
            title: "Defenses you can use in an eviction case",
            url: "https://selfhelp.courts.ca.gov/eviction-tenant/respond-defenses",
          },
        },
      ],
    });
    const text = decode(bytes);
    expect(text).toContain(DEFENSE_LABEL);
  });
});

/* ---- key / url helpers ---- */

describe("key and url helpers", () => {
  it("builds a namespaced, sanitized R2 key", () => {
    const key = buildR2Key("case/../weird id", new Date("2026-06-14T10:20:30.500Z"));
    expect(key.startsWith("drafts/")).toBe(true);
    expect(key.endsWith(".pdf")).toBe(true);
    expect(key).not.toContain("..");
    expect(key).not.toContain(" ");
  });

  it("builds an encoded download URL pointing at GET /api/document", () => {
    const url = buildDownloadUrl("drafts/case-123/ud-105-answer-x.pdf");
    expect(url).toBe("/api/document?key=drafts%2Fcase-123%2Fud-105-answer-x.pdf");
  });
});

/* ---- generateAnswerDraft (end to end with injected deps) ---- */

describe("generateAnswerDraft", () => {
  it("generates a watermarked PDF in R2 and returns a working key + url (partial facts)", async () => {
    const { bucket, store } = mockBucket();
    const result = await generateAnswerDraft(
      { caseId: "case-123" },
      {
        getCase: async () => caseWith(partialFacts()),
        retrieve: mockRetrieve,
        bucket,
        now: () => new Date("2026-06-14T10:20:30.000Z"),
      },
    );

    expect(result.r2Key).toContain("drafts/case-123/");
    expect(result.r2Key.endsWith(".pdf")).toBe(true);
    expect(result.downloadUrl).toBe(buildDownloadUrl(result.r2Key));

    // The PDF actually landed in R2 under the returned key.
    const stored = store.get(result.r2Key);
    expect(stored).toBeInstanceOf(Uint8Array);
    const text = decode(stored!);
    expect(text.startsWith("%PDF")).toBe(true);
    expect(text).toContain(WATERMARK_TEXT);
    // Unknown landlord is blank, not fabricated.
    expect(text).toContain(BLANK_MARKER);
  });

  it("throws when the case does not exist", async () => {
    const { bucket } = mockBucket();
    await expect(
      generateAnswerDraft(
        { caseId: "missing" },
        { getCase: async () => null, bucket },
      ),
    ).rejects.toThrow(/not found/i);
  });

  it("throws when caseId is empty", async () => {
    await expect(
      generateAnswerDraft({ caseId: "  " }, { getCase: async () => caseWith(null) }),
    ).rejects.toThrow(/caseId is required/i);
  });

  it("works with no AI binding (defenses fall back to grounded sources)", async () => {
    const { bucket, store } = mockBucket();
    const result = await generateAnswerDraft(
      { caseId: "case-123" },
      { getCase: async () => caseWith(partialFacts()), retrieve: mockRetrieve, bucket },
    );
    const text = decode(store.get(result.r2Key)!);
    expect(text).toContain(DEFENSE_LABEL);
  });

  it("throws if no R2 bucket is available", async () => {
    await expect(
      generateAnswerDraft(
        { caseId: "case-123" },
        { getCase: async () => caseWith(partialFacts()), retrieve: async () => [] },
      ),
    ).rejects.toThrow(/DOCS_BUCKET/i);
  });
});
