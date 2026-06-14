"use client";

import { useState } from "react";
import type { NoticeFacts, ServiceMethod } from "@/lib/types";

const METHOD_LABELS: Record<ServiceMethod, string> = {
  personal: "Personal — handed to me in person",
  substituted: "Substituted — left with someone else / at home or work",
  posted_mail: "Posted & mailed — taped to the door and mailed",
  unknown: "I'm not sure",
};

function confidenceBadge(c: number) {
  if (c >= 0.66)
    return <span className="badge badge--ok">High confidence</span>;
  return <span className="badge badge--warn">Please double-check</span>;
}

export function NoticeFactsStep({
  facts,
  onConfirm,
  loading,
}: {
  facts: NoticeFacts;
  onConfirm: (serviceDateISO: string | null, serviceMethod: ServiceMethod) => void;
  loading: boolean;
}) {
  const [serviceDate, setServiceDate] = useState(facts.serviceDateISO ?? "");
  const [method, setMethod] = useState<ServiceMethod>(facts.serviceMethod);

  return (
    <section className="card" aria-labelledby="facts-h">
      <span className="card__step">
        <span className="card__step-num">2</span> What we found
      </span>
      <h2 id="facts-h">
        Here&apos;s what we read {confidenceBadge(facts.extractionConfidence)}
      </h2>
      <p className="lead">
        Check these against your papers and fix anything that&apos;s wrong — the
        deadline depends on the date and how you were served.
      </p>

      <dl className="facts">
        <div className="fact">
          <dt>Notice type</dt>
          <dd>{facts.noticeType || "Not detected"}</dd>
        </div>
        {(facts.parties.landlord || facts.parties.tenant) && (
          <div className="fact">
            <dt>Parties</dt>
            <dd>
              {facts.parties.landlord && (
                <>Landlord: {facts.parties.landlord}. </>
              )}
              {facts.parties.tenant && <>Tenant: {facts.parties.tenant}.</>}
            </dd>
          </div>
        )}
        {facts.statedReason && (
          <div className="fact">
            <dt>Stated reason</dt>
            <dd>{facts.statedReason}</dd>
          </div>
        )}
      </dl>

      {facts.unreadableFields.length > 0 && (
        <p className="note note--info">
          We couldn&apos;t read these clearly:{" "}
          <strong>{facts.unreadableFields.join(", ")}</strong>. Please fill them
          in below.
        </p>
      )}

      <div className="field" style={{ marginTop: "1.25rem" }}>
        <label htmlFor="service-date">Date you were served</label>
        <input
          id="service-date"
          type="date"
          value={serviceDate}
          onChange={(e) => setServiceDate(e.target.value)}
        />
        <p className="hint">
          The day the papers were delivered to you (not the date printed on the
          form).
        </p>
      </div>

      <div className="field">
        <label htmlFor="service-method">How were you served?</label>
        <select
          id="service-method"
          value={method}
          onChange={(e) => setMethod(e.target.value as ServiceMethod)}
        >
          {(Object.keys(METHOD_LABELS) as ServiceMethod[]).map((m) => (
            <option key={m} value={m}>
              {METHOD_LABELS[m]}
            </option>
          ))}
        </select>
      </div>

      <button
        type="button"
        className="btn btn--block"
        disabled={loading}
        onClick={() => onConfirm(serviceDate || null, method)}
      >
        {loading ? (
          <>
            <span className="spinner" aria-hidden="true" /> Calculating your
            deadline…
          </>
        ) : (
          "Calculate my deadline"
        )}
      </button>
    </section>
  );
}
