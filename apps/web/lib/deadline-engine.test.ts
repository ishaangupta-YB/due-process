// lib/deadline-engine.test.ts — mandatory unit tests for the deterministic deadline engine.
//
// All expected dates were computed by hand against the CA court-holiday table in
// deadline-engine.ts (verified vs. https://courts.ca.gov/about/court-holidays).
// Day-of-week anchor used for verification: 2026-06-14 is a Sunday.

import { describe, it, expect } from "vitest";
import {
  computeResponseDeadline,
  computeDeadline,
  HOLIDAY_CALENDAR_VERSION,
  HOLIDAYS_CA,
} from "./deadline-engine";

describe("computeResponseDeadline — personal service", () => {
  it("personal service on a Monday with no holidays in the window -> 10 court days later", () => {
    // 2026-06-01 is a Monday. Count: Jun 2..5 (1-4), Jun 8..12 (5-9), Jun 15 (10).
    const r = computeResponseDeadline({
      serviceDateISO: "2026-06-01",
      serviceMethod: "personal",
    });
    expect(r.responseDeadlineISO).toBe("2026-06-15");
    expect(r.courtDaysUsed).toBe(10);
    expect(r.serviceMethod).toBe("personal");
    expect(r.mustVerify).toBe(true);
    expect(r.assumptions.length).toBeGreaterThanOrEqual(1);
    expect(r.holidayCalendarVersion).toBe(HOLIDAY_CALENDAR_VERSION);
  });

  it("service adjacent to a weekend (a Friday) skips Sat/Sun correctly", () => {
    // 2026-05-01 is a Friday; no holidays before the deadline (Memorial Day is 5/25).
    // Mon 5/4..Fri 5/8 (1-5), Mon 5/11..Fri 5/15 (6-10).
    const r = computeResponseDeadline({
      serviceDateISO: "2026-05-01",
      serviceMethod: "personal",
    });
    expect(r.responseDeadlineISO).toBe("2026-05-15");
    expect(r.courtDaysUsed).toBe(10);
  });

  it("service the week of a known CA holiday excludes the holiday (observed Independence Day)", () => {
    // 2026-06-30 is a Tuesday. 2026-07-03 (observed Independence Day) is a holiday.
    // Jul 1 Wed(1), Jul 2 Thu(2), Jul 3 Fri HOLIDAY (skip), Jul 6 Mon(3)..Jul 10 Fri(7),
    // Jul 13 Mon(8), Jul 14 Tue(9), Jul 15 Wed(10). Without the holiday it would be Jul 14.
    const r = computeResponseDeadline({
      serviceDateISO: "2026-06-30",
      serviceMethod: "personal",
    });
    expect(r.responseDeadlineISO).toBe("2026-07-15");
    expect(HOLIDAYS_CA.has("2026-07-03")).toBe(true);
  });

  it("crossing the New Year boundary uses the next year's holiday table", () => {
    // 2026-12-21 is a Monday. Holidays in window: 12/25 (Fri), 2027-01-01 (Fri).
    // Tue 12/22(1) Wed 12/23(2) Thu 12/24(3) Fri 12/25 HOLIDAY, Mon 12/28(4) Tue 12/29(5)
    // Wed 12/30(6) Thu 12/31(7), Fri 1/1 HOLIDAY, Mon 1/4(8) Tue 1/5(9) Wed 1/6(10).
    const r = computeResponseDeadline({
      serviceDateISO: "2026-12-21",
      serviceMethod: "personal",
    });
    expect(r.responseDeadlineISO).toBe("2027-01-06");
  });
});

describe("computeResponseDeadline — non-personal service", () => {
  it("substituted service adds extra calendar days before counting, and flags uncertainty", () => {
    // Base 2026-06-01 (Mon). +10 calendar days -> clock starts 2026-06-11 (Thu).
    // Jun 12 Fri(1), Jun 15 Mon(2)..Jun 18 Thu(5), Jun 19 Fri HOLIDAY (Juneteenth),
    // Jun 22 Mon(6)..Jun 26 Fri(10) -> 2026-06-26.
    const r = computeResponseDeadline({
      serviceDateISO: "2026-06-01",
      serviceMethod: "substituted",
    });
    expect(r.responseDeadlineISO).toBe("2026-06-26");
    expect(r.courtDaysUsed).toBe(10);
    expect(r.serviceMethod).toBe("substituted");
    expect(r.mustVerify).toBe(true);
    // Must raise an uncertainty assumption mentioning VERIFY and the statutes.
    expect(r.assumptions.some((a) => /VERIFY/.test(a))).toBe(true);
    expect(r.assumptions.some((a) => /415\.20|1162|1167/.test(a))).toBe(true);
    // Must surface the earlier personal-service deadline (2026-06-15) as a safety target.
    expect(r.assumptions.some((a) => a.includes("2026-06-15"))).toBe(true);
  });

  it("posted_mail service is treated like other non-personal service (extra days + flag)", () => {
    // Same base date/logic as substituted -> 2026-06-26.
    const r = computeResponseDeadline({
      serviceDateISO: "2026-06-01",
      serviceMethod: "posted_mail",
    });
    expect(r.responseDeadlineISO).toBe("2026-06-26");
    expect(r.serviceMethod).toBe("posted_mail");
    expect(r.assumptions.some((a) => /VERIFY/.test(a))).toBe(true);
  });
});

describe("computeResponseDeadline — cannot compute (never guesses)", () => {
  it("missing service date -> null deadline with an explanatory assumption", () => {
    const r = computeResponseDeadline({
      serviceDateISO: "",
      serviceMethod: "personal",
    });
    expect(r.responseDeadlineISO).toBeNull();
    expect(r.courtDaysUsed).toBe(0);
    expect(r.mustVerify).toBe(true);
    expect(r.assumptions.length).toBeGreaterThanOrEqual(1);
  });

  it("invalid date string -> null deadline (no guessing)", () => {
    const r = computeResponseDeadline({
      serviceDateISO: "2026-02-30",
      serviceMethod: "personal",
    });
    expect(r.responseDeadlineISO).toBeNull();
  });

  it("unknown service method -> null deadline with an explanatory assumption", () => {
    const r = computeResponseDeadline({
      serviceDateISO: "2026-06-01",
      serviceMethod: "unknown",
    });
    expect(r.responseDeadlineISO).toBeNull();
    expect(r.courtDaysUsed).toBe(0);
    expect(r.mustVerify).toBe(true);
    expect(r.assumptions.length).toBeGreaterThanOrEqual(1);
  });
});

describe("computeResponseDeadline — invariants & coverage", () => {
  it("never returns a non-null deadline without mustVerify:true and >= 1 assumption", () => {
    const inputs = [
      { serviceDateISO: "2026-06-01", serviceMethod: "personal" as const },
      { serviceDateISO: "2026-05-01", serviceMethod: "substituted" as const },
      { serviceDateISO: "2027-03-15", serviceMethod: "posted_mail" as const },
    ];
    for (const input of inputs) {
      const r = computeResponseDeadline(input);
      expect(r.responseDeadlineISO).not.toBeNull();
      expect(r.mustVerify).toBe(true);
      expect(r.assumptions.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("flags reduced confidence when a relevant date is outside the holiday table coverage", () => {
    // 2030 is outside the 2026-2027 table -> expect a reduced-confidence assumption.
    const r = computeResponseDeadline({
      serviceDateISO: "2030-03-04",
      serviceMethod: "personal",
    });
    expect(r.responseDeadlineISO).not.toBeNull();
    expect(r.assumptions.some((a) => /reduced/i.test(a))).toBe(true);
  });

  it("does NOT emit the outdated 5-day rule anywhere in assumptions", () => {
    const r = computeResponseDeadline({
      serviceDateISO: "2026-06-01",
      serviceMethod: "personal",
    });
    expect(r.assumptions.some((a) => /\b5\s*(court\s*)?days?\b/i.test(a))).toBe(false);
  });

  it("computeDeadline alias behaves identically to computeResponseDeadline", () => {
    const input = { serviceDateISO: "2026-06-01", serviceMethod: "personal" as const };
    expect(computeDeadline(input)).toEqual(computeResponseDeadline(input));
  });
});
