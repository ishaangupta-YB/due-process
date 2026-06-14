// lib/actions.ts — Composio actions (email a legal-aid clinic, create a calendar reminder).
// STUB (P0). Enhancement tier. Confirm the Composio API against https://docs.composio.dev
// before coding. COMPOSIO_API_KEY is a secret, never committed.
//
// INVARIANT (CLAUDE.md §1.5): "Action" = draft + email to a clinic + set a reminder. Nothing
// more. Never present this as filing with a court.

export async function emailClinic(_caseId: string): Promise<{ sent: boolean }> {
  throw new Error("actions.emailClinic: not implemented (P0 stub)");
}

export async function createReminder(_caseId: string, _deadlineISO: string): Promise<{ created: boolean }> {
  throw new Error("actions.createReminder: not implemented (P0 stub)");
}
