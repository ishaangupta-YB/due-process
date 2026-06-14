"use client";

import type { DeadlineResult } from "@/lib/types";

const VERIFY_NOTE_FRAGMENT = "confirm this date";

function daysBetweenTodayAnd(iso: string): number {
  // Display-only: how far the engine's deadline is from today. The legal deadline
  // DATE itself is computed deterministically server-side (CLAUDE.md §1.3); this is
  // just a countdown of that fixed date, not a recomputation of the deadline.
  const today = new Date();
  const todayUTC = Date.UTC(
    today.getFullYear(),
    today.getMonth(),
    today.getDate(),
  );
  const [y, m, d] = iso.split("-").map(Number);
  const targetUTC = Date.UTC(y, m - 1, d);
  return Math.round((targetUTC - todayUTC) / 86_400_000);
}

function formatLongDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

export function DeadlineCountdown({ deadline }: { deadline: DeadlineResult }) {
  // Split the always-present "verify with the court" assumption from the rest so we
  // can show it as a prominent callout.
  const verifyNote = deadline.assumptions.find((a) =>
    a.toLowerCase().includes(VERIFY_NOTE_FRAGMENT),
  );
  const otherAssumptions = deadline.assumptions.filter((a) => a !== verifyNote);

  if (!deadline.responseDeadlineISO) {
    return (
      <section className="card countdown countdown--warn" aria-labelledby="dl-h">
        <span className="card__step">
          <span className="card__step-num">3</span> Your deadline
        </span>
        <h2 id="dl-h">We need a bit more to set your deadline</h2>
        <p>
          We couldn&apos;t compute a response deadline yet. Here&apos;s why:
        </p>
        <ul className="assumptions">
          {deadline.assumptions.map((a, i) => (
            <li key={i}>{a}</li>
          ))}
        </ul>
        <p className="note note--verify">
          Go back and add the date you were served and how you were served, or
          contact the court clerk to confirm your deadline.
        </p>
      </section>
    );
  }

  const days = daysBetweenTodayAnd(deadline.responseDeadlineISO);
  const past = days < 0;
  const urgent = days >= 0 && days <= 3;
  const tone = past ? "danger" : urgent ? "warn" : "";

  const bigNumber = past ? Math.abs(days) : days;
  const unit = Math.abs(days) === 1 ? "day" : "days";

  return (
    <section
      className={`card countdown ${tone ? `countdown--${tone}` : ""}`}
      aria-labelledby="dl-h"
    >
      <span className="card__step">
        <span className="card__step-num">3</span> Your deadline
      </span>

      <p className="countdown__label">
        {past
          ? "Your response was due"
          : days === 0
            ? "Your response is due today"
            : "Time left to respond"}
      </p>

      <div className="countdown__big" aria-hidden="true">
        <span className="countdown__num">{bigNumber}</span>
        <span className="countdown__unit">
          {past ? `${unit} ago` : days === 0 ? "" : `calendar ${unit} left`}
        </span>
      </div>

      <p className="countdown__date">
        <span className="sr-only">
          {past
            ? `Your response was due ${bigNumber} ${unit} ago. `
            : days === 0
              ? "Your response is due today. "
              : `You have ${bigNumber} calendar ${unit} left. `}
        </span>
        File your Answer by{" "}
        <strong>{formatLongDate(deadline.responseDeadlineISO)}</strong>
      </p>

      <p className="note note--verify">
        <strong>Important:</strong>{" "}
        {verifyNote ??
          "Confirm this date with the court or a self-help center. This tool provides legal information, not legal advice."}
        {past && (
          <>
            {" "}
            If the deadline has passed, you may still have options — contact a
            legal-aid clinic right away.
          </>
        )}
      </p>

      <details className="disclosure">
        <summary>
          How we calculated this ({deadline.courtDaysUsed} court days)
        </summary>
        <ul className="assumptions">
          {otherAssumptions.map((a, i) => (
            <li key={i}>{a}</li>
          ))}
        </ul>
        <p className="hint">Holiday calendar: {deadline.holidayCalendarVersion}</p>
      </details>
    </section>
  );
}
