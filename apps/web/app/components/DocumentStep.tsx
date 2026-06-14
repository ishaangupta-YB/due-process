"use client";

import { useState } from "react";

export function DocumentStep({ caseId }: { caseId: string | null }) {
  const [loading, setLoading] = useState(false);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function generate() {
    if (!caseId || loading) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/document", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ caseId }),
      });
      const data = (await res.json()) as
        | { ok: true; downloadUrl: string }
        | { ok: false; error: string };
      if (data.ok) setDownloadUrl(data.downloadUrl);
      else setError(data.error);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not generate the draft.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="card" aria-labelledby="doc-h">
      <span className="eyebrow">Draft Answer</span>
      <h2 id="doc-h">Generate your draft Answer (UD-105)</h2>
      <p className="lead">
        We&apos;ll prepare a plain-language draft based on your case to take to a
        legal-aid clinic. It is a starting point, not a finished court filing.
      </p>

      <p className="note note--verify">
        <strong>This is an unsigned DRAFT.</strong> Every page is watermarked
        &ldquo;DRAFT — review before filing.&rdquo; DueProcess does not file
        anything with the court. Review it with a licensed attorney or legal-aid
        clinic before you file.
      </p>

      {!caseId && (
        <p className="note note--info">
          Finish the steps above first — we need your notice facts and deadline
          to prepare the draft.
        </p>
      )}

      {error && (
        <p className="note note--error">
          We couldn&apos;t generate the draft: {error}
        </p>
      )}

      <div className="btn-row" style={{ marginTop: "1rem" }}>
        <button
          type="button"
          className="btn"
          disabled={!caseId || loading}
          onClick={generate}
        >
          {loading ? (
            <>
              <span className="spinner" aria-hidden="true" /> Preparing your
              draft…
            </>
          ) : downloadUrl ? (
            "Regenerate draft"
          ) : (
            "Generate my draft Answer"
          )}
        </button>

        {downloadUrl && (
          <a
            className="btn btn--secondary"
            href={downloadUrl}
            target="_blank"
            rel="noopener noreferrer"
            download
          >
            Download draft PDF ↓
          </a>
        )}
      </div>
    </section>
  );
}
