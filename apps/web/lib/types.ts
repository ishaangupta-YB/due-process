// lib/types.ts — the contract (CLAUDE.md §7). Canonical. Other modules import from here.
// Do not duplicate or fork these shapes.

export type ServiceMethod = "personal" | "substituted" | "posted_mail" | "unknown";

export interface NoticeFacts {
  noticeType: string;            // e.g. "Summons + Complaint (Unlawful Detainer)"
  serviceDateISO: string | null; // date served, ISO yyyy-mm-dd; null if not found
  serviceMethod: ServiceMethod;
  jurisdiction: "CA";
  parties: { landlord?: string; tenant?: string };
  statedReason: string | null;   // e.g. "nonpayment of rent"
  extractionConfidence: number;  // 0..1 from the extraction step
  unreadableFields: string[];    // fields the model could not read confidently
}

export interface DeadlineResult {
  responseDeadlineISO: string | null; // computed date, or null if inputs insufficient
  courtDaysUsed: number;               // 10 for personal service
  serviceMethod: ServiceMethod;
  assumptions: string[];               // human-readable assumptions made
  mustVerify: true;                    // ALWAYS true — user must confirm with court
  holidayCalendarVersion: string;      // e.g. "CA-courts-2026"
}

export interface Citation {
  sourceId: string;
  sourceTitle: string;
  url: string;       // must be a real indexed source URL, never fabricated
  snippet: string;   // <= 25 words, paraphrase-safe excerpt
}

export interface GroundedAnswer {
  status: "answered" | "abstained";
  answerMarkdown?: string;     // present only when status === "answered"
  citations: Citation[];       // >= 1 required when answered; [] when abstained
  abstainReason?: string;      // present only when status === "abstained"
  referral: { text: string; url: string }; // legal-aid handoff — ALWAYS present
}

export interface QAEntry { questionText: string; result: GroundedAnswer; atISO: string; }

export interface CaseRecord {
  id: string;
  createdAtISO: string;
  language: string;            // BCP-47, e.g. "en", "es"
  noticeFacts: NoticeFacts | null;
  deadline: DeadlineResult | null;
  qaHistory: QAEntry[];
  documentKeys: string[];      // R2 keys of generated drafts
}
