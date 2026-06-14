import { DurableObject } from "cloudflare:workers";

// CaseDO — per-case state + deadline reminder alarm (CLAUDE.md §3, §12.5).
//
// When a case's response deadline is set, the DO schedules a single alarm for a
// sensible lead time before the deadline (default: 2 days prior). On alarm it marks
// the reminder as due so the UI/case can surface it, and — only if Composio is
// enabled — best-effort triggers the calendar reminder (P3-I). The Composio call is
// optional and never a hard dependency: failures are swallowed.
//
// Bound as CASE_DO in wrangler.jsonc. The deadline itself is always computed by the
// deterministic engine (CLAUDE.md §1.3) — this DO only schedules a reminder for it.

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LEAD_DAYS = 2;
const STORAGE_KEY = "reminder";

export interface CaseReminderState {
  caseId: string;
  responseDeadlineISO: string;
  leadDays: number;
  reminderAtMs: number | null; // scheduled alarm time, or null if none scheduled
  reminderDue: boolean;
  reminderFiredAtISO: string | null;
}

/**
 * Pure scheduling logic: compute when a deadline reminder alarm should fire.
 *
 * Guarantees (so the DO never schedules an alarm in the past):
 *   - Returns null when the deadline is unparseable or already at/after now
 *     (a reminder for a passed deadline is useless).
 *   - Otherwise returns `deadline - leadDays`, clamped to `nowMs` so the result
 *     is always >= now.
 *
 * The deadline is anchored at UTC midnight of its calendar date.
 */
export function computeReminderAt(
  responseDeadlineISO: string,
  nowMs: number,
  leadDays: number = DEFAULT_LEAD_DAYS,
): number | null {
  const deadlineMs = Date.parse(`${responseDeadlineISO}T00:00:00Z`);
  if (Number.isNaN(deadlineMs)) return null;
  if (deadlineMs <= nowMs) return null;

  const target = deadlineMs - leadDays * DAY_MS;
  return target <= nowMs ? nowMs : target;
}

interface CaseDOEnv {
  COMPOSIO_API_KEY?: string;
}

export class CaseDO extends DurableObject<CaseDOEnv> {
  /**
   * Record the case's response deadline and schedule a reminder alarm for a
   * lead time before it. Returns the scheduled alarm time (ms epoch) or null if
   * no reminder was scheduled (deadline missing/invalid/already passed).
   */
  async setDeadline(
    caseId: string,
    responseDeadlineISO: string,
    leadDays: number = DEFAULT_LEAD_DAYS,
  ): Promise<{ scheduled: boolean; reminderAtMs: number | null }> {
    const reminderAtMs = computeReminderAt(
      responseDeadlineISO,
      Date.now(),
      leadDays,
    );

    const state: CaseReminderState = {
      caseId,
      responseDeadlineISO,
      leadDays,
      reminderAtMs,
      reminderDue: false,
      reminderFiredAtISO: null,
    };
    await this.ctx.storage.put(STORAGE_KEY, state);

    if (reminderAtMs !== null) {
      await this.ctx.storage.setAlarm(reminderAtMs);
    }

    return { scheduled: reminderAtMs !== null, reminderAtMs };
  }

  /** Read the current reminder state for this case, if any. */
  async getState(): Promise<CaseReminderState | null> {
    return (await this.ctx.storage.get<CaseReminderState>(STORAGE_KEY)) ?? null;
  }

  /**
   * Fired by the Durable Object alarm when the reminder lead time is reached.
   * Marks the reminder due and, only if Composio is enabled, best-effort fires
   * the calendar reminder. Never hard-depends on Composio (P3-I).
   */
  override async alarm(): Promise<void> {
    const state = await this.ctx.storage.get<CaseReminderState>(STORAGE_KEY);
    if (!state) return;

    const updated: CaseReminderState = {
      ...state,
      reminderDue: true,
      reminderFiredAtISO: new Date().toISOString(),
    };
    await this.ctx.storage.put(STORAGE_KEY, updated);

    await this.maybeTriggerComposioReminder(updated);
  }

  /**
   * Optional Composio reminder. Enabled only when COMPOSIO_API_KEY is present.
   * Dynamically imported and fully guarded so a missing/stub implementation or a
   * runtime failure never breaks the alarm.
   */
  private async maybeTriggerComposioReminder(
    state: CaseReminderState,
  ): Promise<void> {
    if (!this.env.COMPOSIO_API_KEY) return;
    try {
      const actions = await import("../lib/actions");
      await actions.createReminder(state.caseId, state.responseDeadlineISO);
    } catch {
      // Enhancement-tier and best-effort: swallow. The reminder is already
      // marked due in storage regardless of Composio availability.
    }
  }
}
