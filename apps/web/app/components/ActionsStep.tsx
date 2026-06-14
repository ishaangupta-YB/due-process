"use client";

import { useState } from "react";

// Step 6: hand off to a legal-aid clinic + set a deadline reminder (Composio actions).
// CONSENT: nothing is sent until the user explicitly checks the consent box AND clicks
// the action button. Each action posts `consent: true`, which the route also enforces.
// These are enhancements — if Composio isn't configured, the calls fail gracefully and
// the rest of the flow (deadline, chat, draft) is unaffected.

type Status =
  | { state: "idle" }
  | { state: "sending" }
  | { state: "done"; message: string }
  | { state: "error"; message: string };

export function ActionsStep({
  caseId,
  deadlineISO,
}: {
  caseId: string | null;
  deadlineISO: string | null;
}) {
  const [clinicEmail, setClinicEmail] = useState("");
  const [emailConsent, setEmailConsent] = useState(false);
  const [emailStatus, setEmailStatus] = useState<Status>({ state: "idle" });

  const [reminderConsent, setReminderConsent] = useState(false);
  const [reminderStatus, setReminderStatus] = useState<Status>({ state: "idle" });

  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clinicEmail.trim());

  async function sendEmail() {
    if (!caseId || !emailConsent || !emailValid) return;
    setEmailStatus({ state: "sending" });
    try {
      const res = await fetch("/api/actions/email-clinic", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          caseId,
          clinicEmail: clinicEmail.trim(),
          consent: true,
        }),
      });
      const data = (await res.json()) as
        | { ok: true; sent: boolean }
        | { ok: false; error: string };
      if (data.ok) {
        setEmailStatus({
          state: "done",
          message: "Sent. The clinic has your case summary and draft link.",
        });
      } else {
        setEmailStatus({ state: "error", message: data.error });
      }
    } catch (err) {
      setEmailStatus({
        state: "error",
        message: err instanceof Error ? err.message : "Could not send the email.",
      });
    }
  }

  async function createReminder() {
    if (!caseId || !reminderConsent || !deadlineISO) return;
    setReminderStatus({ state: "sending" });
    try {
      const res = await fetch("/api/actions/reminder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ caseId, whenISO: deadlineISO, consent: true }),
      });
      const data = (await res.json()) as
        | { ok: true; created: boolean }
        | { ok: false; error: string };
      if (data.ok) {
        setReminderStatus({
          state: "done",
          message: `Reminder created for ${deadlineISO}. Confirm the exact date with the court.`,
        });
      } else {
        setReminderStatus({ state: "error", message: data.error });
      }
    } catch (err) {
      setReminderStatus({
        state: "error",
        message: err instanceof Error ? err.message : "Could not create the reminder.",
      });
    }
  }

  return (
    <section className="card" aria-labelledby="actions-h">
      <span className="card__step">
        <span className="card__step-num">6</span> Get help &amp; stay on time
      </span>
      <h2 id="actions-h">Hand off to a clinic and set a reminder</h2>
      <p className="lead">
        Optional. With your permission, DueProcess can email a legal-aid clinic your
        case summary and draft link, and add your response deadline to your calendar.
        It never files anything with a court.
      </p>

      {!caseId && (
        <p className="note note--info">
          Finish the steps above first — we need your case details before we can hand off.
        </p>
      )}

      {/* Email a clinic */}
      <div className="field" style={{ marginTop: "0.5rem" }}>
        <label htmlFor="clinic-email">Legal-aid clinic email</label>
        <input
          id="clinic-email"
          type="email"
          inputMode="email"
          placeholder="intake@legalaid.org"
          value={clinicEmail}
          disabled={!caseId || emailStatus.state === "sending"}
          onChange={(e) => setClinicEmail(e.target.value)}
        />
        <label className="hint" style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem" }}>
          <input
            type="checkbox"
            checked={emailConsent}
            disabled={!caseId}
            onChange={(e) => setEmailConsent(e.target.checked)}
          />
          I consent to DueProcess emailing this clinic my case summary and draft link on my behalf.
        </label>
        <div className="btn-row" style={{ marginTop: "0.6rem" }}>
          <button
            type="button"
            className="btn"
            disabled={
              !caseId || !emailConsent || !emailValid || emailStatus.state === "sending"
            }
            onClick={sendEmail}
          >
            {emailStatus.state === "sending" ? (
              <>
                <span className="spinner" aria-hidden="true" /> Sending…
              </>
            ) : (
              "Email this clinic with my consent"
            )}
          </button>
        </div>
        {emailStatus.state === "done" && (
          <p className="note note--info">{emailStatus.message}</p>
        )}
        {emailStatus.state === "error" && (
          <p className="note note--error">
            We couldn&apos;t send it: {emailStatus.message}
          </p>
        )}
      </div>

      {/* Calendar reminder */}
      <div className="field" style={{ marginTop: "1rem" }}>
        <label>Deadline reminder</label>
        <p className="hint">
          {deadlineISO
            ? `Add a calendar reminder for your response deadline (${deadlineISO}).`
            : "A reminder needs your computed deadline first."}
        </p>
        <label className="hint" style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem" }}>
          <input
            type="checkbox"
            checked={reminderConsent}
            disabled={!caseId || !deadlineISO}
            onChange={(e) => setReminderConsent(e.target.checked)}
          />
          I consent to DueProcess adding this deadline to my calendar on my behalf.
        </label>
        <div className="btn-row" style={{ marginTop: "0.6rem" }}>
          <button
            type="button"
            className="btn btn--secondary"
            disabled={
              !caseId ||
              !deadlineISO ||
              !reminderConsent ||
              reminderStatus.state === "sending"
            }
            onClick={createReminder}
          >
            {reminderStatus.state === "sending" ? (
              <>
                <span className="spinner" aria-hidden="true" /> Adding…
              </>
            ) : (
              "Add deadline reminder with my consent"
            )}
          </button>
        </div>
        {reminderStatus.state === "done" && (
          <p className="note note--info">{reminderStatus.message}</p>
        )}
        {reminderStatus.state === "error" && (
          <p className="note note--error">
            We couldn&apos;t create it: {reminderStatus.message}
          </p>
        )}
      </div>
    </section>
  );
}
