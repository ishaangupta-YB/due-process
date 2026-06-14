// lib/memory.test.ts — mem0 wrapper add/recall against a mocked fetch.
// No real network: we stub globalThis.fetch and assert the request shape and
// that responses are mapped back into MemoryItem.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  addCaseMemory,
  recallCaseMemory,
  getAllCaseMemory,
  type MemoryItem,
} from "./memory";

interface Call {
  url: string;
  init: RequestInit;
}

function mockFetch(payload: unknown): { calls: Call[]; fn: typeof fetch } {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return {
      ok: true,
      status: 200,
      json: async () => payload,
    } as Response;
  }) as unknown as typeof fetch;
  return { calls, fn };
}

function body(call: Call): Record<string, unknown> {
  return JSON.parse(String(call.init.body));
}

describe("memory — mem0 wrapper", () => {
  beforeEach(() => {
    process.env.MEM0_API_KEY = "test-key";
    delete process.env.MEM0_BASE_URL;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.MEM0_API_KEY;
  });

  it("addCaseMemory posts each item to the add endpoint, scoped by caseId, infer:false", async () => {
    const { calls, fn } = mockFetch({ status: "PENDING" });
    vi.stubGlobal("fetch", fn);

    const items: MemoryItem[] = [
      { kind: "fact", text: "Personal service on 2026-06-01." },
      {
        kind: "deadline",
        text: "Response deadline 2026-06-15.",
        metadata: { responseDeadlineISO: "2026-06-15" },
      },
    ];
    await addCaseMemory("case-123", items);

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.url).toBe("https://api.mem0.ai/v3/memories/add/");
      expect(call.init.method).toBe("POST");
      const headers = call.init.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Token test-key");
      const b = body(call);
      expect(b.user_id).toBe("case-123");
      expect(b.infer).toBe(false);
    }
    // metadata.kind is recorded; extra metadata is merged.
    const deadlineBody = body(calls[1]);
    expect(deadlineBody.metadata).toMatchObject({
      kind: "deadline",
      responseDeadlineISO: "2026-06-15",
    });
  });

  it("addCaseMemory makes no request for an empty item list", async () => {
    const { calls, fn } = mockFetch({});
    vi.stubGlobal("fetch", fn);
    await addCaseMemory("case-123", []);
    expect(calls).toHaveLength(0);
  });

  it("recallCaseMemory maps results to MemoryItem and filters by user_id", async () => {
    const { calls, fn } = mockFetch({
      results: [
        {
          id: "m1",
          memory: "Personal service on 2026-06-01.",
          metadata: { kind: "fact" },
        },
        { id: "m2", memory: "Response deadline 2026-06-15.", metadata: { kind: "deadline" } },
      ],
    });
    vi.stubGlobal("fetch", fn);

    const out = await recallCaseMemory("case-123", "when is my deadline?");

    expect(calls[0].url).toBe("https://api.mem0.ai/v3/memories/search/");
    const b = body(calls[0]);
    expect(b.query).toBe("when is my deadline?");
    expect(b.filters).toEqual({ user_id: "case-123" });
    expect(out).toEqual([
      { kind: "fact", text: "Personal service on 2026-06-01.", metadata: { kind: "fact" } },
      {
        kind: "deadline",
        text: "Response deadline 2026-06-15.",
        metadata: { kind: "deadline" },
      },
    ]);
  });

  it("recall defaults unknown/absent kinds to 'fact'", async () => {
    const { fn } = mockFetch({
      results: [{ id: "m1", memory: "Something.", metadata: null }],
    });
    vi.stubGlobal("fetch", fn);
    const out = await recallCaseMemory("case-1", "q");
    expect(out[0].kind).toBe("fact");
    expect(out[0].text).toBe("Something.");
  });

  it("getAllCaseMemory lists memories scoped by user_id", async () => {
    const { calls, fn } = mockFetch({
      count: 1,
      results: [{ id: "m1", memory: "A fact.", metadata: { kind: "fact" } }],
    });
    vi.stubGlobal("fetch", fn);

    const out = await getAllCaseMemory("case-9");
    expect(calls[0].url).toContain("/v3/memories/");
    expect(body(calls[0]).filters).toEqual({ user_id: "case-9" });
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe("A fact.");
  });

  it("throws a clear error when MEM0_API_KEY is missing", async () => {
    delete process.env.MEM0_API_KEY;
    await expect(recallCaseMemory("c", "q")).rejects.toThrow(/MEM0_API_KEY/);
  });

  it("respects MEM0_BASE_URL override", async () => {
    process.env.MEM0_BASE_URL = "https://eu.example.com/";
    const { calls, fn } = mockFetch({ results: [] });
    vi.stubGlobal("fetch", fn);
    await recallCaseMemory("c", "q");
    expect(calls[0].url).toBe("https://eu.example.com/v3/memories/search/");
  });
});
