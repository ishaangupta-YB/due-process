import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { z } from "zod";
import { createCase, getCase } from "@/lib/db";
import { addCaseMemory, type MemoryItem } from "@/lib/memory";
import type { CaseRecord } from "@/lib/types";
import type { CaseReminderState } from "@/durable-objects/case-do";

// POST /api/case — create a case (D1) + seed mem0 facts + schedule the deadline
//   reminder via the Case Durable Object.
// GET  /api/case?id= — fetch the case (D1 is the source of truth) + DO reminder state.
//
// D1 is authoritative. mem0 (cross-session memory) and the DO reminder are
// enhancements: their failures are logged-free and never break case creation/fetch.

// A minimal RPC view of the CaseDO stub (matches durable-objects/case-do.ts).
interface CaseDOStub {
  setDeadline(
    caseId: string,
    responseDeadlineISO: string,
  ): Promise<{ scheduled: boolean; reminderAtMs: number | null }>;
  getState(): Promise<CaseReminderState | null>;
}

interface CaseDONamespace {
  idFromName(name: string): unknown;
  get(id: unknown): CaseDOStub;
}

function getCaseDO(): CaseDONamespace | null {
  const { env } = getCloudflareContext();
  return (env as { CASE_DO?: CaseDONamespace }).CASE_DO ?? null;
}

const createBodySchema = z.object({
  language: z.string().min(1),
  // noticeFacts and deadline are validated in full by db.createCase (zod);
  // here we just allow them through as optional.
  noticeFacts: z.unknown().optional(),
  deadline: z.unknown().optional(),
});

/** Build the structured mem0 facts to seed for a new case. Facts only — no PII blobs. */
function seedMemories(record: CaseRecord): MemoryItem[] {
  const items: MemoryItem[] = [];
  const f = record.noticeFacts;
  if (f) {
    items.push({
      kind: "fact",
      text: `Notice type: ${f.noticeType}; service date: ${
        f.serviceDateISO ?? "unknown"
      }; service method: ${f.serviceMethod}; reason: ${
        f.statedReason ?? "unknown"
      }.`,
      metadata: {
        serviceMethod: f.serviceMethod,
        serviceDateISO: f.serviceDateISO,
      },
    });
  }
  if (record.deadline?.responseDeadlineISO) {
    items.push({
      kind: "deadline",
      text: `Response deadline ${record.deadline.responseDeadlineISO} (${record.deadline.courtDaysUsed} court days, ${record.deadline.serviceMethod} service).`,
      metadata: { responseDeadlineISO: record.deadline.responseDeadlineISO },
    });
  }
  return items;
}

export async function POST(req: Request): Promise<Response> {
  let parsed: z.infer<typeof createBodySchema>;
  try {
    parsed = createBodySchema.parse(await req.json());
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: `invalid request body: ${(err as Error).message}` },
      { status: 400 },
    );
  }

  const record: CaseRecord = {
    id: crypto.randomUUID(),
    createdAtISO: new Date().toISOString(),
    language: parsed.language,
    noticeFacts: (parsed.noticeFacts as CaseRecord["noticeFacts"]) ?? null,
    deadline: (parsed.deadline as CaseRecord["deadline"]) ?? null,
    qaHistory: [],
    documentKeys: [],
  };

  try {
    // 1. Persist to D1 (authoritative). createCase validates the full shape via zod.
    await createCase(record);
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: `failed to create case: ${(err as Error).message}` },
      { status: 400 },
    );
  }

  // 2. Seed cross-session memory (best-effort enhancement).
  try {
    await addCaseMemory(record.id, seedMemories(record));
  } catch {
    // mem0 is an enhancement; never block case creation on it.
  }

  // 3. Schedule the deadline reminder via the Case DO (best-effort enhancement).
  let reminderAtMs: number | null = null;
  try {
    const ns = getCaseDO();
    if (ns && record.deadline?.responseDeadlineISO) {
      const stub = ns.get(ns.idFromName(record.id));
      const res = await stub.setDeadline(
        record.id,
        record.deadline.responseDeadlineISO,
      );
      reminderAtMs = res.reminderAtMs;
    }
  } catch {
    // DO reminder is an enhancement; never block case creation on it.
  }

  return NextResponse.json({ ok: true, case: record, reminderAtMs });
}

export async function GET(req: Request): Promise<Response> {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) {
    return NextResponse.json(
      { ok: false, error: "missing required query param: id" },
      { status: 400 },
    );
  }

  let record: CaseRecord | null;
  try {
    record = await getCase(id);
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: `failed to fetch case: ${(err as Error).message}` },
      { status: 500 },
    );
  }
  if (!record) {
    return NextResponse.json(
      { ok: false, error: "case not found" },
      { status: 404 },
    );
  }

  // Surface the DO reminder state alongside the case (best-effort enhancement).
  let reminder: CaseReminderState | null = null;
  try {
    const ns = getCaseDO();
    if (ns) reminder = await ns.get(ns.idFromName(id)).getState();
  } catch {
    // ignore — reminder state is supplementary.
  }

  return NextResponse.json({ ok: true, case: record, reminder });
}
