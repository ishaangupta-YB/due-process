import { describe, it, expect } from "vitest";
import { extractNoticeFacts, type AiLike } from "./extraction";

// A 1x1 PNG (base64, no data: prefix) standing in for an uploaded summons photo.
const SAMPLE_IMAGE =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/** Minimal mock AI binding that returns a canned Workers AI text-generation result. */
function mockAi(response: unknown): AiLike {
  return {
    run: async () => ({ response }),
  };
}

const SERVICE_METHODS = ["personal", "substituted", "posted_mail", "unknown"];

function expectValidNoticeFacts(facts: unknown) {
  expect(facts).toMatchObject({ jurisdiction: "CA" });
  const f = facts as Record<string, unknown>;
  expect(typeof f.noticeType).toBe("string");
  expect((f.noticeType as string).length).toBeGreaterThan(0);
  expect(f.serviceDateISO === null || typeof f.serviceDateISO === "string").toBe(true);
  expect(SERVICE_METHODS).toContain(f.serviceMethod);
  expect(typeof f.parties).toBe("object");
  expect(f.statedReason === null || typeof f.statedReason === "string").toBe(true);
  expect(typeof f.extractionConfidence).toBe("number");
  expect(f.extractionConfidence as number).toBeGreaterThanOrEqual(0);
  expect(f.extractionConfidence as number).toBeLessThanOrEqual(1);
  expect(Array.isArray(f.unreadableFields)).toBe(true);
}

describe("extractNoticeFacts", () => {
  it("returns valid NoticeFacts from a clean summons extraction (JSON string response)", async () => {
    const ai = mockAi(
      JSON.stringify({
        noticeType: "Summons + Complaint (Unlawful Detainer)",
        serviceDateISO: "2026-06-01",
        serviceMethod: "personal",
        parties: { landlord: "Acme Properties LLC", tenant: "Jane Doe" },
        statedReason: "nonpayment of rent",
        extractionConfidence: 0.9,
        unreadableFields: [],
      }),
    );

    const facts = await extractNoticeFacts({ imageBase64: SAMPLE_IMAGE }, { ai });

    expectValidNoticeFacts(facts);
    expect(facts.serviceDateISO).toBe("2026-06-01");
    expect(facts.serviceMethod).toBe("personal");
    expect(facts.parties.landlord).toBe("Acme Properties LLC");
    expect(facts.parties.tenant).toBe("Jane Doe");
    expect(facts.unreadableFields).not.toContain("serviceDateISO");
  });

  it("accepts an object response (JSON mode) as well as a string", async () => {
    const ai = mockAi({
      noticeType: "Summons + Complaint (Unlawful Detainer)",
      serviceDateISO: "2026-05-20",
      serviceMethod: "substituted",
      parties: { landlord: "Bob" },
      statedReason: null,
      extractionConfidence: 0.7,
      unreadableFields: ["tenant"],
    });

    const facts = await extractNoticeFacts({ imageBase64: SAMPLE_IMAGE }, { ai });
    expectValidNoticeFacts(facts);
    expect(facts.serviceDateISO).toBe("2026-05-20");
    expect(facts.serviceMethod).toBe("substituted");
  });

  it("never guesses a date: nulls an unreadable service date and lists the field", async () => {
    const ai = mockAi(
      JSON.stringify({
        noticeType: "Summons + Complaint (Unlawful Detainer)",
        serviceDateISO: null,
        serviceMethod: "unknown",
        parties: {},
        statedReason: null,
        extractionConfidence: 0.3,
        unreadableFields: ["serviceDateISO"],
      }),
    );

    const facts = await extractNoticeFacts({ imageBase64: SAMPLE_IMAGE }, { ai });
    expectValidNoticeFacts(facts);
    expect(facts.serviceDateISO).toBeNull();
    expect(facts.unreadableFields).toContain("serviceDateISO");
  });

  it("rejects an invalid calendar date and records it as unreadable (no fabrication)", async () => {
    const ai = mockAi(
      JSON.stringify({
        noticeType: "Summons",
        serviceDateISO: "2026-02-30", // not a real date
        serviceMethod: "personal",
        parties: {},
        statedReason: null,
        extractionConfidence: 0.8,
        unreadableFields: [],
      }),
    );

    const facts = await extractNoticeFacts({ imageBase64: SAMPLE_IMAGE }, { ai });
    expectValidNoticeFacts(facts);
    expect(facts.serviceDateISO).toBeNull();
    expect(facts.unreadableFields).toContain("serviceDateISO");
  });

  it("coerces an out-of-range serviceMethod to 'unknown'", async () => {
    const ai = mockAi(
      JSON.stringify({
        noticeType: "Summons",
        serviceDateISO: "2026-01-15",
        serviceMethod: "carrier_pigeon",
        parties: {},
        statedReason: null,
        extractionConfidence: 0.5,
        unreadableFields: [],
      }),
    );

    const facts = await extractNoticeFacts({ imageBase64: SAMPLE_IMAGE }, { ai });
    expectValidNoticeFacts(facts);
    expect(facts.serviceMethod).toBe("unknown");
  });

  it("clamps confidence into 0..1", async () => {
    const ai = mockAi(
      JSON.stringify({
        noticeType: "Summons",
        serviceDateISO: null,
        serviceMethod: "unknown",
        parties: {},
        statedReason: null,
        extractionConfidence: 4.2,
        unreadableFields: [],
      }),
    );
    const facts = await extractNoticeFacts({ imageBase64: SAMPLE_IMAGE }, { ai });
    expect(facts.extractionConfidence).toBe(1);
  });

  it("returns a safe low-confidence result when the model emits non-JSON (never throws)", async () => {
    const ai = mockAi("I'm sorry, I cannot read this document.");
    const facts = await extractNoticeFacts({ imageBase64: SAMPLE_IMAGE }, { ai });
    expectValidNoticeFacts(facts);
    expect(facts.extractionConfidence).toBe(0);
    expect(facts.serviceDateISO).toBeNull();
    expect(facts.unreadableFields.some((u) => u.startsWith("extraction_failed"))).toBe(true);
  });

  it("returns a safe result when the model output fails schema validation", async () => {
    const ai = mockAi(JSON.stringify({ noticeType: 123, serviceMethod: "personal" }));
    const facts = await extractNoticeFacts({ imageBase64: SAMPLE_IMAGE }, { ai });
    expectValidNoticeFacts(facts);
    expect(facts.extractionConfidence).toBe(0);
  });

  it("does not throw when the model call rejects", async () => {
    const ai: AiLike = { run: async () => Promise.reject(new Error("boom")) };
    const facts = await extractNoticeFacts({ imageBase64: SAMPLE_IMAGE }, { ai });
    expectValidNoticeFacts(facts);
    expect(facts.extractionConfidence).toBe(0);
    expect(facts.unreadableFields.some((u) => u.includes("boom"))).toBe(true);
  });

  it("returns a safe result with no input and never calls the model", async () => {
    let called = false;
    const ai: AiLike = {
      run: async () => {
        called = true;
        return { response: "{}" };
      },
    };
    const facts = await extractNoticeFacts({}, { ai });
    expectValidNoticeFacts(facts);
    expect(called).toBe(false);
    expect(facts.extractionConfidence).toBe(0);
  });

  it("works for text-only intake (no image)", async () => {
    const ai = mockAi(
      JSON.stringify({
        noticeType: "Summons + Complaint (Unlawful Detainer)",
        serviceDateISO: "2026-03-10",
        serviceMethod: "personal",
        parties: { tenant: "Maria" },
        statedReason: "nonpayment of rent",
        extractionConfidence: 0.6,
        unreadableFields: [],
      }),
    );
    const facts = await extractNoticeFacts(
      { text: "I got served eviction papers on March 10, 2026 in person.", language: "en" },
      { ai },
    );
    expectValidNoticeFacts(facts);
    expect(facts.serviceDateISO).toBe("2026-03-10");
  });
});
