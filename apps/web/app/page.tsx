"use client";

import { useState } from "react";
import type { DeadlineResult, NoticeFacts, ServiceMethod } from "@/lib/types";
import { IntakeStep, type IntakeSubmission } from "./components/IntakeStep";
import { NoticeFactsStep } from "./components/NoticeFactsStep";
import { DeadlineCountdown } from "./components/DeadlineCountdown";
import { RightsChat } from "./components/RightsChat";
import { DocumentStep } from "./components/DocumentStep";
import { ActionsStep } from "./components/ActionsStep";

export default function Home() {
  const [language, setLanguage] = useState("en");
  const [facts, setFacts] = useState<NoticeFacts | null>(null);
  const [deadline, setDeadline] = useState<DeadlineResult | null>(null);
  const [caseId, setCaseId] = useState<string | null>(null);

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
  }

  return (
    <>
      <header style={{ marginBottom: "1.5rem" }}>
        <h1>You were served eviction papers. Let&apos;s respond in time.</h1>
        <p className="lead">
          DueProcess helps California tenants understand their court papers,
          find their response deadline, and prepare a draft Answer — calmly, in
          plain language. It is information and document prep, not legal advice.
        </p>
      </header>

      {error && (
        <p className="note note--error" role="alert">
          {error}
        </p>
      )}

      {!facts && (
        <IntakeStep
          onSubmit={handleIntake}
          loading={intakeLoading}
          language={language}
          onLanguageChange={setLanguage}
        />
      )}

      {facts && !deadline && (
        <NoticeFactsStep
          facts={facts}
          onConfirm={handleConfirmFacts}
          loading={deadlineLoading}
        />
      )}

      {deadline && (
        <>
          <DeadlineCountdown deadline={deadline} />
          <RightsChat caseId={caseId} language={language} />
          <DocumentStep caseId={caseId} />
          <ActionsStep caseId={caseId} deadlineISO={deadline.responseDeadlineISO} />
        </>
      )}

      {facts && (
        <div className="btn-row" style={{ marginTop: "0.5rem" }}>
          <button type="button" className="btn btn--secondary" onClick={reset}>
            Start over with a new notice
          </button>
        </div>
      )}
    </>
  );
}
