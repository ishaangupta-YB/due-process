"use client";

import { useRef, useState } from "react";

export interface IntakeSubmission {
  imageBase64?: string;
  text?: string;
  language: string;
}

const LANGUAGES: Array<{ code: string; label: string }> = [
  { code: "en", label: "English" },
  { code: "es", label: "Español (Spanish)" },
  { code: "zh", label: "中文 (Chinese)" },
  { code: "vi", label: "Tiếng Việt (Vietnamese)" },
  { code: "tl", label: "Tagalog" },
  { code: "ko", label: "한국어 (Korean)" },
];

type Mode = "photo" | "text";

export function IntakeStep({
  onSubmit,
  loading,
  language,
  onLanguageChange,
}: {
  onSubmit: (input: IntakeSubmission) => void;
  loading: boolean;
  language: string;
  onLanguageChange: (lang: string) => void;
}) {
  const [mode, setMode] = useState<Mode>("photo");
  const [text, setText] = useState("");
  const [imageBase64, setImageBase64] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  function handleFile(file: File | undefined) {
    if (!file) return;
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result);
      setPreviewUrl(result);
      // Strip the "data:<mime>;base64," prefix — the API accepts bare base64.
      setImageBase64(result.includes(",") ? result.split(",")[1] : result);
    };
    reader.readAsDataURL(file);
  }

  const canSubmit =
    !loading && (mode === "photo" ? !!imageBase64 : text.trim().length > 0);

  function submit() {
    if (!canSubmit) return;
    onSubmit({
      imageBase64: mode === "photo" ? imageBase64 ?? undefined : undefined,
      text: mode === "text" ? text.trim() : undefined,
      language,
    });
  }

  return (
    <section className="card" aria-labelledby="intake-h">
      <span className="card__step">
        <span className="card__step-num">1</span> Read your notice
      </span>
      <h2 id="intake-h">Start with your court papers</h2>
      <p className="lead">
        Upload a clear photo of the Summons &amp; Complaint you were served, or
        type / paste what it says. We read it to find the key facts — we never
        guess.
      </p>

      <div className="field">
        <label htmlFor="lang">Your language</label>
        <select
          id="lang"
          value={language}
          onChange={(e) => onLanguageChange(e.target.value)}
        >
          {LANGUAGES.map((l) => (
            <option key={l.code} value={l.code}>
              {l.label}
            </option>
          ))}
        </select>
      </div>

      <div
        className="segmented"
        role="group"
        aria-label="How do you want to provide your notice?"
      >
        <button
          type="button"
          aria-pressed={mode === "photo"}
          onClick={() => setMode("photo")}
        >
          Upload photo
        </button>
        <button
          type="button"
          aria-pressed={mode === "text"}
          onClick={() => setMode("text")}
        >
          Paste / type text
        </button>
      </div>

      {mode === "photo" ? (
        <div className="field">
          <label htmlFor="file">Photo of your notice</label>
          <input
            ref={fileRef}
            id="file"
            type="file"
            accept="image/*"
            capture="environment"
            className="sr-only"
            onChange={(e) => handleFile(e.target.files?.[0])}
          />
          <div className="dropzone">
            <button
              type="button"
              className="btn btn--secondary"
              onClick={() => fileRef.current?.click()}
            >
              {fileName ? "Choose a different photo" : "Choose or take a photo"}
            </button>
            {previewUrl && (
              <>
                <p className="hint">{fileName}</p>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={previewUrl} alt="Preview of the notice you uploaded" />
              </>
            )}
          </div>
          <p className="hint">
            Your image is used only to read the facts. Make sure the dates and
            names are in focus.
          </p>
        </div>
      ) : (
        <div className="field">
          <label htmlFor="notice-text">What does your notice say?</label>
          <textarea
            id="notice-text"
            value={text}
            placeholder="e.g. I was handed a Summons and Complaint for unlawful detainer on June 2, 2026. The reason is nonpayment of rent…"
            onChange={(e) => setText(e.target.value)}
          />
          <p className="hint">
            Include the date you were served and how it was delivered if you
            know it.
          </p>
        </div>
      )}

      <button
        type="button"
        className="btn btn--block"
        disabled={!canSubmit}
        onClick={submit}
      >
        {loading ? (
          <>
            <span className="spinner" aria-hidden="true" /> Reading your
            notice…
          </>
        ) : (
          "Read my notice"
        )}
      </button>
    </section>
  );
}
