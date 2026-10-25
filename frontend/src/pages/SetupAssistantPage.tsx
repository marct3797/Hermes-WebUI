import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { sessionList } from "../chatReducer";
import { Link } from "../components/Link";
import { PageHead } from "../components/PageHead";
import { invalidate } from "../dataCache";
import { agentPath } from "../router";
import type { AgentRef } from "../types";
import { t } from "../i18n";

type StepState = "checking" | "done" | "open" | "waiting" | "error";
type Pick = { ref: AgentRef; label: string };
type Step = {
  n: number; title: string; why: string; state: StepState; reason: string | null;
  facts: string[]; remedy: string | null;
  to: string | null; action: string | null; chatTo: string | null; agentPick: Pick[];
};

// Die WebUI legt Hosts nicht selbst an: das Terminal-Skript schreibt hosts.json und webui.env.
const SETUP_HINT = "deploy/setup.py";
const ADD_HOST_HINT = "deploy/add-host.sh";

async function hostLive(ref: AgentRef, hostLabel: string): Promise<{ state: StepState; reason: string | null; facts: string[] }> {
  try {
    const s = await api.status(ref);
    const facts = [`${t("Host")}: ${hostLabel}`, `${t("Agent")}: ${ref.host}/${ref.runtime}/${ref.agent}`];
    if ((s.version ?? "").length > 0) facts.push(`${t("Version")}: ${s.version}`);
    if (s.online && s.state === "online") return { state: "done", reason: null, facts };
    if (s.state === "auth_error" || (s.error ?? "").length > 0) return { state: "error", reason: s.error ?? t("Zugang abgelehnt"), facts };
    return { state: "open", reason: s.error ?? t("nicht erreichbar"), facts };
  } catch (e) { return { state: "error", reason: (e as Error).message, facts: [] }; }
}

async function connLive(ref: AgentRef): Promise<{ state: StepState; reason: string | null; facts: string[] }> {
  try {
    const d = await api.diagnose(ref);
    const bad = d.checks.filter((c) => c.status !== "ok");
    const facts = bad.map((c) => `${c.label}: ${c.detail}`);
    if (d.checks.filter((c) => c.status === "fail").length > 0) return { state: "error", reason: facts.join("; "), facts };
    if (d.status === "warn") {
      return { state: "open", reason: facts.length ? facts.join("; ") : t("nicht bereit"), facts };
    }
    return { state: "done", reason: null, facts: d.checks.map((c) => `${c.label}: ${c.detail}`) };
  } catch (e) { return { state: "error", reason: (e as Error).message, facts: [] }; }
}

async function provLive(ref: AgentRef): Promise<{ state: StepState; reason: string | null; facts: string[] }> {
  try {
    const p = await api.providers(ref, 30);
    const names = p.providers.filter((g) => g.configured).map((g) => g.label);
    const facts = [`${names.length} ${t("von")} ${p.providers.length} ${t("eingerichtet")}`, ...names];
    return names.length > 0 ? { state: "done", reason: null, facts } : { state: "open", reason: null, facts: [] };
  } catch (e) { return { state: "error", reason: (e as Error).message, facts: [] }; }
}

async function modelLive(ref: AgentRef): Promise<{ state: StepState; reason: string | null; facts: string[] }> {
  try {
    const m = await api.mdInfo(ref);
    const facts = m.configured && m.provider && m.model ? [`${t("Anbieter")}: ${m.provider}`, `${t("Modell")}: ${m.model}`] : [];
    return m.configured ? { state: "done", reason: null, facts } : { state: "open", reason: null, facts };
  } catch (e) { return { state: "error", reason: (e as Error).message, facts: [] }; }
}

async function sessLive(ref: AgentRef): Promise<{ state: StepState; reason: string | null; chatTo: string; facts: string[] }> {
  try {
    const s = await api.sessions(ref);
    const count = sessionList(s).length;
    const facts = count > 0 ? [t("{n} Sitzungen", { n: count })] : [];
    return { state: count > 0 ? "done" : "open", reason: null, chatTo: agentPath(ref), facts };
  } catch (e) { return { state: "error", reason: (e as Error).message, chatTo: agentPath(ref), facts: [] }; }
}

const labelOf = (s: StepState) => s === "done" ? t("Erledigt") : s === "open" ? t("Offen") : s === "waiting" ? t("Wartet") : s === "error" ? t("Fehler") : t("Wird geprüft");
const glyphOf = (s: StepState) => s === "done" ? "✓" : s === "open" ? "○" : s === "waiting" ? "◌" : s === "error" ? "!" : "…";

/** Echter Einrichtungsassistent: fünf Schritte, jeder Zustand kommt aus den Daten. Schreibt nichts, verlinkt nur. */
export function SetupAssistantPage() {
  const [hostIdx, setHostIdx] = useState(0);
  const [pick, setPick] = useState("");
  const [reload, setReload] = useState(0);
  const [steps, setSteps] = useState<Step[] | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [hostsMeta, setHostsMeta] = useState<{ id: string; label: string }[]>([]);
  const [agents, setAgents] = useState<Pick[]>([]);

  const recheck = useCallback(() => { invalidate("hosts"); setReload((n) => n + 1); }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const hr = await api.hosts();
        const hosts = (hr.hosts ?? []).map((h) => ({
          id: h.id, label: h.label,
          agents: (h.runtimes ?? []).flatMap((rt) => (rt.agents ?? []).map((a) => ({ ref: { host: h.id, runtime: rt.id, agent: a.id }, label: `${h.label} / ${rt.label} / ${a.label}` }))),
        }));
        if (!alive) return;
        setHostsMeta(hosts.map((h) => ({ id: h.id, label: h.label })));
        const cfgErr = hr.config_error;
        if (hosts.length === 0) {
          setAgents([]);
          setSteps([{ n: 1, title: t("Host eintragen"), why: t("Die WebUI braucht mindestens einen Host mit Dashboard. Hosts legt das Terminal-Skript an, nicht der Browser."), state: "open", reason: cfgErr ?? t("Noch kein Host eingetragen. Lege ihn mit {setup} an, weitere Rechner mit {add}.", { setup: SETUP_HINT, add: ADD_HOST_HINT }), facts: [], remedy: t("Abhilfe: Setup-Skript im Terminal laufen lassen."), to: "/hosts", action: t("Zu den Hosts"), chatTo: null, agentPick: [] }]);
          setPageError(null);
          return;
        }
        const idx = Math.min(hostIdx, hosts.length - 1);
        const list = hosts[idx].agents;
        setAgents(list);
        const label = hosts[idx].label;
        const ref = list.find((a) => a.ref.agent === pick)?.ref ?? list[0]?.ref;
        if (!ref) {
          setSteps([{ n: 1, title: t("Host eintragen"), why: t("Dieser Host meldet keinen Agent. Wähle oben einen anderen Host."), state: "open", reason: cfgErr, facts: [], remedy: null, to: "/hosts", action: t("Zu den Hosts"), chatTo: null, agentPick: [] }]);
          return;
        }
        const [live, conn, prov, model, sess] = await Promise.all([hostLive(ref, label), connLive(ref), provLive(ref), modelLive(ref), sessLive(ref)]);
        if (!alive) return;
        const modelStep = prov.state === "done" ? model : { ...model, state: "waiting" as StepState, reason: t("Erst Schritt 3 abschließen: Anbieter einrichten."), facts: [] };
        setSteps([
          { n: 1, title: t("Host eintragen"), why: t("Die WebUI braucht mindestens einen Host mit Dashboard. Hosts legt das Terminal-Skript an, nicht der Browser."), state: live.state, reason: live.state === "done" ? null : (live.reason ?? cfgErr), facts: live.facts, remedy: live.state === "error" ? t("Abhilfe: Host-Dienst prüfen und Setup-Skript erneut laufen lassen.") : null, to: "/hosts", action: t("Zu den Hosts"), chatTo: null, agentPick: [] },
          { n: 2, title: t("Verbindung prüfen"), why: t("Der Agent muss online sein und das Dashboard erreichen, sonst antwortet niemand."), state: conn.state, reason: conn.reason, facts: conn.facts, remedy: conn.state === "error" ? t("Abhilfe: Agent-Dienst neu starten und Diagnose erneut öffnen.") : null, to: "/system", action: t("Zur Diagnose"), chatTo: null, agentPick: [] },
          { n: 3, title: t("Anbieter und Schlüssel"), why: t("Modelle antworten nur über einen eingerichteten Anbieter. Eine frische Installation ohne Anbieter ist normal, kein Fehler."), state: prov.state, reason: prov.reason, facts: prov.facts, remedy: prov.state === "open" ? t("Abhilfe: Anbieter-Schlüssel hinterlegen.") : null, to: agentPath(ref, "providers"), action: t("Zu den Anbietern"), chatTo: null, agentPick: [] },
          { n: 4, title: t("Hauptmodell wählen"), why: t("Das Hauptmodell beantwortet deine Nachrichten. Ohne Anbieter aus Schritt 3 wartet dieser Schritt."), state: modelStep.state, reason: modelStep.reason, facts: modelStep.facts, remedy: modelStep.state === "open" ? t("Abhilfe: Hauptmodell auf der Modellseite wählen.") : null, to: agentPath(ref, "modelle"), action: t("Zu den Modellen"), chatTo: null, agentPick: [] },
          { n: 5, title: t("Erster Chat"), why: t("Eine Sitzung zeigt, dass alles verbunden ist. Wähle einen Agent und schreibe los."), state: sess.state, reason: sess.reason, facts: sess.facts, remedy: sess.state === "open" ? t("Abhilfe: Chat öffnen und erste Nachricht senden.") : null, to: null, action: null, chatTo: sess.chatTo, agentPick: list },
        ]);
        setPageError(null);
      } catch (e) { if (alive) setPageError((e as Error).message); }
    })().catch((e) => { if (alive) setPageError((e as Error).message); });
    return () => { alive = false; };
  }, [hostIdx, pick, reload]);

  const doneCount = steps?.filter((s) => s.state === "done").length ?? 0;
  const allDone = steps !== null && steps.length === 5 && steps.every((s) => s.state === "done");

  return (
    <main className="page">
      <PageHead title={t("Einrichtungsassistent")} sub={steps ? t("{n} von 5 erledigt", { n: doneCount }) : t("Prüft den echten Stand …")} />
      {steps && <div role="progressbar" aria-valuenow={doneCount} aria-valuemin={0} aria-valuemax={5} aria-label={t("{n} von 5 erledigt", { n: doneCount })} />}
      {pageError && <p className="banner" role="alert">{pageError}</p>}
      {hostsMeta.length > 1 && (
        <label className="row" style={{ gap: 8 }}>{t("Host")}
          <select value={hostsMeta[Math.min(hostIdx, hostsMeta.length - 1)]?.id ?? ""} aria-label={t("Host wählen")} onChange={(e) => { setHostIdx(hostsMeta.findIndex((h) => h.id === e.target.value)); setPick(""); }}>
            {hostsMeta.map((h) => <option key={h.id} value={h.id}>{h.label}</option>)}
          </select>
        </label>
      )}
      {!steps && !pageError && <p role="status">{t("Wird geprüft")}</p>}
      <div className="col" style={{ gap: 12 }}>
        {steps?.map((s) => (
          <section className="card" key={s.n} aria-label={t("Schritt {n}", { n: s.n })}>
            <h2>{s.n}. {s.title} <span className="tag"><span aria-hidden="true">{glyphOf(s.state)}</span> {labelOf(s.state)}</span></h2>
            <p>{s.why}</p>
            {s.facts.length > 0 && (
              <details>
                <summary>{t("Details")}</summary>
                <ul>{s.facts.map((f, i) => <li key={i}>{f}</li>)}</ul>
              </details>
            )}
            {s.reason && <p className="muted">{s.reason}</p>}
            {s.remedy && s.to && <p><strong>{s.remedy}</strong> <Link to={s.to}>{s.action ?? s.to}</Link></p>}
            {s.agentPick.length > 1 && s.chatTo && (
              <label className="row" style={{ gap: 8 }}>{t("Agent")}
                <select aria-label={t("Agent wählen")} value={s.agentPick.find((a) => a.ref.agent === pick)?.ref.agent ?? s.agentPick[0].ref.agent} onChange={(e) => setPick(e.target.value)}>
                  {s.agentPick.map((a) => <option key={`${a.ref.runtime}/${a.ref.agent}`} value={a.ref.agent}>{a.label}</option>)}
                </select>
              </label>
            )}
            <div className="row" style={{ gap: 8 }}>
              {s.to && s.action && <Link to={s.to} className="btn btn-s btn-p">{s.action}</Link>}
              {s.chatTo && <Link to={s.chatTo} className="btn btn-s btn-p">{t("Chat starten")}</Link>}
              <button type="button" className="btn btn-s" onClick={recheck}>{t("Erneut prüfen")}</button>
            </div>
          </section>
        ))}
      </div>
      {allDone && (
        <section className="card" aria-label={t("Fertig")}>
          <h2>{t("Alles bereit")}</h2>
          <p>{t("Alle 5 Schritte sind erledigt. Weiter geht es im Cockpit, in den Einstellungen oder in den Anleitungen.")}</p>
          <div className="row" style={{ gap: 8 }}>
            <Link to="/" className="btn btn-s btn-p">{t("Zum Cockpit")}</Link>
            <Link to="/settings" className="btn btn-s">{t("Zu den Einstellungen")}</Link>
            <Link to="/guide" className="btn btn-s">{t("Zu den Anleitungen")}</Link>
          </div>
        </section>
      )}
      {agents.length > 0 && <p className="muted">{t("{n} Agents erreichbar", { n: agents.length })}</p>}
    </main>
  );
}
