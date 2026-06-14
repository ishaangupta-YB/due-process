// lib/actions.ts — Composio actions: email a legal-aid clinic, create a calendar reminder.
//
// Enhancement tier (CLAUDE.md §12.8). These NEVER touch the CORE path; if Composio is
// unconfigured or failing, the functions throw a clear error and the calling route
// degrades gracefully (the deadline, chat, and draft still work).
//
// INVARIANTS:
//   §1.1 Not a lawyer. Every message we send says this is document preparation, not legal
//        advice, and points the user to a licensed attorney / legal-aid clinic.
//   §1.5 "Action" = email a clinic + set a reminder. NOTHING is filed with a court.
//   §1.6 Minimize PII. We send only what the recipient needs and never log message bodies.
//   Consent: these are only ever invoked after EXPLICIT user consent, enforced at the
//   route layer (app/api/actions/*). This module is the executor, not the gatekeeper.
//
// Composio REST API (verified against https://docs.composio.dev on 2026-06-14):
//   - Execute a tool: POST {base}/tools/execute/{TOOL_SLUG}
//     headers: { "x-api-key": COMPOSIO_API_KEY }
//     body:    { user_id, connected_account_id?, arguments: {...} }
//     resp:    { data, error, successful }
//   - GMAIL_SEND_EMAIL args:        { recipient_email, subject, body, is_html? }
//   - GOOGLECALENDAR_CREATE_EVENT:  { start_datetime, timezone, event_duration_hour,
//                                     event_duration_minutes, summary, description }
// COMPOSIO_API_KEY is a secret — never committed or logged.

import type { CaseRecord } from "./types";

/* ------------------------------------------------------------------ */
/* Config + dependency injection.                                      */

const DEFAULT_BASE_URL = "https://backend.composio.dev/api/v3";
const DEFAULT_EMAIL_TOOL = "GMAIL_SEND_EMAIL";
const DEFAULT_CALENDAR_TOOL = "GOOGLECALENDAR_CREATE_EVENT";
const DEFAULT_TIMEZONE = "America/Los_Angeles"; // California courts
const DEFAULT_USER_ID = "dueprocess";

export interface ActionsDeps {
  getCase?: (id: string) => Promise<CaseRecord | null>;
  fetchImpl?: typeof fetch;
}

interface ComposioConfig {
  baseUrl: string;
  apiKey: string;
  userId: string;
  connectedAccountId?: string;
}

function composioConfig(): ComposioConfig {
  const apiKey = process.env.COMPOSIO_API_KEY;
  if (!apiKey) {
    throw new Error(
      "actions: COMPOSIO_API_KEY is not set; actions are unavailable.",
    );
  }
  return {
    baseUrl: (process.env.COMPOSIO_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, ""),
    apiKey,
    userId: process.env.COMPOSIO_USER_ID ?? DEFAULT_USER_ID,
    connectedAccountId: process.env.COMPOSIO_CONNECTED_ACCOUNT_ID || undefined,
  };
}

/* ------------------------------------------------------------------ */
/* Composio tool execution.                                            */

interface ComposioResponse {
  data?: unknown;
  error?: string | null;
  successful?: boolean;
}

async function executeTool(
  toolSlug: string,
  args: Record<string, unknown>,
  deps: ActionsDeps,
): Promise<unknown> {
  const cfg = composioConfig();
  const doFetch = deps.fetchImpl ?? fetch;

  const res = await doFetch(`${cfg.baseUrl}/tools/execute/${toolSlug}`, {
    method: "POST",
    headers: {
      "x-api-key": cfg.apiKey,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      user_id: cfg.userId,
      ...(cfg.connectedAccountId
        ? { connected_account_id: cfg.connectedAccountId }
        : {}),
      arguments: args,
    }),
  });

  if (!res.ok) {
    // Surface status only — never echo the request body (may contain case facts).
    throw new Error(`actions: Composio ${toolSlug} failed (HTTP ${res.status}).`);
  }

  const payload = (await res.json().catch(() => null)) as ComposioResponse | null;
  if (payload && payload.successful === false) {
    throw new Error(
      `actions: Composio ${toolSlug} reported failure${
        payload.error ? `: ${payload.error}` : "."
      }`,
    );
  }
  return payload?.data ?? null;
}

/* ------------------------------------------------------------------ */
/* Case lookup helper.                                                 */

async function loadCase(
  caseId: string,
  deps: ActionsDeps,
): Promise<CaseRecord | null> {
  const getCase = deps.getCase ?? (await import("./db")).getCase;
  return getCase(caseId);
}

/** Relative URL served by GET /api/document; made absolute if APP_BASE_URL is set. */
function draftDownloadUrl(r2Key: string): string {
  const rel = `/api/document?key=${encodeURIComponent(r2Key)}`;
  const base = process.env.APP_BASE_URL?.replace(/\/+$/, "");
  return base ? `${base}${rel}` : rel;
}

/* ------------------------------------------------------------------ */
/* emailClinic.                                                        */

/**
 * Email a legal-aid clinic a plain-language case summary plus a link to the draft Answer.
 * Sends ONLY after explicit user consent (enforced by the route). Returns { sent }.
 */
export async function emailClinic(
  caseId: string,
  clinicEmail: string,
  deps: ActionsDeps = {},
): Promise<{ sent: boolean }> {
  const id = caseId?.trim();
  const to = clinicEmail?.trim();
  if (!id) throw new Error("actions.emailClinic: caseId is required");
  if (!isEmail(to)) throw new Error("actions.emailClinic: a valid clinicEmail is required");

  const record = await loadCase(id, deps);
  if (!record) throw new Error(`actions.emailClinic: case not found (${id})`);

  const tool = process.env.COMPOSIO_EMAIL_TOOL ?? DEFAULT_EMAIL_TOOL;
  await executeTool(
    tool,
    {
      recipient_email: to,
      subject: emailSubject(record),
      body: emailBody(record),
      is_html: false,
    },
    deps,
  );
  return { sent: true };
}

function emailSubject(record: CaseRecord): string {
  const deadline = record.deadline?.responseDeadlineISO;
  return deadline
    ? `Eviction (unlawful detainer) help requested — response due ${deadline}`
    : "Eviction (unlawful detainer) help requested";
}

function emailBody(record: CaseRecord): string {
  const f = record.noticeFacts;
  const d = record.deadline;
  const lines: string[] = [
    "Hello,",
    "",
    "A tenant used DueProcess (a self-help tool that prepares documents — it is NOT a law",
    "firm and does not give legal advice) and asked to be connected with your clinic for help",
    "responding to an eviction (unlawful detainer) lawsuit. Their case summary is below.",
    "",
    "CASE SUMMARY",
    `- Notice type: ${f?.noticeType ?? "unknown"}`,
    `- Date served: ${f?.serviceDateISO ?? "unknown"}`,
    `- Service method: ${f?.serviceMethod ?? "unknown"}`,
    `- Landlord's stated reason: ${f?.statedReason ?? "unknown"}`,
  ];

  if (d?.responseDeadlineISO) {
    lines.push(
      `- Computed response deadline: ${d.responseDeadlineISO} (${d.courtDaysUsed} court days, ${d.serviceMethod} service).`,
      "  This date is an estimate the tenant must confirm with the court — please verify it.",
    );
  } else {
    lines.push("- Response deadline: not yet computed.");
  }

  const latestKey = record.documentKeys[record.documentKeys.length - 1];
  if (latestKey) {
    lines.push(
      "",
      "DRAFT ANSWER (UD-105)",
      "The tenant prepared an unsigned DRAFT Answer. It has NOT been filed with any court and",
      "must be reviewed by a licensed attorney before filing. Link to the draft:",
      draftDownloadUrl(latestKey),
    );
  }

  lines.push(
    "",
    "Sent with the tenant's consent via DueProcess. DueProcess provides legal information and",
    "document preparation, not legal advice, and is not anyone's lawyer.",
  );
  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* createReminder.                                                     */

/**
 * Create a calendar reminder for the response deadline. Sends ONLY after explicit user
 * consent (enforced by the route). `whenISO` is the date/time to remind. Returns { created }.
 */
export async function createReminder(
  caseId: string,
  whenISO: string,
  deps: ActionsDeps = {},
): Promise<{ created: boolean }> {
  const id = caseId?.trim();
  if (!id) throw new Error("actions.createReminder: caseId is required");

  const start = toNaiveLocalDateTime(whenISO);
  if (!start) {
    throw new Error("actions.createReminder: whenISO must be an ISO date or datetime");
  }

  // Case context is best-effort: the reminder is still useful without it.
  let record: CaseRecord | null = null;
  try {
    record = await loadCase(id, deps);
  } catch {
    record = null;
  }

  const timezone = process.env.ACTIONS_TIMEZONE ?? DEFAULT_TIMEZONE;
  const tool = process.env.COMPOSIO_CALENDAR_TOOL ?? DEFAULT_CALENDAR_TOOL;

  await executeTool(
    tool,
    {
      start_datetime: start,
      timezone,
      event_duration_hour: 0,
      event_duration_minutes: 30,
      summary: "Eviction Answer deadline — respond before this date",
      description: reminderDescription(record),
    },
    deps,
  );
  return { created: true };
}

function reminderDescription(record: CaseRecord | null): string {
  const lines = [
    "Deadline to file your Answer (UD-105) in your eviction (unlawful detainer) case.",
    "Missing it can let the landlord win by default. Confirm the exact date with the court.",
  ];
  const deadline = record?.deadline?.responseDeadlineISO;
  if (deadline) lines.push(`Computed response deadline: ${deadline} (verify with the court).`);
  lines.push(
    "Created with your consent via DueProcess — legal information and document preparation,",
    "not legal advice. DueProcess is not your lawyer and does not file anything for you.",
  );
  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* Small pure helpers.                                                 */

function isEmail(value: string | undefined): value is string {
  return !!value && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/**
 * Normalize an ISO date/datetime into a naive local "YYYY-MM-DDTHH:MM:SS" string for
 * GOOGLECALENDAR_CREATE_EVENT (which pairs it with an explicit `timezone`). A date-only
 * value defaults to 09:00:00; any trailing "Z"/offset/fractional seconds are dropped and
 * the wall-clock time is interpreted in the event's timezone.
 */
export function toNaiveLocalDateTime(whenISO: string | undefined): string | null {
  const v = whenISO?.trim();
  if (!v) return null;
  const dateOnly = /^(\d{4}-\d{2}-\d{2})$/.exec(v);
  if (dateOnly) return `${dateOnly[1]}T09:00:00`;
  const dateTime = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::(\d{2}))?/.exec(v);
  if (dateTime) {
    const seconds = dateTime[3] ?? "00";
    return `${dateTime[1]}T${dateTime[2]}:${seconds}`;
  }
  return null;
}
