// lib/db.test.ts — D1 CRUD round-trips through an in-memory fake D1.
//
// The fake interprets exactly the SQL statements db.ts emits, storing rows in JS
// maps/arrays so create -> fetch is a genuine round-trip (not canned responses).

import { describe, it, expect, beforeEach } from "vitest";
import {
  createCase,
  getCase,
  updateCase,
  addQAEntry,
  addDocument,
} from "./db";
import type { CaseRecord, NoticeFacts, DeadlineResult, QAEntry } from "./types";

/* ----------------------------- fake D1 ----------------------------- */

interface Row {
  [k: string]: string | null;
}

class FakeStatement {
  constructor(
    private db: FakeD1,
    private sql: string,
    private args: unknown[] = [],
  ) {}
  bind(...args: unknown[]): FakeStatement {
    return new FakeStatement(this.db, this.sql, args);
  }
  async run(): Promise<{ success: true }> {
    this.db.exec(this.sql, this.args);
    return { success: true };
  }
  async first<T>(): Promise<T | null> {
    return (this.db.query(this.sql, this.args)[0] as T) ?? null;
  }
  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.query(this.sql, this.args) as T[] };
  }
}

class FakeD1 {
  cases = new Map<string, Row>();
  qa: Row[] = [];
  documents: Row[] = [];

  prepare(sql: string): FakeStatement {
    return new FakeStatement(this, sql);
  }
  async batch(stmts: FakeStatement[]): Promise<unknown[]> {
    const out: unknown[] = [];
    for (const s of stmts) out.push(await s.run());
    return out;
  }

  exec(sql: string, a: unknown[]): void {
    const s = a as (string | null)[];
    if (/^INSERT INTO cases/.test(sql)) {
      this.cases.set(s[0] as string, {
        id: s[0],
        created_at: s[1],
        language: s[2],
        notice_facts_json: s[3],
        deadline_json: s[4],
      });
    } else if (/^INSERT INTO qa_history/.test(sql)) {
      this.qa.push({
        id: s[0],
        case_id: s[1],
        question: s[2],
        result_json: s[3],
        at: s[4],
      });
    } else if (/^INSERT INTO documents/.test(sql)) {
      this.documents.push({
        id: s[0],
        case_id: s[1],
        r2_key: s[2],
        created_at: s[3],
      });
    } else if (/^UPDATE cases SET/.test(sql)) {
      const setClause = sql.slice(
        sql.indexOf("SET ") + 4,
        sql.indexOf(" WHERE"),
      );
      const cols = setClause.split(",").map((c) => c.trim().replace(" = ?", ""));
      const id = s[s.length - 1] as string;
      const row = this.cases.get(id);
      if (row) cols.forEach((c, i) => (row[c] = s[i]));
    } else if (/^DELETE FROM qa_history WHERE case_id/.test(sql)) {
      this.qa = this.qa.filter((r) => r.case_id !== s[0]);
    } else if (/^DELETE FROM documents WHERE case_id/.test(sql)) {
      this.documents = this.documents.filter((r) => r.case_id !== s[0]);
    } else {
      throw new Error(`FakeD1.exec: unhandled SQL: ${sql}`);
    }
  }

  query(sql: string, a: unknown[]): Row[] {
    const s = a as (string | null)[];
    if (/FROM cases WHERE id =/.test(sql)) {
      const row = this.cases.get(s[0] as string);
      return row ? [row] : [];
    }
    if (/FROM qa_history WHERE case_id =/.test(sql)) {
      return this.qa
        .filter((r) => r.case_id === s[0])
        .sort((x, y) => String(x.at).localeCompare(String(y.at)))
        .map((r) => ({ question: r.question, result_json: r.result_json, at: r.at }));
    }
    if (/FROM documents WHERE case_id =/.test(sql)) {
      return this.documents
        .filter((r) => r.case_id === s[0])
        .sort((x, y) =>
          String(x.created_at).localeCompare(String(y.created_at)),
        )
        .map((r) => ({ r2_key: r.r2_key }));
    }
    throw new Error(`FakeD1.query: unhandled SQL: ${sql}`);
  }
}

const asDb = (f: FakeD1): D1Database => f as unknown as D1Database;

/* --------------------------- fixtures ------------------------------ */

const noticeFacts: NoticeFacts = {
  noticeType: "Summons + Complaint (Unlawful Detainer)",
  serviceDateISO: "2026-06-01",
  serviceMethod: "personal",
  jurisdiction: "CA",
  parties: { landlord: "Acme Properties", tenant: "Jane Doe" },
  statedReason: "nonpayment of rent",
  extractionConfidence: 0.92,
  unreadableFields: [],
};

const deadline: DeadlineResult = {
  responseDeadlineISO: "2026-06-15",
  courtDaysUsed: 10,
  serviceMethod: "personal",
  assumptions: ["10 court days from personal service per CCP 1167."],
  mustVerify: true,
  holidayCalendarVersion: "CA-courts-2026",
};

const qaEntry: QAEntry = {
  questionText: "Can my landlord change the locks?",
  result: {
    status: "answered",
    answerMarkdown: "No — that is an unlawful self-help eviction.",
    citations: [
      {
        sourceId: "ccp-789",
        sourceTitle: "CCP 789.3",
        url: "https://example.gov/ccp789",
        snippet: "Landlord may not remove a tenant by lockout.",
      },
    ],
    referral: { text: "Contact legal aid.", url: "https://example.gov/aid" },
  },
  atISO: "2026-06-02T10:00:00.000Z",
};

function baseRecord(): CaseRecord {
  return {
    id: crypto.randomUUID(),
    createdAtISO: "2026-06-01T12:00:00.000Z",
    language: "en",
    noticeFacts: null,
    deadline: null,
    qaHistory: [],
    documentKeys: [],
  };
}

/* ----------------------------- tests ------------------------------- */

describe("db — create/fetch round-trip", () => {
  let db: FakeD1;
  beforeEach(() => {
    db = new FakeD1();
  });

  it("creates and fetches an empty case identically", async () => {
    const rec = baseRecord();
    await createCase(rec, asDb(db));
    const fetched = await getCase(rec.id, asDb(db));
    expect(fetched).toEqual(rec);
  });

  it("round-trips a fully-populated case (facts, deadline, qa, documents)", async () => {
    const rec: CaseRecord = {
      ...baseRecord(),
      noticeFacts,
      deadline,
      qaHistory: [qaEntry],
      documentKeys: ["drafts/ud-105-abc.pdf"],
    };
    await createCase(rec, asDb(db));
    const fetched = await getCase(rec.id, asDb(db));
    expect(fetched).toEqual(rec);
  });

  it("returns null for a missing case", async () => {
    expect(await getCase("does-not-exist", asDb(db))).toBeNull();
  });

  it("rejects an invalid record via zod (no id)", async () => {
    const bad = { ...baseRecord(), id: "" };
    await expect(createCase(bad, asDb(db))).rejects.toThrow();
  });
});

describe("db — updateCase", () => {
  let db: FakeD1;
  let rec: CaseRecord;
  beforeEach(async () => {
    db = new FakeD1();
    rec = baseRecord();
    await createCase(rec, asDb(db));
  });

  it("patches scalar/json columns in place", async () => {
    await updateCase(rec.id, { language: "es", noticeFacts, deadline }, asDb(db));
    const fetched = await getCase(rec.id, asDb(db));
    expect(fetched?.language).toBe("es");
    expect(fetched?.noticeFacts).toEqual(noticeFacts);
    expect(fetched?.deadline).toEqual(deadline);
  });

  it("can null out a json column", async () => {
    await updateCase(rec.id, { noticeFacts }, asDb(db));
    await updateCase(rec.id, { noticeFacts: null }, asDb(db));
    const fetched = await getCase(rec.id, asDb(db));
    expect(fetched?.noticeFacts).toBeNull();
  });

  it("replaces qaHistory and documentKeys collections", async () => {
    await updateCase(
      rec.id,
      { qaHistory: [qaEntry], documentKeys: ["a.pdf", "b.pdf"] },
      asDb(db),
    );
    const fetched = await getCase(rec.id, asDb(db));
    expect(fetched?.qaHistory).toEqual([qaEntry]);
    expect(fetched?.documentKeys).toEqual(["a.pdf", "b.pdf"]);
  });
});

describe("db — append helpers", () => {
  it("addQAEntry and addDocument accumulate onto a case", async () => {
    const db = new FakeD1();
    const rec = baseRecord();
    await createCase(rec, asDb(db));

    await addQAEntry(rec.id, qaEntry, asDb(db));
    await addDocument(rec.id, "drafts/ud-105.pdf", asDb(db));

    const fetched = await getCase(rec.id, asDb(db));
    expect(fetched?.qaHistory).toEqual([qaEntry]);
    expect(fetched?.documentKeys).toEqual(["drafts/ud-105.pdf"]);
  });
});
