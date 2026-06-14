// lib/db.ts — D1 access (cases, qa_history, documents).
// Typed CRUD over the D1 schema in migrations/0001_init.sql, validated with zod.
// Access the D1 binding via getCloudflareContext(); tests may inject a fake D1Database.
// Store the minimum sensitive data needed (CLAUDE.md §1.6) and never log PII.

import { getCloudflareContext } from "@opennextjs/cloudflare";
import { z } from "zod";
import type {
  CaseRecord,
  DeadlineResult,
  GroundedAnswer,
  NoticeFacts,
  QAEntry,
} from "./types";

/* ------------------------------------------------------------------ */
/* zod schemas — runtime validation that mirrors the canonical contract */
/* in lib/types.ts. We import the types from there and never fork them. */

const serviceMethodSchema = z.enum([
  "personal",
  "substituted",
  "posted_mail",
  "unknown",
]);

const noticeFactsSchema = z.object({
  noticeType: z.string(),
  serviceDateISO: z.string().nullable(),
  serviceMethod: serviceMethodSchema,
  jurisdiction: z.literal("CA"),
  parties: z.object({
    landlord: z.string().optional(),
    tenant: z.string().optional(),
  }),
  statedReason: z.string().nullable(),
  extractionConfidence: z.number(),
  unreadableFields: z.array(z.string()),
});

const deadlineResultSchema = z.object({
  responseDeadlineISO: z.string().nullable(),
  courtDaysUsed: z.number(),
  serviceMethod: serviceMethodSchema,
  assumptions: z.array(z.string()),
  mustVerify: z.literal(true),
  holidayCalendarVersion: z.string(),
});

const citationSchema = z.object({
  sourceId: z.string(),
  sourceTitle: z.string(),
  url: z.string(),
  snippet: z.string(),
});

const groundedAnswerSchema = z.object({
  status: z.enum(["answered", "abstained"]),
  answerMarkdown: z.string().optional(),
  citations: z.array(citationSchema),
  abstainReason: z.string().optional(),
  referral: z.object({ text: z.string(), url: z.string() }),
});

const qaEntrySchema = z.object({
  questionText: z.string(),
  result: groundedAnswerSchema,
  atISO: z.string(),
});

const caseRecordSchema = z.object({
  id: z.string().min(1),
  createdAtISO: z.string(),
  language: z.string(),
  noticeFacts: noticeFactsSchema.nullable(),
  deadline: deadlineResultSchema.nullable(),
  qaHistory: z.array(qaEntrySchema),
  documentKeys: z.array(z.string()),
});

// Patch accepts any subset of the mutable CaseRecord fields.
const casePatchSchema = z
  .object({
    language: z.string(),
    noticeFacts: noticeFactsSchema.nullable(),
    deadline: deadlineResultSchema.nullable(),
    qaHistory: z.array(qaEntrySchema),
    documentKeys: z.array(z.string()),
  })
  .partial();

/* ------------------------------------------------------------------ */
/* binding resolution                                                  */

/**
 * Resolve the D1 binding. Production code calls without an argument and the
 * binding is read from the Workers runtime; tests inject a fake D1Database.
 */
function resolveDb(db?: D1Database): D1Database {
  if (db) return db;
  const { env } = getCloudflareContext();
  const resolved = (env as { DB?: D1Database }).DB;
  if (!resolved) {
    throw new Error("db: D1 binding 'DB' missing. Check wrangler.jsonc.");
  }
  return resolved;
}

/* ------------------------------------------------------------------ */
/* row shapes (internal)                                               */

interface CaseRow {
  id: string;
  created_at: string;
  language: string;
  notice_facts_json: string | null;
  deadline_json: string | null;
}

interface QaRow {
  question: string;
  result_json: string;
  at: string;
}

interface DocRow {
  r2_key: string;
}

/* ------------------------------------------------------------------ */
/* CRUD                                                                */

/**
 * Persist a new case plus any seeded Q&A history and document keys.
 * All writes run in a single D1 batch so the row set is consistent.
 */
export async function createCase(
  record: CaseRecord,
  db?: D1Database,
): Promise<void> {
  const r = caseRecordSchema.parse(record);
  const conn = resolveDb(db);

  const statements: D1PreparedStatement[] = [
    conn
      .prepare(
        "INSERT INTO cases (id, created_at, language, notice_facts_json, deadline_json) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(
        r.id,
        r.createdAtISO,
        r.language,
        r.noticeFacts ? JSON.stringify(r.noticeFacts) : null,
        r.deadline ? JSON.stringify(r.deadline) : null,
      ),
    ...r.qaHistory.map((entry) =>
      conn
        .prepare(
          "INSERT INTO qa_history (id, case_id, question, result_json, at) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(
          crypto.randomUUID(),
          r.id,
          entry.questionText,
          JSON.stringify(entry.result),
          entry.atISO,
        ),
    ),
    ...r.documentKeys.map((key) =>
      conn
        .prepare(
          "INSERT INTO documents (id, case_id, r2_key, created_at) VALUES (?, ?, ?, ?)",
        )
        .bind(crypto.randomUUID(), r.id, key, r.createdAtISO),
    ),
  ];

  await conn.batch(statements);
}

/**
 * Fetch a full case, reassembling Q&A history and document keys from their
 * tables. Returns null when the case does not exist.
 */
export async function getCase(
  id: string,
  db?: D1Database,
): Promise<CaseRecord | null> {
  const conn = resolveDb(db);

  const caseRow = await conn
    .prepare(
      "SELECT id, created_at, language, notice_facts_json, deadline_json FROM cases WHERE id = ?",
    )
    .bind(id)
    .first<CaseRow>();
  if (!caseRow) return null;

  const qa = await conn
    .prepare(
      "SELECT question, result_json, at FROM qa_history WHERE case_id = ? ORDER BY at ASC",
    )
    .bind(id)
    .all<QaRow>();

  const docs = await conn
    .prepare(
      "SELECT r2_key FROM documents WHERE case_id = ? ORDER BY created_at ASC",
    )
    .bind(id)
    .all<DocRow>();

  const noticeFacts: NoticeFacts | null = caseRow.notice_facts_json
    ? noticeFactsSchema.parse(JSON.parse(caseRow.notice_facts_json))
    : null;
  const deadline: DeadlineResult | null = caseRow.deadline_json
    ? deadlineResultSchema.parse(JSON.parse(caseRow.deadline_json))
    : null;

  const qaHistory: QAEntry[] = (qa.results ?? []).map((row) => ({
    questionText: row.question,
    result: groundedAnswerSchema.parse(JSON.parse(row.result_json)) as GroundedAnswer,
    atISO: row.at,
  }));

  return {
    id: caseRow.id,
    createdAtISO: caseRow.created_at,
    language: caseRow.language,
    noticeFacts,
    deadline,
    qaHistory,
    documentKeys: (docs.results ?? []).map((row) => row.r2_key),
  };
}

/**
 * Apply a partial update. Scalar/JSON columns on the case row are updated in
 * place; qaHistory and documentKeys, when present, replace the existing rows.
 */
export async function updateCase(
  id: string,
  patch: Partial<CaseRecord>,
  db?: D1Database,
): Promise<void> {
  const p = casePatchSchema.parse(patch);
  const conn = resolveDb(db);
  const statements: D1PreparedStatement[] = [];

  // Build the cases-table SET clause in a deterministic column order.
  const setColumns: string[] = [];
  const setValues: (string | null)[] = [];
  if ("language" in p && p.language !== undefined) {
    setColumns.push("language = ?");
    setValues.push(p.language);
  }
  if ("noticeFacts" in p) {
    setColumns.push("notice_facts_json = ?");
    setValues.push(p.noticeFacts ? JSON.stringify(p.noticeFacts) : null);
  }
  if ("deadline" in p) {
    setColumns.push("deadline_json = ?");
    setValues.push(p.deadline ? JSON.stringify(p.deadline) : null);
  }
  if (setColumns.length > 0) {
    statements.push(
      conn
        .prepare(`UPDATE cases SET ${setColumns.join(", ")} WHERE id = ?`)
        .bind(...setValues, id),
    );
  }

  if ("qaHistory" in p && p.qaHistory) {
    statements.push(
      conn.prepare("DELETE FROM qa_history WHERE case_id = ?").bind(id),
    );
    for (const entry of p.qaHistory) {
      statements.push(
        conn
          .prepare(
            "INSERT INTO qa_history (id, case_id, question, result_json, at) VALUES (?, ?, ?, ?, ?)",
          )
          .bind(
            crypto.randomUUID(),
            id,
            entry.questionText,
            JSON.stringify(entry.result),
            entry.atISO,
          ),
      );
    }
  }

  if ("documentKeys" in p && p.documentKeys) {
    statements.push(
      conn.prepare("DELETE FROM documents WHERE case_id = ?").bind(id),
    );
    for (const key of p.documentKeys) {
      statements.push(
        conn
          .prepare(
            "INSERT INTO documents (id, case_id, r2_key, created_at) VALUES (?, ?, ?, ?)",
          )
          .bind(crypto.randomUUID(), id, key, new Date().toISOString()),
      );
    }
  }

  if (statements.length > 0) await conn.batch(statements);
}

/**
 * Append a single Q&A entry to a case. Used by the answer pipeline so a case
 * accumulates its question history over time.
 */
export async function addQAEntry(
  caseId: string,
  entry: QAEntry,
  db?: D1Database,
): Promise<void> {
  const e = qaEntrySchema.parse(entry);
  const conn = resolveDb(db);
  await conn
    .prepare(
      "INSERT INTO qa_history (id, case_id, question, result_json, at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(
      crypto.randomUUID(),
      caseId,
      e.questionText,
      JSON.stringify(e.result),
      e.atISO,
    )
    .run();
}

/**
 * Record a generated document's R2 object key against a case.
 */
export async function addDocument(
  caseId: string,
  r2Key: string,
  db?: D1Database,
): Promise<void> {
  const key = z.string().min(1).parse(r2Key);
  const conn = resolveDb(db);
  await conn
    .prepare(
      "INSERT INTO documents (id, case_id, r2_key, created_at) VALUES (?, ?, ?, ?)",
    )
    .bind(crypto.randomUUID(), caseId, key, new Date().toISOString())
    .run();
}
