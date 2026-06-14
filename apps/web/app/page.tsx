"use client";

import { useState } from "react";
import type { DeadlineResult, NoticeFacts, ServiceMethod } from "@/lib/types";
import { IntakeStep, type IntakeSubmission } from "./components/IntakeStep";
import { NoticeFactsStep } from "./components/NoticeFactsStep";
import { DeadlineCountdown } from "./components/DeadlineCountdown";
import { RightsChat } from "./components/RightsChat";
import { DocumentStep } from "./components/DocumentStep";
import { ActionsStep } from "./components/ActionsStep";

type Tab = "rights" | "draft" | "help";

const SERVICE_LABELS: Record<ServiceMethod, string> = {
  personal: "Personal",
  substituted: "Substituted",
  posted_mail: "Posted & mailed",
  unknown: "Not sure",
};

const STEPS = ["Read", "Confirm", "Respond"] as const;

function formatShortDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

/* ---- tiny inline line-icons (stroke = currentColor) ---- */
const iconProps = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.7,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

function ScanIcon({ className }: { className?: string }) {
  return (
    <svg {...iconProps} className={className}>
      <path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3" />
      <path d="M8 12h8" />
    </svg>
  );
}
function ClockIcon({ className }: { className?: string }) {
  return (
    <svg {...iconProps} className={className}>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 8v4l2.5 1.5" />
    </svg>
  );
}
function QuoteIcon({ className }: { className?: string }) {
  return (
    <svg {...iconProps} className={className}>
      <path d="M9 7H5a1 1 0 0 0-1 1v4a1 1 0 0 0 1 1h3v3a3 3 0 0 1-3 3" />
      <path d="M19 7h-4a1 1 0 0 0-1 1v4a1 1 0 0 0 1 1h3v3a3 3 0 0 1-3 3" />
    </svg>
  );
}
function ChatIcon({ className }: { className?: string }) {
  return (
    <svg {...iconProps} className={className}>
      <path d="M21 12a8 8 0 0 1-11.5 7.2L4 20l.8-5.5A8 8 0 1 1 21 12Z" />
      <path d="M9 11h6M9 14h4" />
    </svg>
  );
}
function FileIcon({ className }: { className?: string }) {
  return (
    <svg {...iconProps} className={className}>
      <path d="M14 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7Z" />
      <path d="M14 3v4h4M9 13h6M9 17h6" />
    </svg>
  );
}
function LifebuoyIcon({ className }: { className?: string }) {
  return (
    <svg {...iconProps} className={className}>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="3" />
      <path d="m6.3 6.3 3.2 3.2M14.5 14.5l3.2 3.2M17.7 6.3l-3.2 3.2M9.5 14.5l-3.2 3.2" />
    </svg>
  );
}

const TABS: Array<{ id: Tab; label: string; icon: typeof ChatIcon }> = [
  { id: "rights", label: "Your rights", icon: ChatIcon },
  { id: "draft", label: "Draft Answer", icon: FileIcon },
  { id: "help", label: "Get help", icon: LifebuoyIcon },
];

export default function Home() {
  const [language, setLanguage] = useState("en");
  const [facts, setFacts] = useState<NoticeFacts | null>(null);
  const [deadline, setDeadline] = useState<DeadlineResult | null>(null);
  const [caseId, setCaseId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>("rights");

  const [intakeLoading, setIntakeLoading] = useState(false);
  const [deadlineLoading, setDeadlineLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleIntake(input: IntakeSubmission) {
    setError(null);
    setIntakeLoading(true);
    try {
      const res = await fetch("/api/intake", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      const data = (await res.json()) as
        | { ok: true; noticeFacts: NoticeFacts }
        | { ok: false; error: string };
      if (data.ok) {
        setFacts(data.noticeFacts);
        setDeadline(null);
        setCaseId(null);
      } else {
        setError(data.error);
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "We couldn't read your notice. Please try again.",
      );
    } finally {
      setIntakeLoading(false);
    }
  }

  async function handleConfirmFacts(
    serviceDateISO: string | null,
    serviceMethod: ServiceMethod,
  ) {
    if (!facts) return;
    setError(null);
    setDeadlineLoading(true);

    const confirmedFacts: NoticeFacts = {
      ...facts,
      serviceDateISO,
      serviceMethod,
    };
    setFacts(confirmedFacts);

    try {
      // 1. Deterministic deadline (the hero) — never let the LLM compute this.
      const res = await fetch("/api/deadline", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serviceDateISO, serviceMethod }),
      });
      const data = (await res.json()) as
        | { ok: true; deadline: DeadlineResult }
        | { ok: false; error: string };
      if (!data.ok) {
        setError(data.error);
        return;
      }
      setDeadline(data.deadline);
      setActiveTab("rights");

      // 2. Create the case (enables Q&A history + document). Best-effort: if the
      //    backing stores aren't available, the deadline + chat still work.
      try {
        const caseRes = await fetch("/api/case", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            language,
            noticeFacts: confirmedFacts,
            deadline: data.deadline,
          }),
        });
        const caseData = (await caseRes.json()) as
          | { ok: true; case: { id: string } }
          | { ok: false; error: string };
        if (caseData.ok) setCaseId(caseData.case.id);
      } catch {
        // Non-fatal — document generation will prompt if no case exists.
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "We couldn't calculate your deadline. Please try again.",
      );
    } finally {
      setDeadlineLoading(false);
    }
  }

  function reset() {
    setFacts(null);
    setDeadline(null);
    setCaseId(null);
    setError(null);
    setActiveTab("rights");
  }

  // 0 = Read, 1 = Confirm, 2 = Respond
  const phase = deadline ? 2 : facts ? 1 : 0;

  return (
    <div className="app-flow">
      <ol className="stepper" aria-label="Your progress">
        {STEPS.map((label, i) => (
          <li key={label} style={{ display: "contents" }}>
            <span
              className={`step ${
                i === phase ? "step--active" : i < phase ? "step--done" : ""
              }`}
              aria-current={i === phase ? "step" : undefined}
            >
              <span className="step__num">{i < phase ? "✓" : i + 1}</span>
              <span className="step__label">{label}</span>
            </span>
            {i < STEPS.length - 1 && (
              <span className="step__bar" aria-hidden="true" />
            )}
          </li>
        ))}
      </ol>

      {error && (
        <p
          className="note note--error"
          role="alert"
          style={{ maxWidth: "var(--maxw)", margin: "0 auto 1.25rem" }}
        >
          {error}
        </p>
      )}

      {/* ---------- Phase 1 · Read ---------- */}
      {!facts && (
        <div className="phase">
          <header className="hero">
            <span className="hero__eyebrow">California · Unlawful detainer</span>
            <h1>
              You were served eviction papers.
              <br />
              Let&apos;s respond <span className="mark">in time</span>.
            </h1>
            <p className="lead">
              DueProcess helps California tenants read their court papers, find
              their response deadline, and prepare a draft Answer — calmly, in
              plain language. It is information and document prep, not legal
              advice.
            </p>
          </header>

          <IntakeStep
            onSubmit={handleIntake}
            loading={intakeLoading}
            language={language}
            onLanguageChange={setLanguage}
          />

          <div className="trust-strip">
            <div className="feature">
              <ScanIcon className="feature__icon" />
              <span className="feature__title">Reads your notice</span>
              <span className="feature__text">
                Pulls the key facts from a photo, text, or your voice — in your
                language.
              </span>
            </div>
            <div className="feature">
              <ClockIcon className="feature__icon" />
              <span className="feature__title">Finds your real deadline</span>
              <span className="feature__text">
                Your response date is computed in code from current California
                law, never guessed.
              </span>
            </div>
            <div className="feature">
              <QuoteIcon className="feature__icon" />
              <span className="feature__title">Cites official sources</span>
              <span className="feature__text">
                Answers link to California courts and statutes — or we say we
                aren&apos;t sure.
              </span>
            </div>
          </div>
        </div>
      )}

      {/* ---------- Phase 2 · Confirm ---------- */}
      {facts && !deadline && (
        <div className="phase">
          <NoticeFactsStep
            facts={facts}
            onConfirm={handleConfirmFacts}
            loading={deadlineLoading}
          />
        </div>
      )}

      {/* ---------- Phase 3 · Respond ---------- */}
      {deadline && (
        <div className="phase phase--wide">
          <DeadlineCountdown deadline={deadline} />

          {facts && (
            <div className="case-strip" aria-label="Your case at a glance">
              {facts.noticeType && (
                <span className="chip">
                  <span className="chip__key">Notice</span>
                  {facts.noticeType}
                </span>
              )}
              {facts.serviceDateISO && (
                <span className="chip">
                  <span className="chip__key">Served</span>
                  {formatShortDate(facts.serviceDateISO)}
                </span>
              )}
              <span className="chip">
                <span className="chip__key">Service</span>
                {SERVICE_LABELS[facts.serviceMethod]}
              </span>
            </div>
          )}

          <div className="tabs" role="tablist" aria-label="Next steps">
            {TABS.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                role="tab"
                id={`tab-${id}`}
                aria-selected={activeTab === id}
                aria-controls={`panel-${id}`}
                className="tab"
                onClick={() => setActiveTab(id)}
              >
                <Icon />
                <span className="tab__label">{label}</span>
              </button>
            ))}
          </div>

          <div
            className="tabpanel"
            role="tabpanel"
            id="panel-rights"
            aria-labelledby="tab-rights"
            hidden={activeTab !== "rights"}
          >
            <RightsChat caseId={caseId} language={language} />
          </div>
          <div
            className="tabpanel"
            role="tabpanel"
            id="panel-draft"
            aria-labelledby="tab-draft"
            hidden={activeTab !== "draft"}
          >
            <DocumentStep caseId={caseId} />
          </div>
          <div
            className="tabpanel"
            role="tabpanel"
            id="panel-help"
            aria-labelledby="tab-help"
            hidden={activeTab !== "help"}
          >
            <ActionsStep
              caseId={caseId}
              deadlineISO={deadline.responseDeadlineISO}
            />
          </div>
        </div>
      )}

      {facts && (
        <div
          className="btn-row"
          style={{ marginTop: "2rem", justifyContent: "center" }}
        >
          <button type="button" className="btn btn--secondary" onClick={reset}>
            Start over with a new notice
          </button>
        </div>
      )}
    </div>
  );
}
