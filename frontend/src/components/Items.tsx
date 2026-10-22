import { useState } from "react";
import type { Decision, Item } from "../types";
import { Markdown } from "./Markdown";

type Message = Extract<Item, { kind: "message" }>;

export function MessageView({ m }: { m: Message }) {
  return (
    <article className={`msg ${m.role}${m.streaming ? " streaming" : ""}`} aria-label={m.role === "user" ? "Du" : "Hermes"}>
      {m.reasoning && (
        <details className="reasoning">
          <summary>Überlegung</summary>
          <p className="mono">{m.reasoning}</p>
        </details>
      )}
      {m.images.length > 0 && (
        <div className="thumbs">{m.images.map((src, i) => <img key={i} src={src} alt={`Anhang ${i + 1}`} />)}</div>
      )}
      {m.role === "user" ? <p className="plain">{m.text}</p> : m.text ? <Markdown text={m.text} /> : <span className="dots" aria-label="Hermes schreibt">…</span>}
    </article>
  );
}

export function ToolCard({ t }: { t: Extract<Item, { kind: "tool" }> }) {
  const [open, setOpen] = useState(false);
  const detail = [t.preview && `» ${t.preview}`, t.output].filter(Boolean).join("\n\n");
  return (
    <div className={`tool ${t.status}`}>
      <button type="button" className="tool-head" aria-expanded={open} onClick={() => setOpen(!open)} disabled={!detail}>
        <span className={`dot ${t.status}`} aria-hidden />
        <span className="mono name">{t.name}</span>
        <span className="mono muted">
          {t.status === "running" ? "läuft" : t.status === "error" ? "Fehler" : "fertig"}
          {t.durationMs != null && ` · ${t.durationMs} ms`}
        </span>
      </button>
      {open && detail && <pre className="tool-body mono">{detail}</pre>}
    </div>
  );
}

const DECISIONS: Array<[Decision, string]> = [["once", "Einmal erlauben"], ["session", "Für Session"], ["always", "Immer"], ["deny", "Ablehnen"]];

export function ApprovalCard({ a, onDecide, disabled }: { a: Extract<Item, { kind: "approval" }>; onDecide: (d: Decision) => void; disabled: boolean }) {
  return (
    <div className="card approval" role="group" aria-label="Freigabe nötig">
      <strong>Freigabe nötig</strong>
      {a.reason && <p className="muted">{a.reason}</p>}
      <pre className="mono">{a.command}</pre>
      {a.decision ? (
        <p className="muted">Entscheidung: {DECISIONS.find(([d]) => d === a.decision)?.[1]}</p>
      ) : (
        <div className="row">
          {DECISIONS.map(([d, label]) => (
            <button key={d} type="button" className={d === "deny" ? "danger" : d === "once" ? "primary" : "ghost"} disabled={disabled} onClick={() => onDecide(d)}>{label}</button>
          ))}
        </div>
      )}
      {!a.decision && <p className="muted small">Die Anfrage erlischt nach {Math.round(a.timeoutS / 60)} Minuten.</p>}
    </div>
  );
}

export function ClarifyCard({ c, onAnswer }: { c: Extract<Item, { kind: "clarify" }>; onAnswer: (a: string) => void }) {
  const [text, setText] = useState("");
  return (
    <div className="card clarify" role="group" aria-label="Rückfrage von Hermes">
      <strong>Rückfrage</strong>
      <p>{c.question}</p>
      {c.answer ? (
        <p className="muted">Antwort: {c.answer}</p>
      ) : (
        <>
          {c.choices.length > 0 && (
            <div className="row">{c.choices.map((x) => <button key={x} type="button" className="ghost" onClick={() => onAnswer(x)}>{x}</button>)}</div>
          )}
          <form className="row" onSubmit={(e) => { e.preventDefault(); if (text.trim()) onAnswer(text.trim()); }}>
            <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Eigene Antwort" aria-label="Eigene Antwort" />
            <button type="submit" className="primary" disabled={!text.trim()}>Senden</button>
          </form>
        </>
      )}
    </div>
  );
}
