import { useCallback, useEffect, useState } from "react";
import { p3, type Appearance, type ComputerUse, type Curator, type CuratorLog, type Privacy, type SystemStats } from "../p3Api";
import { PageHead } from "../components/PageHead";
import { useAction } from "../components/useAction";
import type { AgentRef } from "../types";

const gb = (n?: number) => (typeof n === "number" ? `${(n / 1024 ** 3).toFixed(1)} GB` : "?");
const err = (e: unknown) => (e as Error).message;

export default function InsightsPage({ agent }: { agent: AgentRef }) {
  return (
    <article>
      <PageHead title="System und Datenschutz" sub="Kennzahlen, Curator, Darstellung des Hermes-Dashboards und Datenschutz" />
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
    <section aria-label="System">
      <h2>System</h2>
      {e && <p className="banner" role="alert">{e}</p>}
      {s && <ul>
        <li>Hermes {s.hermes_version ?? "?"} auf {s.system ?? "?"} ({s.arch ?? "?"}), Python {s.python_version ?? "?"}</li>
        <li>{s.cpu_count ?? "?"} Kerne, Auslastung {s.cpu_percent ?? "?"} %</li>
        <li>Arbeitsspeicher {gb(s.memory?.used)} von {gb(s.memory?.total)}, Datenträger {gb(s.disk?.used)} von {gb(s.disk?.total)}</li>
      </ul>}
    </section>
  );
}

function ComputerUseBox({ agent }: { agent: AgentRef }) {
  const [c, setC] = useState<ComputerUse | null>(null);
  const [e, setE] = useState("");
  useEffect(() => { p3.computerUse(agent).then(setC).catch((x) => setE(err(x))); }, [agent]);
  const state = !c ? "" : !c.platform_supported ? "Diese Plattform wird nicht unterstützt." : !c.installed ? "Nicht installiert." : c.ready === true ? "Bereit." : c.ready === false ? "Nicht bereit." : "Bereitschaft unbekannt.";
  return (
    <section aria-label="Computer Use">
      <h2>Computer Use</h2>
      <p className="muted">Nur Status. Berechtigungen vergibst du am Rechner selbst (auf macOS in den Systemeinstellungen).</p>
      {e && <p className="banner" role="alert">{e}</p>}
      {c && <>
        <p>{state}{c.version ? ` ${c.version}` : ""}</p>
        {c.error && <p className="banner">{c.error}</p>}
        {c.checks.length > 0 && <ul aria-label="Prüfungen">{c.checks.map((k) => <li key={k.name}>{k.name}: {k.ok === true ? "in Ordnung" : k.ok === false ? "fehlgeschlagen" : "unbekannt"}</li>)}</ul>}
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
    <section aria-label="Curator">
      <h2>Curator</h2>
      {notes}
      {e && <p className="banner" role="alert">{e}</p>}
      {c && <>
        <p>{c.enabled ? "aktiv" : "ausgeschaltet"}, {c.paused ? "pausiert" : "läuft"}; Intervall {c.interval_hours ?? "?"} Std, Skills gelten nach {c.stale_after_days ?? "?"} Tagen als veraltet und werden nach {c.archive_after_days ?? "?"} Tagen archiviert.</p>
        <button type="button" disabled={busy} onClick={() => void run(async () => { await p3.curatorPause(agent, !c.paused); await load(); })}>{c.paused ? "Fortsetzen" : "Pausieren"}</button>
        <label><input type="checkbox" aria-label="Curator-Lauf bestätigen" checked={sure} onChange={(ev) => setSure(ev.target.checked)} /> Ich weiß: der Lauf archiviert und überarbeitet Skills und verbraucht Tokens.</label>
        <button type="button" disabled={busy || !sure} onClick={() => void run(async () => { await p3.curatorRun(agent); setSure(false); setLog(await p3.curatorLog(agent)); })}>Curator jetzt starten</button>
        <button type="button" disabled={busy} onClick={() => void run(async () => setLog(await p3.curatorLog(agent)))}>Protokoll laden</button>
        {log && <pre aria-label="Curator-Protokoll">{log.running ? "(läuft noch)\n" : ""}{log.log}</pre>}
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
    <section aria-label="Darstellung im Hermes-Dashboard">
      <h2>Darstellung im Hermes-Dashboard</h2>
      <p className="muted">Gilt nur für das Dashboard von Hermes, nicht für diese WebUI.</p>
      {notes}
      {e && <p className="banner" role="alert">{e}</p>}
      {a && <>
        <label>Theme <select aria-label="Theme" value={a.active} disabled={busy} onChange={(ev) => void run(async () => { await p3.theme(agent, ev.target.value); await load(); })}>
          {a.themes.map((t) => <option key={t.name} value={t.name}>{t.label || t.name}</option>)}</select></label>
        <label>Schrift <select aria-label="Schrift" value={a.font} disabled={busy} onChange={(ev) => void run(async () => { await p3.font(agent, ev.target.value); await load(); })}>
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
    <section aria-label="Datenschutz">
      <h2>Datenschutz</h2>
      {notes}
      {e && <p className="banner" role="alert">{e}</p>}
      {p && m && <>
        <pre aria-label="Egress-Status" style={{ whiteSpace: "pre-wrap" }}>{p.egress}</pre>
        {m.managed
          ? <p>Diese Installation wird verwaltet: die Einwilligung für Nutzungsmetriken lässt sich hier nicht ändern.</p>
          : <>
              <p>Nutzungsmetriken: {m.enabled ? "werden gesammelt" : "aus"}, {m.send ? "werden gesendet" : "werden nicht gesendet"}{m.decided ? "" : " (noch nicht entschieden)"}.</p>
              <button type="button" disabled={busy} onClick={() => void run(async () => { await p3.metrics(agent, { enabled: !m.enabled, send: false }); await load(); })}>{m.enabled ? "Sammeln ausschalten" : "Nur lokal sammeln"}</button>
              {m.enabled && !m.send && <>
                <label><input type="checkbox" aria-label="Senden bestätigen" checked={sure} onChange={(ev) => setSure(ev.target.checked)} /> Ich weiß: Nutzungsdaten verlassen dann diesen Rechner.</label>
                <button type="button" disabled={busy || !sure} onClick={() => void run(async () => { await p3.metrics(agent, { enabled: true, send: true, confirm_send: true }); setSure(false); await load(); })}>Senden einschalten</button>
              </>}
              {m.send && <button type="button" disabled={busy} onClick={() => void run(async () => { await p3.metrics(agent, { enabled: true, send: false }); await load(); })}>Senden ausschalten</button>}
            </>}
      </>}
    </section>
  );
}
