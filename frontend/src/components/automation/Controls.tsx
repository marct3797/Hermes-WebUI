import { useEffect, useState } from "react";
import { api } from "../../api";
import { sessionList } from "../../chatReducer";
import { useAction } from "../useAction";
import { t } from "../../i18n";
import type { AgentRef, AutomationItem, SessionSummary } from "../../types";

type Kind = AutomationItem["kind"];
export type Change = { session_id: string; kind: Kind; action: "set" | "pause" | "resume" | "clear"; text?: string; max_turns?: number; interval_seconds?: number };

/** Pausieren, Fortsetzen, Löschen einer Karte. Löschen verlangt eine zweite Bestätigung direkt an der Karte. */
export function RowActions({ agent, item, onDone }: { agent: AgentRef; item: AutomationItem; onDone: () => void }) {
  const { run, notes, busy } = useAction();
  const [confirm, setConfirm] = useState(false);
  const send = (action: Change["action"]) => run(async () => {
    await api.changeAutomation(agent, { session_id: item.session_id, kind: item.kind, action });
    setConfirm(false);
    onDone();
  });
  return (
    <div>
      <div className="row">
        {item.status === "paused"
          ? <button type="button" className="btn" disabled={busy} onClick={() => void send("resume")}>{t("Fortsetzen")}</button>
          : item.status === "active" && <button type="button" className="btn" disabled={busy} onClick={() => void send("pause")}>{t("Pausieren")}</button>}
        {!confirm
          ? <button type="button" className="btn" disabled={busy} onClick={() => setConfirm(true)}>{t("Löschen")}</button>
          : (
            <>
              <span className="muted small">{t("Wirklich löschen? Das beendet es für diese Sitzung.")}</span>
              <button type="button" className="btn danger" disabled={busy} onClick={() => void send("clear")}>{t("Ja, löschen")}</button>
              <button type="button" className="btn" disabled={busy} onClick={() => setConfirm(false)}>{t("Abbrechen")}</button>
            </>
          )}
      </div>
      {notes}
    </div>
  );
}

/** Ziel oder Heartbeat für eine Sitzung setzen. Schleifen legt nur Hermes selbst an (/loop). */
export function SetForm({ agent, items, onDone }: { agent: AgentRef; items: AutomationItem[]; onDone: () => void }) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [kind, setKind] = useState<"goal" | "heartbeat">("goal");
  const [session, setSession] = useState("");
  const [text, setText] = useState("");
  const [turns, setTurns] = useState("");
  const [minutes, setMinutes] = useState("10");
  const { run, notes, busy } = useAction();
  useEffect(() => {
    let stop = false;
    api.sessions(agent).then((r) => { if (!stop) setSessions(sessionList(r)); }, () => { /* ohne Sitzungsliste bleibt das Formular leer */ });
    return () => { stop = true; };
  }, [agent.host, agent.runtime, agent.agent]);
  const chosen = session || sessions[0]?.id || "";
  const replaces = items.some((i) => i.kind === kind && i.session_id === chosen);
  const n = Number(turns);
  const m = Number(minutes);
  const bad = !chosen || !text.trim()
    || (kind === "goal" && turns !== "" && !(Number.isInteger(n) && n >= 1 && n <= 1000))
    || (kind === "heartbeat" && !(Number.isInteger(m) && m >= 1 && m <= 10080));
  const save = () => run(async () => {
    const change: Change = { session_id: chosen, kind, action: "set", text: text.trim() };
    if (kind === "goal" && turns !== "") change.max_turns = n;
    if (kind === "heartbeat") change.interval_seconds = m * 60;
    await api.changeAutomation(agent, change);
    setText(""); setTurns("");
    onDone();
  });
  return (
    <section aria-label={t("Neu setzen")}>
      <h2>{t("Neu setzen")}</h2>
      <label>{t("Art")}
        <select className="field" value={kind} onChange={(ev) => setKind(ev.target.value as "goal" | "heartbeat")} aria-label={t("Art")}>
          <option value="goal">{t("Ziel")}</option>
          <option value="heartbeat">{t("Heartbeat")}</option>
        </select>
      </label>
      <label>{t("Sitzung")}
        <select className="field" value={chosen} onChange={(ev) => setSession(ev.target.value)} aria-label={t("Sitzung")}>
          {sessions.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
        </select>
      </label>
      <label>{kind === "goal" ? t("Was soll erreicht werden?") : t("Was soll regelmäßig geprüft werden?")}
        <textarea className="field" rows={3} maxLength={2000} value={text} onChange={(ev) => setText(ev.target.value)} aria-label={kind === "goal" ? t("Ziel-Text") : t("Heartbeat-Text")} />
      </label>
      {kind === "goal"
        ? <label>{t("Höchstens so viele Runden (leer = Standard)")}<input className="field" inputMode="numeric" value={turns} onChange={(ev) => setTurns(ev.target.value)} aria-label={t("Höchstzahl Runden")} /></label>
        : <label>{t("Alle so viele Minuten")}<input className="field" inputMode="numeric" value={minutes} onChange={(ev) => setMinutes(ev.target.value)} aria-label={t("Intervall in Minuten")} /></label>}
      {replaces && <p className="muted small">{kind === "goal" ? t("Diese Sitzung hat schon ein Ziel. Es wird ersetzt.") : t("Diese Sitzung hat schon einen Heartbeat. Er wird ersetzt.")}</p>}
      {notes}
      <div className="row">
        <button type="button" className="btn primary" disabled={busy || bad} onClick={() => void save()}>{t("Setzen")}</button>
      </div>
    </section>
  );
}
