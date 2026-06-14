// __tests__/case-do.test.ts — deadline-reminder alarm scheduling logic.
//
// We exercise the pure scheduler computeReminderAt (the DO calls it before
// storage.setAlarm). The cloudflare:workers module is stubbed so the file
// imports cleanly under the node test environment.

import { describe, it, expect, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

const { computeReminderAt } = await import("../durable-objects/case-do");

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-06-01T00:00:00Z");

describe("computeReminderAt", () => {
  it("schedules 2 days before a far-future deadline", () => {
    const deadline = "2026-06-15"; // 14 days out
    const at = computeReminderAt(deadline, NOW);
    expect(at).toBe(Date.parse("2026-06-13T00:00:00Z"));
    expect(at).toBeGreaterThan(NOW);
  });

  it("respects a custom lead time", () => {
    const at = computeReminderAt("2026-06-15", NOW, 5);
    expect(at).toBe(Date.parse("2026-06-10T00:00:00Z"));
  });

  it("clamps to now (never in the past) when the lead window already started", () => {
    // Deadline tomorrow: 2-day lead would land yesterday -> clamp to now.
    const at = computeReminderAt("2026-06-02", NOW);
    expect(at).toBe(NOW);
    expect(at).toBeGreaterThanOrEqual(NOW);
  });

  it("returns null for a deadline that has already passed", () => {
    expect(computeReminderAt("2026-05-31", NOW)).toBeNull();
  });

  it("returns null for a deadline equal to now", () => {
    expect(computeReminderAt("2026-06-01", NOW)).toBeNull();
  });

  it("returns null for an unparseable date", () => {
    expect(computeReminderAt("not-a-date", NOW)).toBeNull();
    expect(computeReminderAt("", NOW)).toBeNull();
  });

  it("never returns a time in the past across a range of deadlines", () => {
    for (let days = -5; days <= 30; days++) {
      const deadlineMs = NOW + days * DAY;
      const iso = new Date(deadlineMs).toISOString().slice(0, 10);
      const at = computeReminderAt(iso, NOW);
      if (at !== null) expect(at).toBeGreaterThanOrEqual(NOW);
    }
  });
});
