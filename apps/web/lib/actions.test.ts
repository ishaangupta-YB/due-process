// lib/actions.test.ts — Composio email + reminder actions against a mocked fetch and
// an injected getCase. No real network and no real Composio account.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { emailClinic, createReminder, toNaiveLocalDateTime } from "./actions";
import type { CaseRecord } from "./types";

const CASE: CaseRecord = {
  id: "case-123",
  createdAtISO: "2026-06-02T10:00:00.000Z",
  language: "es",
  noticeFacts: {
    noticeType: "Summons + Complaint (Unlawful Detainer)",
    serviceDateISO: "2026-06-01",
    serviceMethod: "personal",
    jurisdiction: "CA",
    parties: { landlord: "Acme Properties LLC", tenant: "Jane Doe" },
    statedReason: "nonpayment of rent",
    extractionConfidence: 0.9,
    unreadableFields: [],
  },
  deadline: {
    responseDeadlineISO: "2026-06-15",
    courtDaysUsed: 10,
    serviceMethod: "personal",
    assumptions: [],
    mustVerify: true,
    holidayCalendarVersion: "CA-courts-2026",
  },
  qaHistory: [],
  documentKeys: ["drafts/case-123/ud-105-answer-2026-06-02.pdf"],
};

interface Call {
  url: string;
  init: RequestInit;
}

function mockFetch(payload: unknown, ok = true, status = 200) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return {
      ok,
      status,
      json: async () => payload,
    } as Response;
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

function body(call: Call): Record<string, unknown> {
  return JSON.parse(String(call.init.body));
}

const getCase = async () => CASE;

describe("actions — Composio integration", () => {
  beforeEach(() => {
    process.env.COMPOSIO_API_KEY = "test-key";
    delete process.env.COMPOSIO_BASE_URL;
    delete process.env.APP_BASE_URL;
    delete process.env.COMPOSIO_CONNECTED_ACCOUNT_ID;
  });
  afterEach(() => {
    delete process.env.COMPOSIO_API_KEY;
    delete process.env.ACTIONS_TIMEZONE;
  });

  it("emailClinic executes GMAIL_SEND_EMAIL with the case summary + draft link", async () => {
    const { calls, fetchImpl } = mockFetch({ successful: true, data: { id: "msg1" } });
    process.env.APP_BASE_URL = "https://dueprocess.example";

    const out = await emailClinic("case-123", "clinic@law.org", { getCase, fetchImpl });
    expect(out).toEqual({ sent: true });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      "https://backend.composio.dev/api/v3/tools/execute/GMAIL_SEND_EMAIL",
    );
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("test-key");

    const b = body(calls[0]);
    expect(b.user_id).toBe("dueprocess");
    const args = b.arguments as Record<string, string>;
    expect(args.recipient_email).toBe("clinic@law.org");
    expect(args.subject).toContain("2026-06-15");
    expect(args.body).toContain("nonpayment of rent");
    expect(args.body).toContain("not legal advice");
    // Absolute draft link uses APP_BASE_URL.
    expect(args.body).toContain(
      "https://dueprocess.example/api/document?key=",
    );
  });

  it("emailClinic rejects an invalid email and sends nothing", async () => {
    const { calls, fetchImpl } = mockFetch({ successful: true });
    await expect(
      emailClinic("case-123", "not-an-email", { getCase, fetchImpl }),
    ).rejects.toThrow(/valid clinicEmail/);
    expect(calls).toHaveLength(0);
  });

  it("createReminder executes GOOGLECALENDAR_CREATE_EVENT with a naive start + timezone", async () => {
    const { calls, fetchImpl } = mockFetch({ successful: true, data: { id: "evt1" } });
    process.env.ACTIONS_TIMEZONE = "America/Los_Angeles";

    const out = await createReminder("case-123", "2026-06-15", { getCase, fetchImpl });
    expect(out).toEqual({ created: true });

    expect(calls[0].url).toContain("/tools/execute/GOOGLECALENDAR_CREATE_EVENT");
    const args = body(calls[0]).arguments as Record<string, unknown>;
    expect(args.start_datetime).toBe("2026-06-15T09:00:00");
    expect(args.timezone).toBe("America/Los_Angeles");
    expect(args.summary).toMatch(/Answer deadline/i);
  });

  it("surfaces a Composio failure (successful:false) as a thrown error", async () => {
    const { fetchImpl } = mockFetch({ successful: false, error: "no connected account" });
    await expect(
      emailClinic("case-123", "clinic@law.org", { getCase, fetchImpl }),
    ).rejects.toThrow(/no connected account/);
  });

  it("throws clearly when COMPOSIO_API_KEY is missing", async () => {
    delete process.env.COMPOSIO_API_KEY;
    const { fetchImpl } = mockFetch({ successful: true });
    await expect(
      createReminder("case-123", "2026-06-15", { getCase, fetchImpl }),
    ).rejects.toThrow(/COMPOSIO_API_KEY/);
  });

  it("emailClinic throws when the case does not exist", async () => {
    const { fetchImpl } = mockFetch({ successful: true });
    await expect(
      emailClinic("missing", "clinic@law.org", {
        getCase: async () => null,
        fetchImpl,
      }),
    ).rejects.toThrow(/case not found/);
  });
});

describe("toNaiveLocalDateTime", () => {
  it("defaults a date-only value to 09:00:00", () => {
    expect(toNaiveLocalDateTime("2026-06-15")).toBe("2026-06-15T09:00:00");
  });
  it("keeps wall-clock time and drops Z / fractional seconds", () => {
    expect(toNaiveLocalDateTime("2026-06-15T14:30:00.500Z")).toBe("2026-06-15T14:30:00");
    expect(toNaiveLocalDateTime("2026-06-15T14:30")).toBe("2026-06-15T14:30:00");
  });
  it("returns null for junk", () => {
    expect(toNaiveLocalDateTime("tomorrow")).toBeNull();
    expect(toNaiveLocalDateTime("")).toBeNull();
    expect(toNaiveLocalDateTime(undefined)).toBeNull();
  });
});
