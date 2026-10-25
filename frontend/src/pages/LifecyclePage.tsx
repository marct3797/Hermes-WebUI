import { useCallback, useEffect, useState } from "react";
import { ApiError, api } from "../api";
import { Icon } from "../components/Icon";
import { PageHead } from "../components/PageHead";
import { StepUpNote } from "../components/providers/StepUpNote";
import type { AgentRef, LcEntry } from "../types";

const OK = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const RESERVED = new Set(["hermes", "default", "test", "tmp", "root", "sudo"]);
function nameError(v: string): string | undefined {
  const raw = v.trim();
  if (!raw) return "Bitte einen Namen eingeben.";
  if (raw !== raw.toLowerCase()) return "Nur Kleinbuchstaben: Hermes behandelt Namen case-insensitiv.";
  if (raw.length > 64) return "Höchstens 64 Zeichen.";
  if (RESERVED.has(raw)) return "Dieser Name ist für Hermes reserviert.";
  if (!OK.test(raw)) return "Erlaubt: Kleinbuchstaben, Ziffern, - und _, Beginn mit Buchstabe oder Ziffer.";
  return undefined;
}

/** Fehler eines Aufrufs als Text oder Hinweis auf frische Anmeldung / fehlendes Dashboard. */
function useAction() {
  const [error, setError] = useState<string>();
  const [stepUp, setStepUp] = useState(false);
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true); setError(undefined); setStepUp(false); setMissing(false);
    try { await fn(); return true; }
    catch (e) {
      if (e instanceof ApiError && e.code === "step_up_required") setStepUp(true);
      else if (e instanceof ApiError && e.status === 501) { setMissing(true); setError(e.message); } // die Meldung des BFF unterscheidet „kein Dashboard“ von „Hermes zu alt“
      else setError((e as Error).message);
      return false;
    }
    finally { setBusy(false); }
  };
  const notes = <>{stepUp && <StepUpNote what="Diese Änderung" />}{error && <p className="banner" role="alert"><Icon name="alert" />{error}</p>}</>;
  return { run, busy, notes, setError, missing };
}

/**
 * Profile & Betrieb. Namen kommen als Text vom Dashboard, Serverpfade zeigt die Seite nie.
 * Löschen und Sichern verlangen den eingetippten Namen. Import nimmt nur eine hochgeladene
 * Archivdatei, kein Pfadfeld. Update, Migration, Dump und Debug-Weitergabe fehlen bewusst.
 */
export function LifecyclePage({ agent, label }: { agent: AgentRef; label: string }) {
  const [profiles, setProfiles] = useState<LcEntry[]>();
  const [active, setActive] = useState<string>();
  const [loadError, setLoadError] = useState<string>();
  const [loadMissing, setLoadMissing] = useState(false);
  const load = useCallback(() => api.lcList(agent).then(
    (r) => { setProfiles(r.profiles); setActive(r.active); setLoadError(undefined); setLoadMissing(false); },
    (e: Error) => { if (e instanceof ApiError && e.status === 501) setLoadMissing(true); setLoadError(e.message); }), [agent.host, agent.runtime, agent.agent]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, [load]);
  return (
    <main className="page">
      <PageHead title="Profile & Betrieb" sub={label} />
      {loadError && <p className="banner" role="alert"><Icon name="alert" />{loadError}</p>}
      {!profiles && !loadError && !loadMissing && <p className="muted">Lade…</p>}
      {profiles && <Create agent={agent} onDone={() => void load()} />}
      {profiles && <List agent={agent} profiles={profiles} active={active} onDone={() => void load()} />}
      {profiles && <Ops agent={agent} agentName={agent.agent} />}
    </main>
  );
}

function Create({ agent, onDone }: { agent: AgentRef; onDone: () => void }) {
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [done, setDone] = useState<string>();
  const { run, busy, notes } = useAction();
  const err = name ? nameError(name) : undefined;
  const create = () => {
    const bad = nameError(name);
    if (bad) return;
    void run(async () => {
      const r = await api.lcCreate(agent, { name: name.trim(), description: desc.trim() || undefined });
      setDone(`Profil „${r.name}“ angelegt. ${r.setup ?? ""}`.trim());
      setName(""); setDesc("");
      onDone();
    });
  };
  return (
    <section className="card tool-panel" role="region" aria-label="Profil anlegen">
      <b>Profil anlegen</b>
      <p className="muted small" style={{ margin: 0 }}>Name klein, ohne reservierte Wörter. Hermes meldet den Namen zurück, die Liste prüft ihn.</p>
      <label>Neuer Profilname <input className="field field-line" value={name} onChange={(e) => { setName(e.target.value); setDone(undefined); }} autoComplete="off" /></label>
      {err && <p className="banner" role="alert">{err}</p>}
      <label>Beschreibung (optional, höchstens 300 Zeichen) <input className="field field-line" value={desc} maxLength={300} onChange={(e) => setDesc(e.target.value)} autoComplete="off" /></label>
      <div><button type="button" className="btn" disabled={busy || !name.trim() || !!err} onClick={create}>Profil anlegen</button></div>
      {done && <p className="muted small">{done}</p>}
      {notes}
    </section>
  );
}

function List({ agent, profiles, active, onDone }: { agent: AgentRef; profiles: LcEntry[]; active?: string; onDone: () => void }) {
  return (
    <section className="card tool-panel" role="region" aria-label="Profile">
      <b>Profile</b>
      <p className="muted small" style={{ margin: 0 }}>Namen als Text. Serverpfade zeigt diese Seite grundsätzlich nicht.</p>
      <ul className="plain">
        {profiles.map((p) => <Row key={p.name} agent={agent} entry={p} isActive={active === p.name || (active === undefined && !!p.is_default)} onDone={onDone} />)}
      </ul>
    </section>
  );
}

function Row({ agent, entry, isActive, onDone }: { agent: AgentRef; entry: LcEntry; isActive?: boolean; onDone: () => void }) {
  const { run, busy, notes } = useAction();
  const [mode, setMode] = useState<"none" | "rename" | "clone" | "delete">("none");
  const [value, setValue] = useState("");
  const [tokens, setTokens] = useState(false);
  const err = (mode === "rename" || mode === "clone") && value ? nameError(value) : undefined;
  const reset = () => { setMode("none"); setValue(""); setTokens(false); };
  const rename = () => { const bad = nameError(value); if (bad) return; void run(async () => { await api.lcRename(agent, entry.name, value.trim()); reset(); onDone(); }); };
  const clone = () => {
    const bad = nameError(value); if (bad) return;
    void run(async () => { await api.lcCreate(agent, { name: value.trim(), clone_from: entry.name, clone_channels: tokens }); reset(); onDone(); });
  };
  const remove = () => {
    void run(async () => { await api.lcDelete(agent, entry.name, value); reset(); onDone(); });
  };
  return (
    <li>
      <section role="region" aria-label={`Profil ${entry.name}`}>
        <b>{entry.name}</b>
        {isActive && <span className="muted small"> · aktiv</span>}
        {entry.is_default && <span className="muted small"> · Standard</span>}
        <div className="row">
          <button type="button" className="btn btn-s" disabled={busy} onClick={() => { setMode(mode === "rename" ? "none" : "rename"); setValue(""); }}>Umbenennen</button>
          <button type="button" className="btn btn-s" disabled={busy} onClick={() => { setMode(mode === "clone" ? "none" : "clone"); setValue(""); setTokens(false); }}>Klonen</button>
          <button type="button" className="btn btn-s" disabled={busy} onClick={async () => { await run(() => api.lcSetActive(agent, entry.name)); onDone(); }}>Aktivieren</button>
          <button type="button" className="btn btn-s btn-danger" disabled={busy} onClick={() => { setMode(mode === "delete" ? "none" : "delete"); setValue(""); }}>Löschen</button>
        </div>
        {mode === "rename" && <>
          <label>Neuer Name <input className="field field-line" aria-label="Neuer Name" value={value} onChange={(e) => setValue(e.target.value)} autoComplete="off" /></label>
          {err && <p className="banner" role="alert">{err}</p>}
          <div><button type="button" className="btn" disabled={busy || !value.trim() || !!err} onClick={rename}>Speichern</button></div>
        </>}
        {mode === "clone" && <>
          <label>Kopie heißt <input className="field field-line" aria-label="Kopie heißt" value={value} onChange={(e) => setValue(e.target.value)} autoComplete="off" /></label>
          {err && <p className="banner" role="alert">{err}</p>}
          <label className="check"><input type="checkbox" checked={tokens} onChange={(e) => setTokens(e.target.checked)} /> Bot-Tokens mit kopieren (Kanäle)</label>
          <p className="muted small" style={{ margin: 0 }}>Ohne Häkchen legt der Klon keine Bot-Tokens an.</p>
          <div><button type="button" className="btn" disabled={busy || !value.trim() || !!err} onClick={clone}>Klon anlegen</button></div>
        </>}
        {mode === "delete" && <>
          <label>Zum Bestätigen „{entry.name}“ eintippen <input className="field field-line" value={value} onChange={(e) => setValue(e.target.value)} autoComplete="off" /></label>
          <div><button type="button" className="btn btn-danger" disabled={busy || value !== entry.name} onClick={remove}>Endgültig löschen</button></div>
        </>}
        {notes}
      </section>
    </li>
  );
}

function Ops({ agent, agentName }: { agent: AgentRef; agentName: string }) {
  const { run, busy, notes, setError } = useAction();
  const [asking, setAsking] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [archive, setArchive] = useState<string>();
  const [file, setFile] = useState<File>();
  const [imported, setImported] = useState<string>();
  const backup = () => {
    void run(async () => {
      const r = await api.lcBackup(agent, confirm);
      setArchive(r.archive);
      setAsking(false); setConfirm("");
    });
  };
  const startImport = () => {
    if (!file) return;
    if (!/\.(tar\.gz|tgz|zip)$/i.test(file.name)) { setError("Nur .tar.gz, .tgz oder .zip."); return; }
    if (file.size > 50 * 1024 * 1024) { setError("Höchstens 50 MB."); return; }
    void run(async () => {
      const r = await api.lcImport(agent, file);
      setImported(`Profil „${r.name}“ importiert.`);
      setFile(undefined);
    });
  };
  return (
    <>
      <section className="card tool-panel" role="region" aria-label="Sicherung">
        <b>Sicherung</b>
        <p className="muted small" style={{ margin: 0 }}>Die Sicherung landet als Datei auf dem Dashboard-Rechner. Die Seite zeigt danach nur den Pfad als Hinweis, kein Download.</p>
        {!asking && <div><button type="button" className="btn" disabled={busy} onClick={() => { setAsking(true); setConfirm(""); }}>Sicherung anlegen</button></div>}
        {asking && <>
          <label>Zum Bestätigen „{agentName}“ eintippen <input className="field field-line" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" /></label>
          <div><button type="button" className="btn" disabled={busy || confirm !== agentName} onClick={backup}>Sichern</button></div>
        </>}
        {archive && <p className="muted small">Sicherungspfad: {archive}</p>}
        {notes}
      </section>
      <section className="card tool-panel" role="region" aria-label="Import">
        <b>Import</b>
        <p className="muted small" style={{ margin: 0 }}>Nur eine hochgeladene Archivdatei. Ein Pfadfeld gibt es bewusst nicht.</p>
        <label>Archivdatei (.tar.gz, .tgz, .zip) <input type="file" accept=".tar.gz,.tgz,.zip" onChange={(e) => setFile(e.target.files?.[0])} /></label>
        <div><button type="button" className="btn" disabled={busy || !file} onClick={startImport}>Importieren</button></div>
        {imported && <p className="muted small">{imported}</p>}
        {notes}
      </section>
      <Doctor agent={agent} />
    </>
  );
}

function Doctor({ agent }: { agent: AgentRef }) {
  const { run, busy, notes } = useAction();
  const [log, setLog] = useState<string[]>();
  const check = () => {
    void run(async () => {
      await api.lcDoctor(agent);
      const r = await api.lcDoctorLog(agent);
      setLog(r.lines);
    });
  };
  return (
    <section className="card tool-panel" role="region" aria-label="Zustand">
      <b>Zustand</b>
      <p className="muted small" style={{ margin: 0 }}>Fester Prüfablauf des Dashboards. Die Ausgabe ist zur Ansicht geschwärzt.</p>
      <div><button type="button" className="btn" disabled={busy} onClick={check}>Prüfen</button></div>
      {log && <pre className="log">{log.join("\n")}</pre>}
      {notes}
      <p className="muted small">Einrichtung neuer Rechner, Updates und Migrationen gehören ins Terminal, nicht in diese Seite.</p>
    </section>
  );
}
