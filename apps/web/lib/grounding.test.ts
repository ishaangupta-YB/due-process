import { describe, it, expect } from "vitest";
import {
  answerQuestion,
  type AiLike,
  type RetrieveFn,
} from "./grounding";
import type { RetrievedChunk } from "./ai-search";

// A realistic in-corpus chunk: official CA Courts self-help page on responding.
const RESPOND_CHUNK: RetrievedChunk = {
  sourceId: "selfhelp-respond#1",
  title: "Fill out an Answer form in an eviction case",
  url: "https://selfhelp.courts.ca.gov/eviction-tenant/respond",
  snippet:
    "If someone handed the papers to you, you have 10 court days to file your Answer. " +
    "Do not count Saturdays, Sundays, or court holidays.",
  score: 0.82,
};

/** retrieve() mock that returns a fixed set of chunks. */
function mockRetrieve(chunks: RetrievedChunk[]): RetrieveFn {
  return async () => chunks;
}

/** Workers AI mock returning a canned text-generation result ({ response }). */
function mockAi(response: unknown): AiLike {
  return { run: async () => ({ response }) };
}

describe("answerQuestion — cite-or-abstain", () => {
  it("answers an in-corpus question with >= 1 real citation drawn from retrieval", async () => {
    const retrieve = mockRetrieve([RESPOND_CHUNK]);
    const ai = mockAi(
      JSON.stringify({
        status: "answered",
        answer:
          "If you were personally handed the Summons and Complaint, you generally have " +
          "10 court days to file your Answer.",
        citedSources: [1],
        abstainReason: "",
      }),
    );

    const res = await answerQuestion(
      { questionText: "How many days do I have to respond to an eviction?" },
      { ai, retrieve },
    );

    expect(res.status).toBe("answered");
    expect(res.answerMarkdown).toBeTruthy();
    expect(res.citations.length).toBeGreaterThanOrEqual(1);
    // The citation URL must come from the retrieved chunk — never fabricated.
    expect(res.citations[0].url).toBe(RESPOND_CHUNK.url);
    expect(res.citations[0].sourceId).toBe(RESPOND_CHUNK.sourceId);
    // Referral is ALWAYS present.
    expect(res.referral.url).toBeTruthy();
    expect(res.referral.text).toBeTruthy();
  });

  it("abstains on an out-of-corpus question without calling the model", async () => {
    let modelCalled = false;
    const ai: AiLike = {
      run: async () => {
        modelCalled = true;
        return { response: "{}" };
      },
    };
    // Nothing relevant retrieved for a family-law question.
    const retrieve = mockRetrieve([]);

    const res = await answerQuestion(
      { questionText: "Can I get a divorce?" },
      { ai, retrieve },
    );

    expect(res.status).toBe("abstained");
    expect(res.citations).toEqual([]);
    expect(res.abstainReason).toBeTruthy();
    expect(res.referral.url).toBeTruthy();
    // We must NOT "try anyway" once retrieval is too weak.
    expect(modelCalled).toBe(false);
  });

  it("DOWNGRADES an answered response with no citations to abstained (validator enforces in code)", async () => {
    const retrieve = mockRetrieve([RESPOND_CHUNK]);
    // Model claims to answer but supplies NO cited sources.
    const ai = mockAi(
      JSON.stringify({
        status: "answered",
        answer: "You have 10 court days to respond.",
        citedSources: [],
        abstainReason: "",
      }),
    );

    const res = await answerQuestion(
      { questionText: "How long do I have to respond?" },
      { ai, retrieve },
    );

    expect(res.status).toBe("abstained");
    expect(res.citations).toEqual([]);
    expect(res.referral.url).toBeTruthy();
  });

  it("abstains when retrieval confidence is below the threshold (no model call)", async () => {
    let modelCalled = false;
    const ai: AiLike = {
      run: async () => {
        modelCalled = true;
        return { response: "{}" };
      },
    };
    const retrieve = mockRetrieve([{ ...RESPOND_CHUNK, score: 0.1 }]);

    const res = await answerQuestion(
      { questionText: "How long do I have to respond?" },
      { ai, retrieve },
    );

    expect(res.status).toBe("abstained");
    expect(modelCalled).toBe(false);
  });

  it("downgrades to abstained when the model cites a source that wasn't retrieved", async () => {
    const retrieve = mockRetrieve([RESPOND_CHUNK]); // only source [1] exists
    const ai = mockAi(
      JSON.stringify({
        status: "answered",
        answer: "Some claim.",
        citedSources: [7], // out of range -> no valid citation
        abstainReason: "",
      }),
    );

    const res = await answerQuestion(
      { questionText: "How long do I have to respond?" },
      { ai, retrieve },
    );

    expect(res.status).toBe("abstained");
    expect(res.citations).toEqual([]);
  });

  it("respects an explicit model abstention and keeps the reason", async () => {
    const retrieve = mockRetrieve([RESPOND_CHUNK]);
    const ai = mockAi(
      JSON.stringify({
        status: "abstained",
        answer: "",
        citedSources: [],
        abstainReason: "The sources do not address rent control.",
      }),
    );

    const res = await answerQuestion(
      { questionText: "What is my city's rent control limit?" },
      { ai, retrieve },
    );

    expect(res.status).toBe("abstained");
    expect(res.abstainReason).toContain("rent control");
    expect(res.referral.url).toBeTruthy();
  });

  it("abstains when the model returns non-JSON (never throws, never guesses)", async () => {
    const retrieve = mockRetrieve([RESPOND_CHUNK]);
    const ai = mockAi("I'm not sure, but you probably have 5 days.");

    const res = await answerQuestion(
      { questionText: "How long do I have to respond?" },
      { ai, retrieve },
    );

    expect(res.status).toBe("abstained");
    expect(res.citations).toEqual([]);
  });

  it("abstains (does not throw) when the model call rejects", async () => {
    const retrieve = mockRetrieve([RESPOND_CHUNK]);
    const ai: AiLike = { run: async () => Promise.reject(new Error("boom")) };

    const res = await answerQuestion(
      { questionText: "How long do I have to respond?" },
      { ai, retrieve },
    );

    expect(res.status).toBe("abstained");
    expect(res.referral.url).toBeTruthy();
  });

  it("abstains (does not throw) when retrieval rejects", async () => {
    const retrieve: RetrieveFn = async () => Promise.reject(new Error("network"));
    const ai = mockAi("{}");

    const res = await answerQuestion(
      { questionText: "How long do I have to respond?" },
      { ai, retrieve },
    );

    expect(res.status).toBe("abstained");
  });

  it("truncates citation snippets to <= 25 words", async () => {
    const longSnippet = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");
    const retrieve = mockRetrieve([{ ...RESPOND_CHUNK, snippet: longSnippet }]);
    const ai = mockAi(
      JSON.stringify({
        status: "answered",
        answer: "Grounded answer.",
        citedSources: [1],
        abstainReason: "",
      }),
    );

    const res = await answerQuestion(
      { questionText: "How long do I have to respond?" },
      { ai, retrieve },
    );

    expect(res.status).toBe("answered");
    const words = res.citations[0].snippet.replace(/…$/, "").trim().split(/\s+/);
    expect(words.length).toBeLessThanOrEqual(25);
  });

  it("accepts a model object response and numeric-string citedSources", async () => {
    const retrieve = mockRetrieve([RESPOND_CHUNK]);
    const ai = mockAi({
      status: "answered",
      answer: "Grounded answer.",
      citedSources: ["1"], // numeric string
      abstainReason: "",
    });

    const res = await answerQuestion(
      { questionText: "How long do I have to respond?" },
      { ai, retrieve },
    );

    expect(res.status).toBe("answered");
    expect(res.citations.length).toBe(1);
  });

  it("abstains on an empty question", async () => {
    const res = await answerQuestion(
      { questionText: "   " },
      { ai: mockAi("{}"), retrieve: mockRetrieve([RESPOND_CHUNK]) },
    );
    expect(res.status).toBe("abstained");
  });
});
