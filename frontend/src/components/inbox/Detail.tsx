import { useState } from "react";
import { itemIdOf, secondsLeft, type Need } from "../../attention";
import { fmtAgo, fmtClock, fmtDuration, toolIcon } from "../../format";
import { agentPath } from "../../router";
import { useRunStore } from "../../runs";
import type { Decision, Item, SigilConfig } from "../../types";
import { sigilFor } from "../../ui";
import { Icon } from "../Icon";
import { Link } from "../Link";
import { Sigil } from "../Sigil";
import { t as tr } from "../../i18n";

type Props = { need: Need; sigils: Record<string, SigilConfig>; now: number };

const DECIDE: Array<{ d: Decision; label: string; key: string }> = [
  { d: "once", get label() { return tr("Einmal erlauben"); }, key: "⏎" },
  { d: "session", get label() { return tr("Für Session"); }, key: "S" },
  { d: "always", get label() { return tr("Immer erlauben"); }, key: "⇧A" },
  { d: "deny", get label() { return tr("Ablehnen"); }, key: "Esc" },
];

const where = (n: Need) => `${n.agent.host}/${n.agent.runtime}${n.runId ? ` · ${n.runId.slice(0, 12)}` : ""}`;

function Steps({ steps }: { steps: Item[] }) {
  const tools = steps.filter((s): s is Extract<Item, { kind: "tool" }> => s.kind === "tool");
  if (!tools.length) return null;
  return (
    <div className="col" style={{ gap: 8 }}>
      <span className="lbl">{tr("Letzte Schritte")}</span>
      <div className="tl">
        {tools.map((t) => (
          <div className="st" key={t.id}>
            <Icon name={t.status === "error" ? "x" : t.status === "running" ? "clock" : toolIcon(t.name)} size={14} className={t.status === "running" ? "crimt" : "t3"} />
            <span className="trunc">{t.name}{t.preview ? ` ${t.preview.split("\n")[0]}` : ""}</span>
            <span className="m">{t.durationMs != null ? fmtDuration(t.durationMs) : t.status === "running" ? "läuft" : ""}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Approval({ need, sigils, now }: Props & { need: Extract<Need, { kind: "approval" }> }) {
  const store = useRunStore();
  const a = need.item;
  const secs = secondsLeft(need, now)!;
  const expired = secs <= 0;
  const pct = Math.max(0, Math.min(100, (secs / a.timeoutS) * 100));
  const rows: Array<[string, string]> = [
    ...(a.reason ? [["Begründung", a.reason] as [string, string]] : []),
    ...(need.topic ? [[tr("Anlass"), need.topic] as [string, string]] : []),
    [tr("Agent"), `${need.agent.host}/${need.agent.runtime}/${need.agent.agent}`],
  ];
  return (
    <>
      <div className="dhead">
        <Sigil name={need.agent.agent} config={sigilFor(sigils, need.agent)} size="l" state="wait" />
        <div className="col" style={{ gap: 4 }}>
          <div className="row" style={{ gap: 8 }}><span className="tag tag-s">{a.smartDenied ? "SMART-DENY" : tr("FREIGABE")}</span><span style={{ fontWeight: 600, fontSize: 14 }}>{need.agent.agent}</span></div>
          <span className="mono t3" style={{ fontSize: 11 }}>{where(need)} · {fmtAgo(a.at, now)}</span>
        </div>
        <div className="ttl">
          <span className="v">{expired ? tr("abgelaufen") : `erlischt in ${fmtClock(secs)}`}</span>
          <div className="prog"><b style={{ width: `${pct}%` }} /></div>
        </div>
      </div>
      <h2>{tr("{agent} möchte einen Befehl ausführen", { agent: need.agent.agent })}</h2>
      {a.smartDenied && (
        <div className="banner" role="note">
          <Icon name="alert" size={18} />
          <div className="col" style={{ gap: 3 }}>
            <span style={{ fontWeight: 600 }}>{tr("Hermes rät ab (Smart-Deny)")}</span>
            <span className="t2" style={{ fontSize: 12.5, lineHeight: "18px" }}>{tr("Die automatische Prüfung hat diesen Befehl zunächst abgelehnt. Erlaubt sind nur die Wege, die Hermes anbietet.")}</span>
          </div>
        </div>
      )}
      <div className="codeb">
        <div className="hd"><Icon name="terminal" size={12} />{tr("Befehl")}</div>
        <div className="pre"><div className="cl"><span className="ln">$</span>{a.command}</div></div>
      </div>
      <div className="kv">
        {rows.map(([k, v]) => <><div className="k" key={`k${k}`}>{k}</div><div className="v" key={`v${k}`} style={k === "Begründung" ? { fontFamily: "var(--sans)", fontSize: 13, lineHeight: "20px", wordBreak: "normal" } : undefined}>{v}</div></>)}
      </div>
      <Steps steps={need.steps} />
      <div className="decide" role="group" aria-label={tr("Deine Entscheidung")}>
        <div className="row" style={{ gap: 10 }}>
          <Icon name="shield" size={16} className="crimt" /><span style={{ fontWeight: 600 }}>{tr("Deine Entscheidung")}</span>
          <span className="hint" style={{ marginLeft: "auto" }}>{tr("geht ins Audit-Log")}</span>
        </div>
        <div className="btns ways">
          {DECIDE.filter((x) => a.choices.includes(x.d)).map((x) => (
            <button key={x.d} type="button" disabled={expired} onClick={() => void store.decide(need.convKey, itemIdOf(need), x.d)}
              className={`btn btn-l${x.d === "once" ? " btn-p" : x.d === "deny" ? " btn-d" : ""}`} style={x.d === "deny" ? { marginLeft: "auto" } : undefined}>
              {x.d === "always" && <Icon name="lock" size={14} />}{x.label}<span className="kbd">{x.key}</span>
            </button>
          ))}
        </div>
        <span className="hint">
          {tr("Die Anfrage erlischt nach {v} Minuten.{includes}", { v: Math.round(a.timeoutS / 60), includes: a.choices.includes("always") && " „Immer erlauben“ verlangt eine frische Anmeldung." })}</span>
      </div>
    </>
  );
}

function Question({ need, sigils, now }: Props & { need: Extract<Need, { kind: "clarify" }> }) {
  const store = useRunStore();
  const c = need.item;
  const [picked, setPicked] = useState<string>();
  const [own, setOwn] = useState("");
  const answer = own.trim() || picked;
  const send = () => { if (answer) void store.answer(need.convKey, itemIdOf(need), answer, c.clarifyId); };
  return (
    <>
      <div className="dhead">
        <Sigil name={need.agent.agent} config={sigilFor(sigils, need.agent)} size="l" state="wait" />
        <div className="col" style={{ gap: 4 }}>
          <div className="row" style={{ gap: 8 }}><span className="tag">{tr("RÜCKFRAGE")}</span><span style={{ fontWeight: 600, fontSize: 14 }}>{need.agent.agent}</span></div>
          <span className="mono t3" style={{ fontSize: 11 }}>{where(need)} · {fmtAgo(need.since, now)}</span>
        </div>
      </div>
      <h2>{tr("{agent} braucht eine Entscheidung", { agent: need.agent.agent })}</h2>
      <div className="stream-q">
        <div className="row" style={{ gap: 10, marginBottom: 8 }}><Icon name="chat" size={14} className="t3" /><span className="lbl">{tr("Frage von {agent}", { agent: need.agent.agent })}</span></div>
        <div className="q">{c.question}</div>
      </div>
      {c.choices.length > 0 && (
        <div className="col" style={{ gap: 8 }} role="radiogroup" aria-label={tr("Vorschläge")}>
          {c.choices.map((x) => (
            <button key={x} type="button" role="radio" aria-checked={picked === x} className={`opt${picked === x ? " on" : ""}`} onClick={() => setPicked(picked === x ? undefined : x)}>
              <i className="radio" /><span className="grow">{x}</span>
            </button>
          ))}
        </div>
      )}
      <div className="col" style={{ gap: 8 }}>
        <span className="lbl">{c.choices.length ? tr("Oder eigene Antwort") : tr("Deine Antwort")}</span>
        <textarea className="field" value={own} aria-label={tr("Eigene Antwort")} placeholder={`Antwort an ${need.agent.agent} …`} onChange={(e) => setOwn(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); } }} />
      </div>
      <div className="row" style={{ gap: 8 }}>
        <button type="button" className="btn btn-l btn-p" disabled={!answer} onClick={send}>{tr("Antwort senden")}<span className="kbd">{tr("Strg ⏎")}</span></button>
      </div>
      <Steps steps={need.steps} />
    </>
  );
}

function Failure({ need, sigils, now }: Props & { need: Extract<Need, { kind: "failed" | "lost" }> }) {
  const store = useRunStore();
  const lost = need.kind === "lost";
  return (
    <>
      <div className="dhead">
        <Sigil name={need.agent.agent} config={sigilFor(sigils, need.agent)} size="l" state="err" />
        <div className="col" style={{ gap: 4 }}>
          <div className="row" style={{ gap: 8 }}><span className="tag tag-e">{lost ? tr("GETRENNT") : tr("FEHLER")}</span><span style={{ fontWeight: 600, fontSize: 14 }}>{need.agent.agent}</span></div>
          <span className="mono t3" style={{ fontSize: 11 }}>{where(need)} · {fmtAgo(need.since, now)}</span>
        </div>
      </div>
      <h2>{lost ? tr("Verbindung zu Hermes unterbrochen") : tr("Der Run ist fehlgeschlagen")}</h2>
      <p className="banner" role="alert"><Icon name="alert" size={18} /><span>{need.error}</span></p>
      {need.topic && <div className="kv"><div className="k">{tr("Anlass")}</div><div className="v">{need.topic}</div></div>}
      <Steps steps={need.steps} />
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <Link to={agentPath(need.agent, "chat", need.sessionId)} className="btn btn-l btn-p">{tr("Chat öffnen")}<Icon name="arrow" size={14} /></Link>
        {lost && <button type="button" className="btn btn-l" onClick={() => store.reconnect(need.convKey)}>{tr("Erneut verbinden")}</button>}
        <button type="button" className="btn btn-l btn-g" onClick={() => store.dismiss(need.id)}>{tr("Als gelesen markieren")}</button>
      </div>
    </>
  );
}

export function Detail(p: Props) {
  const n = p.need;
  return (
    <section className="detail" aria-label={tr("Details")} aria-live="polite">
      {n.kind === "approval" ? <Approval {...p} need={n} />
        : n.kind === "clarify" ? <Question key={n.id} {...p} need={n} />
        : <Failure {...p} need={n} />}
    </section>
  );
}
