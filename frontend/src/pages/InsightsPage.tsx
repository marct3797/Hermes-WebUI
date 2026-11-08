import { useCallback, useEffect, useState } from "react";
import { p3, type Appearance, type ComputerUse, type Curator, type CuratorLog, type Privacy, type SystemStats } from "../p3Api";
import { PageHead } from "../components/PageHead";
import { useAction } from "../components/useAction";
import type { AgentRef } from "../types";
import { t as tr } from "../i18n";

const gb = (n?: number) => (typeof n === "number" ? `${(n / 1024 ** 3).toFixed(1)} GB` : "?");
const err = (e: unknown) => (e as Error).message;

export default function InsightsPage({ agent }: { agent: AgentRef }) {
  return (
    <article>
      <PageHead title={tr("System und Datenschutz")} sub={tr("Kennzahlen, Curator, Darstellung des Hermes-Dashboards und Datenschutz")} />
      <SystemBox agent={agent} />
      <ComputerUseBox agent={agent} />
      <CuratorBox agent={agent} />
      <AppearanceBox agent={agent} />
      <PrivacyBox agent={agent} />
    </article>
  );
}

function SystemBox({ agent }: { agent: AgentRef }) {
  const [s, setS] = useState<SystemStats | null>(null);
  const [e, setE] = useState("");
  useEffect(() => { p3.system(agent).then(setS).catch((x) => setE(err(x))); }, [agent]);
  return (
    <section aria-label={tr("System")}>
      <h2>{tr("System")}</h2>
      {e && <p className="banner" role="alert">{e}</p>}
      {s && <ul>
        <li>{tr("Hermes {hermes_version} auf {system} ({arch}), Python {python_version}", { hermes_version: s.hermes_version ?? "?", system: s.system ?? "?", arch: s.arch ?? "?", python_version: s.python_version ?? "?" })}</li>
        <li>{tr("{cpu_count} Kerne, Auslastung {cpu_percent} %", { cpu_count: s.cpu_count ?? "?", cpu_percent: s.cpu_percent ?? "?" })}</li>
        <li>{tr("Arbeitsspeicher {used} von {total}, Datenträger {used2} von {total2}", { used: gb(s.memory?.used), total: gb(s.memory?.total), used2: gb(s.disk?.used), total2: gb(s.disk?.total) })}</li>
      </ul>}
    </section>
  );
}

function ComputerUseBox({ agent }: { agent: AgentRef }) {
  const [c, setC] = useState<ComputerUse | null>(null);
  const [e, setE] = useState("");
  useEffect(() => { p3.computerUse(agent).then(setC).catch((x) => setE(err(x))); }, [agent]);
  const state = !c ? "" : !c.platform_supported ? tr("Diese Plattform wird nicht unterstützt.") : !c.installed ? tr("Nicht installiert.") : c.ready === true ? "Bereit." : c.ready === false ? tr("Nicht bereit.") : "Bereitschaft unbekannt.";
  return (
    <section aria-label={tr("Computer Use")}>
      <h2>{tr("Computer Use")}</h2>
      <p className="muted">{tr("Nur Status. Berechtigungen vergibst du am Rechner selbst (auf macOS in den Systemeinstellungen).")}</p>
      {e && <p className="banner" role="alert">{e}</p>}
      {c && <>
        <p>{state}{c.version ? ` ${c.version}` : ""}</p>
        {c.error && <p className="banner">{c.error}</p>}
        {c.checks.length > 0 && <ul aria-label={tr("Prüfungen")}>{c.checks.map((k) => <li key={k.name}>{k.name}: {k.ok === true ? tr("in Ordnung") : k.ok === false ? "fehlgeschlagen" : tr("unbekannt")}</li>)}</ul>}
      </>}
    </section>
  );
}

function CuratorBox({ agent }: { agent: AgentRef }) {
  const [c, setC] = useState<Curator | null>(null);
  const [log, setLog] = useState<CuratorLog | null>(null);
  const [e, setE] = useState("");
  const [sure, setSure] = useState(false);
  const { run, notes, busy } = useAction();
  const load = useCallback(async () => setC(await p3.curator(agent)), [agent]);
  useEffect(() => { load().catch((x) => setE(err(x))); }, [load]);
  return (
    <section aria-label={tr("Curator")}>
      <h2>{tr("Curator")}</h2>
      {notes}
      {e && <p className="banner" role="alert">{e}</p>}
      {c && <>
        <p>{tr("{enabled}, {paused}; Intervall {interval_hours} Std, Skills gelten nach {stale_after_days} Tagen als veraltet und werden nach {archive_after_days} Tagen archiviert.", { enabled: c.enabled ? tr("aktiv") : "ausgeschaltet", paused: c.paused ? "pausiert" : "läuft", interval_hours: c.interval_hours ?? "?", stale_after_days: c.stale_after_days ?? "?", archive_after_days: c.archive_after_days ?? "?" })}</p>
        <button type="button" disabled={busy} onClick={() => void run(async () => { await p3.curatorPause(agent, !c.paused); await load(); })}>{c.paused ? tr("Fortsetzen") : tr("Pausieren")}</button>
        <label><input type="checkbox" aria-label={tr("Curator-Lauf bestätigen")} checked={sure} onChange={(ev) => setSure(ev.target.checked)} /> {tr("Ich weiß: der Lauf archiviert und überarbeitet Skills und verbraucht Tokens.")}</label>
        <button type="button" disabled={busy || !sure} onClick={() => void run(async () => { await p3.curatorRun(agent); setSure(false); setLog(await p3.curatorLog(agent)); })}>{tr("Curator jetzt starten")}</button>
        <button type="button" disabled={busy} onClick={() => void run(async () => setLog(await p3.curatorLog(agent)))}>{tr("Protokoll laden")}</button>
        {log && <pre aria-label={tr("Curator-Protokoll")}>{log.running ? tr("(läuft noch)\n") : ""}{log.log}</pre>}
      </>}
    </section>
  );
}

function AppearanceBox({ agent }: { agent: AgentRef }) {
  const [a, setA] = useState<Appearance | null>(null);
  const [e, setE] = useState("");
  const { run, notes, busy } = useAction();
  const load = useCallback(async () => setA(await p3.appearance(agent)), [agent]);
  useEffect(() => { load().catch((x) => setE(err(x))); }, [load]);
  return (
    <section aria-label={tr("Darstellung im Hermes-Dashboard")}>
      <h2>{tr("Darstellung im Hermes-Dashboard")}</h2>
      <p className="muted">{tr("Gilt nur für das Dashboard von Hermes, nicht für diese WebUI.")}</p>
      {notes}
      {e && <p className="banner" role="alert">{e}</p>}
      {a && <>
        <label>{tr("Theme")} <select aria-label={tr("Theme")} value={a.active} disabled={busy} onChange={(ev) => void run(async () => { await p3.theme(agent, ev.target.value); await load(); })}>
          {a.themes.map((t) => <option key={t.name} value={t.name}>{t.label || t.name}</option>)}</select></label>
        <label>{tr("Schrift")} <select aria-label={tr("Schrift")} value={a.font} disabled={busy} onChange={(ev) => void run(async () => { await p3.font(agent, ev.target.value); await load(); })}>
          {a.fonts.map((f) => <option key={f} value={f}>{f}</option>)}</select></label>
      </>}
    </section>
  );
}

function PrivacyBox({ agent }: { agent: AgentRef }) {
  const [p, setP] = useState<Privacy | null>(null);
  const [e, setE] = useState("");
  const [sure, setSure] = useState(false);
  const { run, notes, busy } = useAction();
  const load = useCallback(async () => setP(await p3.privacy(agent)), [agent]);
  useEffect(() => { load().catch((x) => setE(err(x))); }, [load]);
  const m = p?.metrics;
  return (
    <section aria-label={tr("Datenschutz")}>
      <h2>{tr("Datenschutz")}</h2>
      {notes}
      {e && <p className="banner" role="alert">{e}</p>}
      {p && m && <>
        <pre aria-label={tr("Egress-Status")} style={{ whiteSpace: "pre-wrap" }}>{p.egress}</pre>
        {m.managed
          ? <p>{tr("Diese Installation wird verwaltet: die Einwilligung für Nutzungsmetriken lässt sich hier nicht ändern.")}</p>
          : <>
              <p>{tr("Nutzungsmetriken: {enabled}, {send}{decided}.", { enabled: m.enabled ? tr("werden gesammelt") : "aus", send: m.send ? tr("werden gesendet") : tr("werden nicht gesendet"), decided: m.decided ? "" : tr(" (noch nicht entschieden)") })}</p>
              <button type="button" disabled={busy} onClick={() => void run(async () => { await p3.metrics(agent, { enabled: !m.enabled, send: false }); await load(); })}>{m.enabled ? tr("Sammeln ausschalten") : tr("Nur lokal sammeln")}</button>
              {m.enabled && !m.send && <>
                <label><input type="checkbox" aria-label={tr("Senden bestätigen")} checked={sure} onChange={(ev) => setSure(ev.target.checked)} /> {tr("Ich weiß: Nutzungsdaten verlassen dann diesen Rechner.")}</label>
                <button type="button" disabled={busy || !sure} onClick={() => void run(async () => { await p3.metrics(agent, { enabled: true, send: true, confirm_send: true }); setSure(false); await load(); })}>{tr("Senden einschalten")}</button>
              </>}
              {m.send && <button type="button" disabled={busy} onClick={() => void run(async () => { await p3.metrics(agent, { enabled: true, send: false }); await load(); })}>{tr("Senden ausschalten")}</button>}
            </>}
      </>}
    </section>
  );
}
