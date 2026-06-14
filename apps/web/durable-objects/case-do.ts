import { DurableObject } from "cloudflare:workers";

// CaseDO — per-case state + deadline reminder alarm (CLAUDE.md §3, §12.5).
// STUB (P0). Wave 3 (enhancement) implements the alarm() to proactively watch the
// response deadline and trigger a reminder. Bound as CASE_DO in wrangler.jsonc.
export class CaseDO extends DurableObject {
  // Fired by the Durable Object alarm when the deadline reminder is due.
  // STUB (P0). Wave 3 (enhancement) implements the proactive deadline reminder.
  override async alarm(): Promise<void> {
    // no-op stub
  }
}
