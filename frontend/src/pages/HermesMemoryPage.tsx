import { useCallback, useEffect, useState } from "react";
import { ApiError, api } from "../api";
import { Icon } from "../components/Icon";
import { PageHead } from "../components/PageHead";
import { StepUpNote } from "../components/providers/StepUpNote";
import type { AgentRef, HmField, HmFileName, HmOverview, HmProvider } from "../types";
import { t } from "../i18n";

const STATUS: Record<string, string> = { ready: "bereit", needs_config: "Key fehlt", unavailable: "Programm fehlt", get missing() { return t("nicht gefunden"); } };
const FILES = [["memory", "MEMORY.md"], ["user", "USER.md"]] as const;
const MEM_NAMES: HmFileName[] = ["MEMORY.md", "USER.md"];
const MEM_LIMIT = 262144;

/** Fähigkeit des Hosts: Fehler eines Aufrufs als Text oder als Hinweis auf die frische Anmeldung. */
function useAction() {
  const [error, setError] = useState<string>();
  const [stepUp, setStepUp] = useState(false);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true); setError(undefined); setStepUp(false);
    try { await fn(); return true; }
    catch (e) { if (e instanceof ApiError && e.code === "step_up_required") setStepUp(true); else setError((e as Error).message); return false; }
    finally { setBusy(false); }
  };
  const notes = <>{stepUp && <StepUpNote what={t("Diese Änderung")} />}{error && <p className="banner" role="alert"><Icon name="alert" /><span>{error}</span></p>}</>;
  return { run, busy, notes };
}

/**
 * Eingebautes Gedaechtnis (MEMORY.md, USER.md) und externe Anbieter. Das Dashboard nennt vom eingebauten Gedaechtnis nur die Groesse. Der
 * Installationsschritt von Hermes (curl | sh) wird bewusst nicht angeboten: fehlende Programme werden nur genannt.
 */
export function HermesMemoryPage({ agent, label }: { agent: AgentRef; label: string }) {
  const [data, setData] = useState<HmOverview>();
  const [error, setError] = useState<string>();
  const load = useCallback(() => api.hmOverview(agent).then((r) => { setData(r); setError(undefined); }, (e: Error) => setError(e.message)), [agent.host, agent.runtime, agent.agent]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, [load]);
  return (
    <main className="page">
      <PageHead title={t("Hermes-Gedächtnis")} sub={data ? `${label} · ${data.active ? `Anbieter ${data.active}` : "eingebaut"}` : label} />
      {error && <p className="banner" role="alert"><Icon name="alert" />{error}</p>}
      {!data && !error && <p className="muted">{t("Lade…")}</p>}
      {data && <Builtin agent={agent} files={data.files} onChanged={() => void load()} />}
      {data && <MemFiles agent={agent} />}
      {data && (
        <section aria-label={t("Externe Anbieter")} className="mem-prov">
          <h2>{t("Externe Anbieter")}</h2>
          <p className="muted small">{t("Ohne Anbieter nutzt Hermes das eingebaute Gedächtnis. „Speichern“ aktiviert einen Anbieter, sobald er bereit ist.")}</p>
          {data.providers.map((p) => <Provider key={p.name} agent={agent} p={p} active={data.active === p.name} onChanged={() => void load()} />)}
        </section>
      )}
    </main>
  );
}

/** Hermes-Dateien (MEMORY.md, USER.md) lesen und bearbeiten. Der Inhalt kommt vom Host-Dienst, nicht vom Dashboard. */
function MemFiles({ agent }: { agent: AgentRef }) {
  const [state, setState] = useState<"ok" | "old" | "nodaemon">("ok");
  const [failed, setFailed] = useState<string>();
  useEffect(() => {
    let stop = false;
    api.hmFiles(agent).then(() => { if (!stop) { setState("ok"); setFailed(undefined); } },
      (e: Error) => {
        if (stop) return;
        if (e instanceof ApiError && e.status === 501) setState("old");
        else if (e instanceof ApiError && e.status === 503) setState("nodaemon");
        else setFailed(e.message);
      });
    return () => { stop = true; };
  }, [agent.host, agent.runtime, agent.agent]); // eslint-disable-line react-hooks/exhaustive-deps
  const note = state === "old" ? t("Der Host-Dienst kennt diese Funktion nicht und ist vermutlich veraltet. Mit deploy/install-hostd.sh aktualisieren.")
    : state === "nodaemon" ? t("Für diesen Host ist kein Host-Dienst eingerichtet. Ohne ihn lassen sich die Dateien nicht bearbeiten.") : null;
  return (
    <section className="card tool-panel" role="region" aria-label={t("Hermes-Dateien")}>
      <b>{t("Hermes-Dateien")}</b>
      {note && <p className="muted small" style={{ margin: 0 }}>{note}</p>}
      {failed && <p className="banner" role="alert"><Icon name="alert" /><span>{failed}</span></p>}
      {!note && !failed && (
        <>
          <p className="muted small" style={{ margin: 0 }}>{t("Einträge sind durch eine Zeile mit § getrennt. Änderungen gelten ab der nächsten Sitzung. Hermes begrenzt beide Dateien auf eine eigene Zeichenzahl (memory_char_limit und user_char_limit in der Konfiguration).")}</p>
          {MEM_NAMES.map((name) => <MemCard key={name} agent={agent} name={name} />)}
        </>
      )}
    </section>
  );
}

function MemCard({ agent, name }: { agent: AgentRef; name: HmFileName }) {
  const [saved, setSaved] = useState<{ content: string; sha: string; size: number }>();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string>();
  const [stepUp, setStepUp] = useState(false);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [done, setDone] = useState<string>();
  const dirty = saved !== undefined && draft !== saved.content;
  const tooLong = new TextEncoder().encode(draft).length > MEM_LIMIT;
  const load = useCallback(async () => {
    setError(undefined); setConflict(false);
    try {
      const f = await api.hmFile(agent, name);
      setSaved({ content: f.content, sha: f.sha256, size: f.size }); setDraft(f.content); setDone(undefined);
    } catch (e) { setError((e as Error).message); }
  }, [agent.host, agent.runtime, agent.agent, name]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!dirty) return;
    const fn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", fn);
    return () => window.removeEventListener("beforeunload", fn);
  }, [dirty]);
  const save = async () => {
    if (!saved || !dirty || tooLong) return;
    if (!window.confirm(t("{name} speichern?", { name }))) return;
    setBusy(true); setError(undefined); setStepUp(false); setConflict(false); setDone(undefined);
    try {
      const r = await api.hmSaveFile(agent, name, draft, saved.sha);
      const f = await api.hmFile(agent, name);   // erst nach dem Zurücklesen gilt es als gespeichert
      setSaved({ content: f.content, sha: f.sha256, size: f.size }); setDraft(f.content);
      setDone(r.backup ? t("Gespeichert. Die vorherige Fassung liegt als Sicherung neben der Datei.") : t("Gespeichert."));
    } catch (e) {
      if (e instanceof ApiError && e.code === "step_up_required") setStepUp(true);
      else if (e instanceof ApiError && e.status === 409) setConflict(true);
      else setError((e as Error).message);
    } finally { setBusy(false); }
  };
  return (
    <div className="pf-fld" role="region" aria-label={name}>
      <div className="row" style={{ gap: 8 }}>
        <b>{name}</b>
        {saved && <span className="muted small">{t("{n} Zeichen gespeichert", { n: saved.size.toLocaleString("de-DE") })}</span>}
        <span className="grow" />
        {conflict && <button type="button" className="btn btn-s btn-g" onClick={() => void load()}>{t("Neu laden")}</button>}
      </div>
      <textarea id={`hm-file-${name}`} className="pf-in mono" rows={8} value={draft} spellCheck={false} aria-label={t("Inhalt von {name}", { name })} onChange={(e) => setDraft(e.target.value)} />
      <div className="row" style={{ gap: 8 }}>
        <span className="hint">{t("{n} von {max} Zeichen", { n: draft.length.toLocaleString("de-DE"), max: MEM_LIMIT.toLocaleString("de-DE") })}</span>
        <span className="grow" />
        <button type="button" className="btn btn-s btn-p" disabled={busy || !dirty || tooLong} onClick={() => void save()}>{t("Speichern")}</button>
      </div>
      {tooLong && <span className="hint" role="alert">{t("Der Inhalt ist größer als 256 KiB")}</span>}
      {conflict && <p className="banner" role="alert"><Icon name="alert" /><span>{t("{name} wurde inzwischen geändert. Lade neu und speichere erneut.", { name })}</span></p>}
      {stepUp && <StepUpNote what={t("Diese Änderung")} />}
      {error && <p className="banner" role="alert"><Icon name="alert" /><span>{error}</span></p>}
      {done && <p className="muted small" role="status" style={{ margin: 0 }}>{done}</p>}
    </div>
  );
}

function Builtin({ agent, files, onChanged }: { agent: AgentRef; files: HmOverview["files"]; onChanged: () => void }) {
  const [asking, setAsking] = useState<"memory" | "user">();
  const [typed, setTyped] = useState("");
  const { run, busy, notes } = useAction();
  return (
    <section className="card tool-panel" role="region" aria-label={t("Eingebautes Gedächtnis")}>
      <b>{t("Eingebautes Gedächtnis")}</b>
      <p className="muted small" style={{ margin: 0 }}>{t("Das Dashboard liefert nur die Größe. Den Inhalt zeigt der Bereich „Hermes-Dateien“ weiter unten, wenn der Host-Dienst läuft.")}</p>
      {FILES.map(([key, name]) => (
        <div key={key} className="row" style={{ gap: 8 }}>
          <span className="grow">{t("{name}: {key} Bytes", { name, key: files[key] })}</span>
          {files[key] > 0 && asking !== key && <button type="button" className="btn btn-s btn-g" onClick={() => { setAsking(key); setTyped(""); }}>{t("{name} zurücksetzen", { name })}</button>}
        </div>
      ))}
      {asking && (
        <div className="pf-fld">
          <label htmlFor="hm-confirm">{t("Zum Bestätigen „{asking}“ eintippen", { asking })}</label>
          <div className="row" style={{ gap: 8 }}>
            <input id="hm-confirm" className="pf-in mono" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
            <button type="button" className="btn btn-s btn-p" disabled={busy || typed !== asking} onClick={async () => { if (await run(() => api.hmReset(agent, asking, typed))) { setAsking(undefined); onChanged(); } }}>{t("Endgültig löschen")}</button>
            <button type="button" className="btn btn-s btn-g" onClick={() => setAsking(undefined)}>{t("Abbrechen")}</button>
          </div>
          <span className="hint">{t("Das Löschen ist endgültig, es gibt keinen Papierkorb.")}</span>
        </div>
      )}
      {notes}
    </section>
  );
}

function Provider({ agent, p, active, onChanged }: { agent: AgentRef; p: HmProvider; active: boolean; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const { run, busy, notes } = useAction();
  const [note, setNote] = useState<string>();
  return (
    <section className="card tool-panel" role="region" aria-label={`Anbieter ${p.name}`}>
      <div className="row" style={{ gap: 8 }}>
        <b>{p.label ?? p.name}</b>
        <span className="tag">{STATUS[p.status ?? ""] ?? p.status}</span>
        {active && <span className="tag tag-c">{t("aktiv")}</span>}
        <span className="grow" />
        {active && <button type="button" className="btn btn-s btn-g" disabled={busy} onClick={async () => { if (await run(() => api.hmSetProvider(agent, ""))) onChanged(); }}>{t("Eingebautes Gedächtnis verwenden")}</button>}
        {p.status === "ready" && !active && <button type="button" className="btn btn-s btn-p" disabled={busy} aria-label={`${p.name} aktivieren`} onClick={async () => { if (await run(() => api.hmSetProvider(agent, p.name))) onChanged(); }}>{t("Aktivieren")}</button>}
        <button type="button" className="btn btn-s btn-g" aria-expanded={open} aria-label={`${p.name} einrichten`} onClick={() => setOpen(!open)}><Icon name="sliders" size={14} />{t("Einrichten")}</button>
      </div>
      {p.description && <p className="muted small" style={{ margin: 0 }}>{p.description}</p>}
      {p.missing.length > 0 && (
        <div className="muted small">
          <div>{t("Fehlt: {v}. Zum Installieren auf dem Rechner des Agents ausführen:", { v: p.missing.map((m) => m.name).join(", ") })}</div>
          {p.missing.map((m) => <code key={m.name} className="mono">{m.install}</code>)}
        </div>
      )}
      {open && <Fields agent={agent} name={p.name} onSaved={() => { setNote("Gespeichert."); onChanged(); }} />}
      {note && <p className="muted small" role="status" style={{ margin: 0 }}>{note}</p>}
      {notes}
    </section>
  );
}

function Fields({ agent, name, onSaved }: { agent: AgentRef; name: string; onSaved: () => void }) {
  const [fields, setFields] = useState<HmField[]>();
  const [meta, setMeta] = useState<{ label?: string | null; docs_url?: string | null }>({});
  const [edits, setEdits] = useState<Record<string, string | boolean>>({});
  const [version, setVersion] = useState(0);
  const { run, busy, notes } = useAction();
  useEffect(() => { void api.hmFields(agent, name).then((r) => { setFields(r.fields); setMeta({ label: r.label, docs_url: r.docs_url }); }, () => setFields([])); }, [agent.host, agent.runtime, agent.agent, name, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const changed = (fields ?? []).filter((f) => {
    const cur = edits[f.key];
    if (cur === undefined) return false;
    if (f.kind === "secret") return typeof cur === "string" && cur.trim() !== "";
    if (f.kind === "bool") return cur !== Boolean(f.value);
    return String(cur) !== String(f.value ?? "");
  });
  const groups = (() => {
    const order: string[] = [];
    for (const f of fields ?? []) if (f.group && !order.includes(f.group)) order.push(f.group);
    return ["", ...order];
  })();
  const inGroup = (g: string) => (fields ?? []).filter((f) => (f.group ?? "") === g);
  if (!fields) return <p className="muted small">{t("Lade…")}</p>;
  const docs = meta.docs_url && /^https?:\/\//.test(meta.docs_url) ? meta.docs_url : null;
  return (
    <form className="prov-form" onSubmit={async (e) => {
      e.preventDefault();
      const values: Record<string, string | boolean | number> = {};
      for (const f of changed) {
        const cur = edits[f.key];
        values[f.key] = f.kind === "bool" ? Boolean(cur) : (typeof cur === "string" && f.kind === "secret" ? cur.trim() : cur as string | number);
      }
      if (await run(() => api.hmSave(agent, name, values))) { setEdits({}); setVersion((v) => v + 1); onSaved(); }
    }}>
      {groups.map((g) => inGroup(g).length > 0 && (
        <fieldset key={g || "allgemein"} style={{ border: 0, padding: 0, margin: 0 }}>
          {g && <legend className="muted small" style={{ padding: 0 }}>{g}</legend>}
          {inGroup(g).map((f) => <FieldRow key={f.key} agent={agent} name={name} f={f} edit={edits[f.key]} setEdit={(v) => setEdits({ ...edits, [f.key]: v })} />)}
        </fieldset>
      ))}
      {docs && <a className="hint" href={docs} target="_blank" rel="noreferrer noopener">{t("Mehr beim Anbieter")}{meta.label ? ` (${meta.label})` : ""}</a>}
      <div className="row" style={{ gap: 8 }}><button type="submit" className="btn btn-s btn-p" disabled={busy || changed.length === 0}><Icon name="check" size={14} />{t("Speichern")}</button></div>
      {notes}
    </form>
  );
}

function FieldRow({ agent, name, f, edit, setEdit }: { agent: AgentRef; name: string; f: HmField; edit: string | boolean | undefined; setEdit: (v: string | boolean) => void }) {
  void agent; void name;
  const id = `hm-${name}-${f.key}`;
  const cur = edit ?? (f.kind === "bool" ? Boolean(f.value) : (f.kind === "secret" ? "" : String(f.value ?? "")));
  const described = f.options.filter((o) => o.description);
  return (
    <div className="pf-fld" key={f.key}>
      <label htmlFor={id}>{f.label ?? f.key}</label>
      {f.info && <span className="hint">{f.info}</span>}
      <div className="row" style={{ gap: 8 }}>
        {f.kind === "select"
          ? <select id={id} className="pf-in grow" value={String(cur)} onChange={(e) => setEdit(e.target.value)}>{f.options.map((o) => <option key={o.value} value={o.value}>{o.label ?? o.value}</option>)}</select>
          : f.kind === "bool"
            ? <input id={id} type="checkbox" checked={Boolean(cur)} onChange={(e) => setEdit(e.target.checked)} />
            : <input id={id} className="pf-in mono grow" type={f.kind === "secret" ? "password" : f.kind === "number" ? "number" : "text"} autoComplete="off" spellCheck={false} value={String(cur)}
                placeholder={f.kind === "secret" && f.is_set ? t("Neuen Wert einfügen, um ihn zu ersetzen") : f.placeholder ?? ""} onChange={(e) => setEdit(e.target.value)} />}
        {f.kind === "secret" && <span className={`tag${f.is_set ? " tag-c" : ""}`}>{f.is_set ? t("gesetzt") : t("nicht gesetzt")}</span>}
      </div>
      {f.kind === "json" && <span className="hint">{t("Als Text: Objekt oder Liste in geschweiften oder eckigen Klammern.")}</span>}
      {f.description && <span className="hint">{f.description}</span>}
      {described.length > 0 && f.kind === "select" && (
        <ul className="hint" style={{ margin: 0, paddingLeft: 16 }}>{described.map((o) => <li key={o.value}>{o.label ?? o.value} — {o.description}</li>)}</ul>
      )}
    </div>
  );
}
