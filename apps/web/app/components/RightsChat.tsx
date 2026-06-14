"use client";

import { useState } from "react";
import type { GroundedAnswer } from "@/lib/types";
import { Markdown } from "./Markdown";

interface Turn {
  question: string;
  answer?: GroundedAnswer;
  error?: string;
}

const SUGGESTED = [
  "How many days do I have to respond?",
  "What happens if I don't respond in time?",
  "Can I be evicted for not paying rent?",
];

function AnswerCard({ answer }: { answer: GroundedAnswer }) {
  const abstained = answer.status === "abstained";
  return (
    <div className={`bubble ${abstained ? "bubble--abstain" : "bubble--a"}`}>
      <span
        className={`answer-status ${
          abstained ? "answer-status--abstain" : "answer-status--answered"
        }`}
      >
        {abstained ? "I'm not sure — here's where to get help" : "Grounded answer"}
      </span>

      {abstained ? (
        <p>
          {answer.abstainReason ??
            "I couldn't find a reliable, citable source to answer this, so I won't guess."}
        </p>
      ) : (
        <Markdown source={answer.answerMarkdown ?? ""} />
      )}

      {answer.citations.length > 0 && (
        <div className="citations">
          <span className="citations__title">Sources</span>
          {answer.citations.map((c, i) => (
            <a
              key={`${c.sourceId}-${i}`}
              className="citation"
              href={c.url}
              target="_blank"
              rel="noopener noreferrer"
            >
              <span className="citation__title">{c.sourceTitle} ↗</span>
              {c.snippet && <span className="citation__snippet">“{c.snippet}”</span>}
            </a>
          ))}
        </div>
      )}

      <p className="referral note note--info">
        {answer.referral.text}{" "}
        <a href={answer.referral.url} target="_blank" rel="noopener noreferrer">
          Find legal-aid help ↗
        </a>
      </p>
    </div>
  );
}

export function RightsChat({
  caseId,
  language,
}: {
  caseId: string | null;
  language: string;
}) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);

  async function ask(question: string) {
    const q = question.trim();
    if (!q || loading) return;
    setInput("");
    const index = turns.length;
    setTurns((t) => [...t, { question: q }]);
    setLoading(true);
    try {
      const res = await fetch("/api/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ caseId: caseId ?? undefined, questionText: q, language }),
      });
      const data = (await res.json()) as
        | { ok: true; answer: GroundedAnswer }
        | { ok: false; error: string };
      setTurns((t) => {
        const next = [...t];
        if (data.ok) next[index] = { question: q, answer: data.answer };
        else next[index] = { question: q, error: data.error };
        return next;
      });
    } catch (err) {
      setTurns((t) => {
        const next = [...t];
        next[index] = {
          question: q,
          error: err instanceof Error ? err.message : "Something went wrong.",
        };
        return next;
      });
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="card" aria-labelledby="chat-h">
      <span className="card__step">
        <span className="card__step-num">4</span> Ask about your rights
      </span>
      <h2 id="chat-h">Questions about your situation</h2>
      <p className="lead">
        Answers come only from official California legal sources, with links you
        can check. If we&apos;re not sure, we&apos;ll say so and point you to a
        clinic — we never guess.
      </p>

      {turns.length === 0 && (
        <div className="btn-row" style={{ marginBottom: "1rem" }}>
          {SUGGESTED.map((s) => (
            <button
              key={s}
              type="button"
              className="btn btn--secondary"
              style={{ fontSize: "0.92rem", padding: "0.5rem 0.8rem" }}
              onClick={() => ask(s)}
              disabled={loading}
            >
              {s}
            </button>
          ))}
        </div>
      )}

      <div className="qa" aria-live="polite">
        {turns.map((turn, i) => (
          <div key={i} className="qa">
            <div className="bubble bubble--q">{turn.question}</div>
            {turn.answer && <AnswerCard answer={turn.answer} />}
            {turn.error && (
              <div className="bubble bubble--a note--error">
                Sorry, something went wrong: {turn.error}
              </div>
            )}
            {!turn.answer && !turn.error && (
              <div className="bubble bubble--a">
                <span className="spinner" aria-hidden="true" /> Checking the
                sources…
              </div>
            )}
          </div>
        ))}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          ask(input);
        }}
        style={{ marginTop: turns.length ? "1rem" : 0 }}
      >
        <label htmlFor="question" className="sr-only">
          Type your question
        </label>
        <textarea
          id="question"
          value={input}
          placeholder="Ask a question about your eviction case…"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              ask(input);
            }
          }}
          style={{ minHeight: "4.5rem" }}
        />
        <button
          type="submit"
          className="btn btn--block"
          disabled={loading || !input.trim()}
          style={{ marginTop: "0.6rem" }}
        >
          {loading ? (
            <>
              <span className="spinner" aria-hidden="true" /> Checking…
            </>
          ) : (
            "Ask"
          )}
        </button>
      </form>
    </section>
  );
}
