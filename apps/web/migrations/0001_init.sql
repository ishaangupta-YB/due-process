-- 0001_init.sql — DueProcess D1 schema (P0)
-- Relational store for cases, Q&A history, and generated documents.
-- Mirrors the CaseRecord contract in lib/types.ts. Store minimal sensitive data (CLAUDE.md §1.6).

PRAGMA foreign_keys = ON;

-- cases: one row per case. NoticeFacts and DeadlineResult are stored as JSON
-- (canonical shapes live in lib/types.ts); both are null until computed.
CREATE TABLE IF NOT EXISTS cases (
  id                TEXT PRIMARY KEY,
  created_at        TEXT NOT NULL,
  language          TEXT NOT NULL,                -- BCP-47, e.g. "en", "es"
  notice_facts_json TEXT,                         -- NoticeFacts as JSON; null until intake
  deadline_json     TEXT                          -- DeadlineResult as JSON; null until computed
);

-- qa_history: one row per question asked; result_json is the full GroundedAnswer.
CREATE TABLE IF NOT EXISTS qa_history (
  id          TEXT PRIMARY KEY,
  case_id     TEXT NOT NULL,
  question    TEXT NOT NULL,
  result_json TEXT NOT NULL,                      -- GroundedAnswer as JSON
  at          TEXT NOT NULL,                      -- ISO timestamp
  FOREIGN KEY (case_id) REFERENCES cases(id) ON DELETE CASCADE
);

-- documents: one row per generated draft, referenced by its R2 object key.
CREATE TABLE IF NOT EXISTS documents (
  id         TEXT PRIMARY KEY,
  case_id    TEXT NOT NULL,
  r2_key     TEXT NOT NULL,                       -- R2 object key of the generated draft
  created_at TEXT NOT NULL,
  FOREIGN KEY (case_id) REFERENCES cases(id) ON DELETE CASCADE
);
