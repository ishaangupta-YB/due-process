// lib/deadline-engine.ts — PURE deterministic deadline calculation + CA court holidays.
//
// INVARIANT (CLAUDE.md §1.3): the LLM NEVER computes the deadline. This module is the
// single source of truth. Response deadline = 10 COURT days after PERSONAL service of
// Summons & Complaint (CCP § 1167 as amended by AB 2347, eff. 2025-01-01); the clock
// starts the day AFTER service; court days exclude weekends + CA court holidays.
// Non-personal service reports the SAME earliest date and flags that more time MAY apply.
//
// NEVER output "5 days" — that is the outdated pre-2025 rule (CLAUDE.md §2).
//
// PURITY: this module imports ONLY from "./types". It makes no network/model calls and
// reads no clock — output depends solely on the input. Do not add side effects here.

import type { DeadlineResult, ServiceMethod } from "./types";

export interface DeadlineInput {
  serviceDateISO: string; // date served, ISO yyyy-mm-dd
  serviceMethod: ServiceMethod;
}

// ---------------------------------------------------------------------------
// California court-holiday table (CLEARLY-MARKED CONSTANT).
//
// Source of truth (verified, not from memory):
//   - Judicial Branch of California, "Court Holidays": https://courts.ca.gov/about/court-holidays
//   - CCP § 135 (judicial holidays) + Gov. Code § 6700 (state holidays).
//   - California Rules of Court, Rule 1.11: when a judicial holiday falls on a SATURDAY
//     the court observes it the PRECEDING FRIDAY; when it falls on a SUNDAY the court
//     observes it the FOLLOWING MONDAY. The dates below are the OBSERVED dates.
//
// Coverage: current year (2026) + next year (2027). Dates outside this range raise a
// reduced-confidence assumption (see computeResponseDeadline).
//
// NOTE: courts do NOT observe Columbus Day (2nd Mon Oct) or Admission Day (Sep 9) per
// CCP § 135; they DO observe Native American Day (4th Friday in September).
// ---------------------------------------------------------------------------
export const HOLIDAY_CALENDAR_VERSION = "CA-courts-2026-2027";

export const HOLIDAY_YEARS_COVERED: readonly number[] = [2026, 2027];

export const HOLIDAYS_CA: ReadonlySet<string> = new Set<string>([
  // ----- 2026 (observed dates) -----
  "2026-01-01", // New Year's Day (Thu)
  "2026-01-19", // Dr. Martin Luther King, Jr. Day (3rd Mon Jan)
  "2026-02-12", // Lincoln's Birthday (Thu)
  "2026-02-16", // President's Day (3rd Mon Feb)
  "2026-03-31", // Cesar Chavez / Farmworkers Day (Tue)
  "2026-05-25", // Memorial Day (last Mon May)
  "2026-06-19", // Juneteenth (Fri)
  "2026-07-03", // Independence Day OBSERVED (Jul 4 is Sat -> preceding Fri, CRC 1.11)
  "2026-09-07", // Labor Day (1st Mon Sep)
  "2026-09-25", // Native American Day (4th Fri Sep)
  "2026-11-11", // Veterans Day (Wed)
  "2026-11-26", // Thanksgiving (4th Thu Nov)
  "2026-11-27", // Day After Thanksgiving (Fri)
  "2026-12-25", // Christmas Day (Fri)
  // ----- 2027 (observed dates) -----
  "2027-01-01", // New Year's Day (Fri)
  "2027-01-18", // Dr. Martin Luther King, Jr. Day (3rd Mon Jan)
  "2027-02-12", // Lincoln's Birthday (Fri)
  "2027-02-15", // President's Day (3rd Mon Feb)
  "2027-03-31", // Cesar Chavez / Farmworkers Day (Wed)
  "2027-05-31", // Memorial Day (last Mon May)
  "2027-06-18", // Juneteenth OBSERVED (Jun 19 is Sat -> preceding Fri, CRC 1.11)
  "2027-07-05", // Independence Day OBSERVED (Jul 4 is Sun -> following Mon, CRC 1.11)
  "2027-09-06", // Labor Day (1st Mon Sep)
  "2027-09-24", // Native American Day (4th Fri Sep)
  "2027-11-11", // Veterans Day (Thu)
  "2027-11-25", // Thanksgiving (4th Thu Nov)
  "2027-11-26", // Day After Thanksgiving (Fri)
  "2027-12-24", // Christmas Day OBSERVED (Dec 25 is Sat -> preceding Fri, CRC 1.11)
]);

// 10 COURT days after personal service (CCP § 1167 as amended by AB 2347, eff. 2025-01-01).
// This is the CURRENT rule — the pre-2025 rule of 5 days is OUTDATED (CLAUDE.md §2).
const COURT_DAYS_TO_RESPOND = 10;

// NON-personal service (substituted / post-and-mail) MAY grant additional time before the
// response is due (e.g. CCP § 1167(b) adds court days for mail service; CCP § 415.20 / § 1162
// service is not "complete" until extra days pass). That extra time is genuinely uncertain
// for unlawful detainer and would only ever push the deadline LATER. To stay safe (CLAUDE.md
// §1.1) we NEVER bake it into the headline date — we always report the EARLIEST defensible
// deadline and flag the possible extension as upside in the assumptions. Do not change this
// to a later date without attorney confirmation.

// Plain-language note attached to every result (CLAUDE.md §1.1, §1.3).
const VERIFY_NOTE =
  "Confirm this date with the court or a self-help center. This tool provides legal information, not legal advice.";

// ---------------------------------------------------------------------------
// Date helpers (UTC-only to avoid timezone drift; no clock is read).
// ---------------------------------------------------------------------------
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Parse a strict yyyy-mm-dd string into a UTC Date, or null if malformed/invalid. */
function parseISODate(iso: string): Date | null {
  const m = ISO_DATE.exec(iso);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const d = new Date(Date.UTC(year, month - 1, day));
  // Reject overflow dates (e.g. 2026-02-30) by checking the round-trip.
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() !== month - 1 ||
    d.getUTCDate() !== day
  ) {
    return null;
  }
  return d;
}

/** Format a UTC Date back to yyyy-mm-dd. */
function toISODate(d: Date): string {
  const y = d.getUTCFullYear().toString().padStart(4, "0");
  const mo = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const da = d.getUTCDate().toString().padStart(2, "0");
  return `${y}-${mo}-${da}`;
}

function addCalendarDays(d: Date, n: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + n));
}

function isWeekend(d: Date): boolean {
  const dow = d.getUTCDay(); // 0 = Sunday, 6 = Saturday
  return dow === 0 || dow === 6;
}

function isCourtHoliday(d: Date): boolean {
  return HOLIDAYS_CA.has(toISODate(d));
}

function isCourtDay(d: Date): boolean {
  return !isWeekend(d) && !isCourtHoliday(d);
}

/**
 * Return the date that is `n` court days AFTER `start` (counting starts the DAY AFTER
 * `start`, per CCP § 1167 / CCP § 12 — the day of service is not counted). Excludes
 * Saturdays, Sundays, and California court holidays.
 */
function addCourtDays(start: Date, n: number): Date {
  let cursor = start;
  let counted = 0;
  // Safety bound: 10 court days never spans more than a few weeks even across holidays.
  // The bound prevents an infinite loop if the table were ever misconfigured.
  for (let i = 0; i < 400 && counted < n; i++) {
    cursor = addCalendarDays(cursor, 1);
    if (isCourtDay(cursor)) counted++;
  }
  return cursor;
}

function yearsCovered(...dates: Date[]): boolean {
  return dates.every((d) => HOLIDAY_YEARS_COVERED.includes(d.getUTCFullYear()));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute the California unlawful-detainer response deadline deterministically.
 *
 * Rules (CLAUDE.md §2):
 *  - Personal service: 10 COURT days, counting from the DAY AFTER service, excluding
 *    weekends and California court holidays.
 *  - Non-personal service (substituted / posted_mail): the headline deadline is the SAME
 *    earliest 10-court-day date (we never bake in uncertain extra time). An assumption
 *    explains the user MAY have more time and must VERIFY — biasing EARLY so they cannot
 *    miss the true deadline.
 *  - Unknown method OR missing/invalid service date: responseDeadlineISO is null with an
 *    explanatory assumption. The engine NEVER guesses a date.
 *
 * INVARIANTS: mustVerify is ALWAYS true and there is ALWAYS >= 1 assumption.
 */
export function computeResponseDeadline(input: DeadlineInput): DeadlineResult {
  const { serviceDateISO, serviceMethod } = input;

  const base = {
    serviceMethod,
    mustVerify: true as const,
    holidayCalendarVersion: HOLIDAY_CALENDAR_VERSION,
  };

  // --- Unknown service method: cannot compute, do not guess. ---
  if (serviceMethod === "unknown") {
    return {
      ...base,
      responseDeadlineISO: null,
      courtDaysUsed: 0,
      assumptions: [
        "Service method is unknown, so the response deadline cannot be computed. The number of days depends on how you were served (personal, substituted, or posting/mailing).",
        VERIFY_NOTE,
      ],
    };
  }

  // --- Missing / invalid service date: cannot compute, do not guess. ---
  const serviceDate = serviceDateISO ? parseISODate(serviceDateISO) : null;
  if (!serviceDate) {
    return {
      ...base,
      responseDeadlineISO: null,
      courtDaysUsed: 0,
      assumptions: [
        "No valid service date was provided (expected format YYYY-MM-DD), so the response deadline cannot be computed.",
        VERIFY_NOTE,
      ],
    };
  }

  const assumptions: string[] = [];

  // The headline deadline is ALWAYS the EARLIEST defensible date: 10 court days after
  // service, counting from the day after service. We deliberately bias EARLY (CLAUDE.md
  // §1.1) so a tenant can never miss the true deadline. Any extra time non-personal
  // service may grant is surfaced as upside below — never baked into a later date.
  const deadline = addCourtDays(serviceDate, COURT_DAYS_TO_RESPOND);

  assumptions.push(
    `Counted ${COURT_DAYS_TO_RESPOND} court days (excluding Saturdays, Sundays, and California court holidays), starting the day after service, per CCP § 1167 as amended by AB 2347 (effective 2025-01-01). The prior 5-day rule is outdated.`,
  );

  // --- Non-personal service: you MAY have more time, but we show the earliest. ---
  if (serviceMethod !== "personal") {
    assumptions.push(
      `Service method is "${serviceMethod}" (non-personal). You MAY have additional time before your response is due — mail service can add court days (CCP § 1167(b)), and substituted or post-and-mail service may not be legally "complete" until extra days pass (CCP § 415.20 / § 1162). This date shows the EARLIEST possible deadline so you do not miss it — do NOT wait past it. VERIFY the exact deadline with the court or a self-help center.`,
    );
  }

  // Reduced-confidence flag if any relevant date falls outside the holiday table.
  if (!yearsCovered(serviceDate, deadline)) {
    assumptions.push(
      `The California court-holiday table (${HOLIDAY_CALENDAR_VERSION}) only covers ${HOLIDAY_YEARS_COVERED.join(
        " and ",
      )}; one or more relevant dates fall outside that range, so confidence is reduced — verify court holidays for those years.`,
    );
  }

  assumptions.push(VERIFY_NOTE);

  return {
    ...base,
    responseDeadlineISO: toISODate(deadline),
    courtDaysUsed: COURT_DAYS_TO_RESPOND,
    assumptions,
  };
}

// Backwards-compatible alias: the P0 stub exported `computeDeadline`. Keep both names so
// existing/future importers (e.g. app/api/deadline/route.ts) are not broken.
export const computeDeadline = computeResponseDeadline;
