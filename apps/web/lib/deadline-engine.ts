// lib/deadline-engine.ts — PURE deterministic deadline calculation + CA court holidays.
// STUB (P0). Wave 1 (P1-B) implements this with mandatory unit tests.
//
// INVARIANT (CLAUDE.md §1.3): the LLM NEVER computes the deadline. This module is the
// single source of truth. Response deadline = 10 COURT days after PERSONAL service of
// Summons & Complaint (CCP § 1167 as amended by AB 2347, eff. 2025-01-01); the clock
// starts the day AFTER service; court days exclude weekends + CA court holidays.
// Non-personal service adds extra days AND raises an uncertainty flag.
//
// NEVER output "5 days" — that is the outdated pre-2025 rule (CLAUDE.md §2).

import type { DeadlineResult, ServiceMethod } from "./types";

export interface DeadlineInput {
  serviceDateISO: string;
  serviceMethod: ServiceMethod;
}

export function computeDeadline(_input: DeadlineInput): DeadlineResult {
  throw new Error("deadline-engine.computeDeadline: not implemented (P0 stub)");
}
