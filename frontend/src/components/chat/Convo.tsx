import { useState } from "react";
import { fmtClock, fmtDuration, fmtTime, toolIcon } from "../../format";
import type { Decision, Item, SendMode } from "../../types";
import { useNow } from "../../useNow";
import { Icon } from "../Icon";
import { MessageBody } from "./ContextChips";
import { Markdown } from "../Markdown";
import { Sigil } from "../Sigil";
import type { SigilConfig } from "../../types";

type Message = Extract<Item, { kind: "message" }>;
type Tool = Extract<Item, { kind: "tool" }>;
type Approval = Extract<Item, { kind: "approval" }>;
type Clarify = Extract<Item, { kind: "clarify" }>;
type Subagent = Extract<Item, { kind: "subagent" }>;

export type Turn = { kind: "user"; item: Message } | { kind: "agent"; items: Item[] };

/** Nutzernachrichten stehen einzeln, alles dazwischen bildet eine Antwortkarte des Agents. */
export function groupTurns(items: Item[]): Turn[] {
  const turns: Turn[] = [];
  for (const item of items) {
    if (item.kind === "message" && item.role === "user") turns.push({ kind: "user", item });
    else {
      const last = turns[turns.length - 1];
      if (last?.kind === "agent") last.items.push(item);
      else turns.push({ kind: "agent", items: [item] });
    }
  }
  return turns;
}

const MODE_TAG: Record<SendMode, string> = { steer: "STEER", queue: "QUEUE" };

export function UserMessage({ m }: { m: Message }) {
  return (
    <article className="umsg" aria-label="Du">
      {(m.mode || m.at) && (
        <div className="row umsg-head">
          {m.mode && <span className="tag tag-c">{MODE_TAG[m.mode]}</span>}
          {m.at && <span className="mono t3">{fmtTime(m.at)}</span>}
        </div>
      )}
      {m.images.length > 0 && (
        <div className="thumbs">{m.images.map((src, i) => <img key={i} src={src} alt={`Anhang ${i + 1}`} />)}</div>
      )}
      <MessageBody text={m.text} />
    </article>
  );
}

/** Denkprozess auf einmal verfügbar (kein Token-Strom): einklappbare Karte mit nummerierten Schritten. */
export function steps(text: string): string[] {
  const parts = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  return parts.length === 1 && parts[0].includes("\n") ? parts[0].split("\n").map((l) => l.trim()).filter(Boolean) : parts;
}

export function ReasoningCard({ text, defaultOpen }: { text: string; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const list = steps(text);
  return (
    <div className="rz">
      <button type="button" className="rz-h" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="spark" size={14} className="crimt" />
        <span style={{ fontWeight: 600, color: "var(--t1)" }}>Denkprozess</span>
        <span className="mono t3" style={{ fontSize: 11 }}>{list.length} {list.length === 1 ? "Schritt" : "Schritte"}</span>
        <span className="r"><Icon name={open ? "chevd" : "chevr"} size={12} /></span>
      </button>
      {open && list.map((s, i) => (
        <div className="rz-step" key={i}>
          <i className="rz-n">{String(i + 1).padStart(2, "0")}</i>
          <span className="bd">{s}</span>
        </div>
      ))}
    </div>
  );
}

export function ToolRow({ t, selected, open, onPick }: { t: Tool; selected: boolean; open: boolean; onPick: () => void }) {
  const detail = t.output ?? "";
  const arg = (t.preview ?? "").split("\n")[0];
  const cls = `tool${selected ? " sel" : ""}${selected && open ? " open" : ""}`;
  return (
    <div className="col tool-wrap">
      <button type="button" className={cls} aria-expanded={selected && open} onClick={onPick}>
        <Icon name={toolIcon(t.name)} size={14} className="t3" />
        <span className="nm">{t.name}</span>
        <span className="arg">{arg}</span>
        <span className="r">
          {t.durationMs != null && <span>{fmtDuration(t.durationMs)}</span>}
          {t.status === "running" && <i className="dot dot-run" role="img" aria-label="läuft" />}
          {t.status === "ok" && <span role="img" aria-label="fertig"><Icon name="check" size={14} className="t2" /></span>}
          {t.status === "error" && <span role="img" aria-label="Fehler"><Icon name="x" size={14} className="ruby" /></span>}
        </span>
      </button>
      {selected && open && <div className="toolout">{detail ? detail : <span className="t3">{t.status === "running" ? "läuft …" : "(keine Ausgabe)"}</span>}</div>}
    </div>
  );
}

export function SubagentCard({ s }: { s: Subagent }) {
  const running = s.status === "running";
  return (
    <div className={`sub${running ? " run" : ""}`} role="group" aria-label={`Subagent: ${s.title}`}>
      <div className="row" style={{ gap: 10 }}>
        <Icon name={s.status === "ok" ? "check" : s.status === "error" ? "x" : "cpu"} size={14} className={running ? "crimt" : s.status === "error" ? "ruby" : "t3"} />
        <span className="sub-title">{s.title}</span>
        {running
          ? <span className="tag tag-c" style={{ marginLeft: "auto" }}><i className="dot dot-run" />LÄUFT</span>
          : <span className={`tag${s.status === "error" ? " tag-e" : ""}`} style={{ marginLeft: "auto" }}>{s.status === "error" ? "FEHLER" : "FERTIG"}</span>}
      </div>
      {s.meta.length > 0 && <div className="meta">{s.meta.map((m, i) => <span key={i}>{m}</span>)}</div>}
      {s.note && <span className="mono t2" style={{ fontSize: 11.5 }}>{s.note}</span>}
    </div>
  );
}

const DECISION_LABEL: Record<Decision, string> = {
  once: "Einmal erlauben", session: "Für Session", always: "Immer", deny: "Ablehnen",
};
const DECISION_DONE: Record<Decision, string> = {
  once: "Einmal erlaubt", session: "Für diese Session erlaubt", always: "Dauerhaft erlaubt", deny: "Abgelehnt",
};
const DECISION_KEY: Record<Decision, string> = { once: "Enter", session: "S", always: "Shift+A", deny: "Esc" };

/** Freigabe mit den Wegen, die der Agent für diese Anfrage zulässt. Der Countdown zählt die 5 Minuten der Anfrage. */
export function ApprovalCard({ a, disabled, onDecide }: { a: Approval; disabled: boolean; onDecide: (d: Decision) => void }) {
  const pending = !a.decision;
  const now = useNow(pending);
  const left = a.timeoutS - (now - a.at) / 1000;
  const expired = pending && left <= 0;

  if (!pending) {
    return (
      <div className="apprdone" role="group" aria-label="Freigabe entschieden">
        <Icon name="shield" size={16} className="t2" />
        <div className="col grow" style={{ gap: 2, minWidth: 0 }}>
          <span style={{ fontWeight: 600, fontSize: 13 }}>{DECISION_DONE[a.decision!]}</span>
          <span className="mono t3 trunc" style={{ fontSize: 11 }}>{a.command}{a.decidedAt ? ` · ${fmtTime(a.decidedAt)}` : ""}</span>
        </div>
      </div>
    );
  }
  return (
    <div className="appr" role="group" aria-label="Freigabe nötig">
      <div className="row" style={{ gap: 10 }}>
        <Icon name="shield" size={16} className="crimt" />
        <span style={{ font: "600 14px var(--sans)" }}>Freigabe nötig</span>
        <span className="mono crimt appr-left">{expired ? "abgelaufen" : `erlischt in ${fmtClock(left)}`}</span>
      </div>
      {a.reason && <span className="t2" style={{ fontSize: 13 }}>{a.reason}</span>}
      <div className="cmd"><span className="t3">$</span><span className="cmd-text">{a.command}</span></div>
      <div className="btns ways">
        {/* Nur, was der Agent für diese Anfrage erlaubt (bei smart_denied z. B. nur einmal oder ablehnen). */}
        {a.choices.map((d) => (
          <button key={d} type="button" className={`btn${d === "once" ? " btn-p" : d === "deny" ? " btn-d" : ""}`}
            disabled={disabled || expired} title={`Taste: ${DECISION_KEY[d]}`} onClick={() => onDecide(d)}>
            {d === "always" && <Icon name="lock" size={12} />}{DECISION_LABEL[d]}
          </button>
        ))}
      </div>
      {a.smartDenied && <span className="hint">Die automatische Prüfung hat diesen Befehl zunächst abgelehnt.</span>}
      <span className="hint">
        Die Anfrage erlischt nach {Math.round(a.timeoutS / 60)} Minuten.
        {a.choices.includes("always") && " „Immer“ verlangt eine frische Anmeldung."}
      </span>
    </div>
  );
}

export function ClarifyCard({ c, onAnswer }: { c: Clarify; onAnswer: (a: string) => void }) {
  const [text, setText] = useState("");
  if (c.answer) {
    return (
      <div className="apprdone" role="group" aria-label="Rückfrage beantwortet">
        <Icon name="question" size={16} className="t2" />
        <div className="col grow" style={{ gap: 2, minWidth: 0 }}>
          <span style={{ fontWeight: 600, fontSize: 13 }}>Antwort: {c.answer}</span>
          <span className="mono t3 trunc" style={{ fontSize: 11 }}>{c.question}</span>
        </div>
      </div>
    );
  }
  return (
    <div className="appr" role="group" aria-label="Rückfrage des Agents">
      <div className="row" style={{ gap: 10 }}>
        <Icon name="question" size={16} className="crimt" />
        <span style={{ font: "600 14px var(--sans)" }}>Rückfrage</span>
      </div>
      <p className="clarify-q">{c.question}</p>
      {c.choices.length > 0 && (
        <div className="btns">{c.choices.map((x) => <button key={x} type="button" className="btn" onClick={() => onAnswer(x)}>{x}</button>)}</div>
      )}
      <form className="row" style={{ gap: 8 }} onSubmit={(e) => { e.preventDefault(); if (text.trim()) onAnswer(text.trim()); }}>
        <input className="field field-line" value={text} onChange={(e) => setText(e.target.value)} placeholder="Eigene Antwort" aria-label="Eigene Antwort" />
        <button type="submit" className="btn btn-p" disabled={!text.trim()}>Senden</button>
      </form>
    </div>
  );
}

type AgentProps = {
  items: Item[];
  name: string;
  sigil?: SigilConfig;
  model?: string;
  /** Aufwand-Beschriftung der letzten Anfrage (z. B. „Hoch“), damit nachvollziehbar bleibt, womit geantwortet wurde. */
  effort?: string;
  runLabel?: string;
  live: boolean;
  busy: boolean;
  selTool?: string;
  openTool?: string;
  onPickTool: (id: string) => void;
  onDecide: (id: string, d: Decision) => void;
  onAnswer: (id: string, answer: string, clarifyId?: string) => void;
};

export function AgentCard(p: AgentProps) {
  const first = p.items.find((i) => i.at !== undefined)?.at;
  return (
    <article className={`amsg${p.live ? " stream" : ""}`} aria-label={p.name} aria-busy={p.live}>
      <div className="ah">
        <Sigil name={p.name} config={p.sigil} size="xs" />
        <span style={{ fontWeight: 600, fontSize: 13 }}>{p.name}</span>
        {p.model && <span className="tag tag-m tag-act">{p.model}</span>}
        {p.effort && <span className="tag tag-m">Aufwand: {p.effort}</span>}
        <span className="mono t3" style={{ marginLeft: "auto", fontSize: 10.5 }}>{[first ? fmtTime(first) : "", p.runLabel].filter(Boolean).join(" · ")}</span>
      </div>
      {p.items.map((i, idx) => {
        switch (i.kind) {
          case "message":
            return (
              <div key={i.id} className="col" style={{ gap: 12 }}>
                {i.reasoning && <ReasoningCard text={i.reasoning} defaultOpen={i.streaming} />}
                {i.text
                  ? <div className="pt"><Markdown text={i.text} caret={i.streaming} /></div>
                  : i.streaming && !i.reasoning && <div className="pt"><span className="caret-only" aria-label={`${p.name} schreibt`} /></div>}
              </div>
            );
          case "tool":
            return <ToolRow key={i.id} t={i} selected={p.selTool === i.id} open={p.openTool === i.id} onPick={() => p.onPickTool(i.id)} />;
          case "subagent":
            return <SubagentCard key={i.id} s={i} />;
          case "approval":
            return <ApprovalCard key={i.id} a={i} disabled={!p.busy} onDecide={(d) => p.onDecide(i.id, d)} />;
          case "clarify":
            return <ClarifyCard key={i.id} c={i} onAnswer={(a) => p.onAnswer(i.id, a, i.clarifyId)} />;
          default:
            return <span key={idx} />;
        }
      })}
    </article>
  );
}

export const runLabelOf = (runId?: string) => (runId ? runId.replace(/^run[_-]?/, "run_").slice(0, 12) : undefined);
