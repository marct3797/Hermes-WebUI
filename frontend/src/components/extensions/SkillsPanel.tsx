import { useEffect, useState } from "react";
import { extApi, type Skill } from "../../extApi";
import { useAsync } from "../../useAsync";
import { Icon } from "../Icon";
import { Markdown } from "../Markdown";
import { Confirm, Loading, Modal, Pill, Problem, SearchBox, Switch, Tabs, type Scope } from "./common";

export const PROVENANCE: Record<string, string> = { bundled: "Mitgeliefert", hub: "Marktplatz", external: "Extern", agent: "Eigener Skill" };
const MAX_BYTES = 200 * 1024;
const bytes = (t: string) => new Blob([t]).size;
const template = (name: string) => `---\nname: ${name}\ndescription: Kurze Beschreibung, wann der Skill hilft\n---\n\n# ${name}\n\nAnleitung für den Agenten: wann der Skill gilt, welche Schritte folgen und worauf zu achten ist.\n`;
const body = (md: string) => md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");

function NewSkill({ scope, onClose, onCreated }: { scope: Scope; onClose: () => void; onCreated: (name: string) => void }) {
  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [content, setContent] = useState(template("mein-skill"));
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const valid = /^[a-z0-9][a-z0-9_-]{0,63}$/.test(name) && (!category || /^[a-z0-9][a-z0-9-]{0,31}$/.test(category));
  const rename = (v: string) => { setName(v); if (!touched) setContent(template(v || "mein-skill")); };
  const create = async () => {
    setBusy(true); setError(undefined);
    try { await extApi.createSkill(scope.host, scope.profile, { name, content, ...(category ? { category } : {}) }); onCreated(name); } catch (e) { setError(e); setBusy(false); }
  };
  return (
    <Modal label="Neuer Skill" onClose={onClose} wide>
      <h2>Neuer Skill</h2>
      <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
        <label className="col grow" style={{ gap: 4 }}><span className="small">Name</span>
          <input className="field field-line" value={name} onChange={(e) => rename(e.target.value)} placeholder="mein-skill" autoFocus spellCheck={false} aria-label="Name" />
          <span className="hint">Kleinbuchstaben, Ziffern, Bindestrich und Unterstrich, höchstens 64 Zeichen</span></label>
        <label className="col grow" style={{ gap: 4 }}><span className="small">Kategorie (optional)</span>
          <input className="field field-line" value={category} onChange={(e) => setCategory(e.target.value)} placeholder="werkzeuge" spellCheck={false} aria-label="Kategorie" /></label>
      </div>
      <label className="col" style={{ gap: 4 }}><span className="small">Inhalt (SKILL.md)</span>
        <textarea className="field ext-code" rows={12} value={content} onChange={(e) => { setContent(e.target.value); setTouched(true); }} aria-label="Inhalt" spellCheck={false} /></label>
      <Problem error={error} />
      <div className="row" style={{ gap: 8, justifyContent: "flex-end" }}>
        <button type="button" className="btn btn-s" onClick={onClose} disabled={busy}>Abbrechen</button>
        <button type="button" className="btn btn-s btn-p" disabled={!valid || busy} onClick={() => void create()}>{busy ? "Lege an…" : "Skill anlegen"}</button>
      </div>
    </Modal>
  );
}

function Editor({ scope, skill, onClose, onChanged, onDirty }: { scope: Scope; skill: Skill; onClose: () => void; onChanged: () => void; onDirty: (d: boolean) => void }) {
  const [rev, setRev] = useState(0);
  const load = useAsync(() => extApi.skill(scope.host, scope.profile, skill.name), [scope.host, scope.profile, skill.name, rev]);
  const [text, setText] = useState<string>();
  const [view, setView] = useState<"edit" | "preview">("edit");
  const [note, setNote] = useState<string>();
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const [ask, setAsk] = useState<"uninstall">();
  const saved = load.data?.content;
  useEffect(() => { if (saved !== undefined) setText(saved); }, [saved]);
  const dirty = text !== undefined && saved !== undefined && text !== saved;
  useEffect(() => { onDirty(dirty); return () => onDirty(false); }, [dirty, onDirty]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const size = text === undefined ? 0 : bytes(text);
  const act = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true); setError(undefined); setNote(undefined);
    try { await fn(); setNote(done); } catch (e) { setError(e); } finally { setBusy(false); }
  };
  const save = () => act(async () => { await extApi.saveSkill(scope.host, scope.profile, skill.name, text!); setRev((r) => r + 1); onChanged(); }, "Gespeichert");
  return (
    <section className="card ext-detail" aria-label={`Skill ${skill.name}`}>
      <header className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <h2 className="grow" style={{ margin: 0 }}>{skill.name}</h2>
        <Pill>{PROVENANCE[skill.provenance] ?? skill.provenance}</Pill>
        {skill.provenance === "hub" && <>
          <button type="button" className="btn btn-s" disabled={busy} onClick={() => void act(() => extApi.updateSkill(scope.host, scope.profile, skill.name), "Aktualisierung gestartet: Hermes aktualisiert alle Marktplatz-Skills dieses Profils.")}><Icon name="refresh" size={14} />Aktualisieren</button>
          <button type="button" className="btn btn-s btn-d" disabled={busy} onClick={() => setAsk("uninstall")}>Deinstallieren</button>
        </>}
        <button type="button" className="btn btn-s btn-g" onClick={onClose} aria-label="Editor schließen"><Icon name="x" size={14} /></button>
      </header>
      <p className="muted small" style={{ margin: 0 }}>{skill.description}</p>
      {load.loading && <Loading what="Inhalt" />}
      {load.error && <Problem error={new Error(load.error)} />}
      {text !== undefined && <>
        <Tabs label="Ansicht" value={view} onChange={setView} tabs={[["edit", "Bearbeiten"], ["preview", "Vorschau"]]} />
        {view === "edit"
          ? <textarea className="field ext-code" rows={18} value={text} onChange={(e) => { setText(e.target.value); setNote(undefined); }} aria-label="Inhalt von SKILL.md" spellCheck={false} />
          : <div className="ext-md" aria-label="Vorschau"><Markdown text={body(text)} /></div>}
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <span className={`mono small ${size > MAX_BYTES ? "ext-bad" : "t3"}`} aria-live="polite">{size.toLocaleString("de-DE")} von {MAX_BYTES.toLocaleString("de-DE")} Bytes</span>
          {dirty && <span className="small ext-warn" role="status">Ungespeicherte Änderungen</span>}
          {note && !dirty && <span className="small t3" role="status">{note}</span>}
          <span className="grow" />
          <button type="button" className="btn btn-s" disabled={!dirty || busy} onClick={() => { setText(saved); setNote(undefined); }}>Verwerfen</button>
          <button type="button" className="btn btn-s btn-p" disabled={!dirty || busy || size > MAX_BYTES} onClick={() => void save()}>{busy ? "Speichere…" : "Speichern"}</button>
        </div>
      </>}
      <Problem error={error} />
      {ask && (
        <Confirm title="Skill deinstallieren?" yes="Deinstallieren" danger onClose={() => setAsk(undefined)}
          onYes={async () => { await extApi.uninstallSkill(scope.host, scope.profile, skill.name); setAsk(undefined); onChanged(); onClose(); }}>
          <p style={{ margin: 0 }}><b>{skill.name}</b> wird aus dem Profil <b>{scope.profile}</b> entfernt. Aus dem Marktplatz lässt er sich wieder installieren.</p>
        </Confirm>
      )}
    </section>
  );
}

export function SkillsPanel({ scope }: { scope: Scope }) {
  const [rev, setRev] = useState(0);
  const list = useAsync(() => extApi.skills(scope.host, scope.profile), [scope.host, scope.profile, rev]);
  const [q, setQ] = useState("");
  const [origin, setOrigin] = useState("");
  const [open, setOpen] = useState<string>();
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState<string | null>();  // Ziel, das auf die Bestätigung wartet ("" = schließen, null = neuer Skill)
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<unknown>();
  const reload = () => setRev((r) => r + 1);
  const go = (target: string | null) => {
    if (dirty) { setPending(target); return; }
    if (target === null) setCreating(true); else setOpen(target || undefined);
  };
  const skills = list.data?.skills ?? [];
  const needle = q.trim().toLowerCase();
  const shown = skills.filter((s) => (!origin || s.provenance === origin) && (!needle || `${s.name} ${s.description} ${s.category ?? ""}`.toLowerCase().includes(needle)));
  const current = skills.find((s) => s.name === open);
  const toggle = async (s: Skill, enabled: boolean) => {
    setError(undefined);
    try { await extApi.toggleSkill(scope.host, scope.profile, s.name, enabled); reload(); } catch (e) { setError(e); }
  };
  return (
    <div className="ext-split">
      <section aria-label="Skills" className="col" style={{ gap: 10 }}>
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <SearchBox value={q} onChange={setQ} label="Skills durchsuchen" />
          <select className="field field-line" style={{ width: "auto" }} value={origin} onChange={(e) => setOrigin(e.target.value)} aria-label="Herkunft">
            <option value="">Alle Herkünfte</option>
            {Object.entries(PROVENANCE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <span className="grow" />
          <button type="button" className="btn btn-s btn-p" onClick={() => go(null)}><Icon name="plus" size={14} />Neuer Skill</button>
        </div>
        <Problem error={error} />
        {list.loading && <Loading what="Skills" />}
        {list.error && <Problem error={new Error(list.error)} />}
        {list.data && <p className="mono small t3" style={{ margin: 0 }}>{shown.length} von {skills.length} Skills</p>}
        {list.data && !shown.length && <div className="empty" style={{ padding: "24px 0" }}><p className="muted">{skills.length ? "Kein Skill passt zur Suche." : "In diesem Profil gibt es noch keine Skills. Lege einen an oder installiere einen aus dem Marktplatz."}</p></div>}
        <ul className="ext-list">
          {shown.map((s) => (
            <li key={s.name} className={`card ext-row${open === s.name ? " sel" : ""}${s.enabled ? "" : " off"}`}>
              <button type="button" className="ext-main" onClick={() => go(s.name)} aria-label={`Skill ${s.name} öffnen`} aria-current={open === s.name}>
                <b>{s.name}</b>
                <span className="small muted">{s.description}</span>
                <span className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                  {s.category && <Pill>{s.category}</Pill>}<Pill>{PROVENANCE[s.provenance] ?? s.provenance}</Pill>
                  {s.usage > 0 && <span className="mono small t3">{s.usage}× genutzt</span>}
                </span>
              </button>
              <Switch on={s.enabled} label={`${s.name} aktiv`} onChange={(v) => void toggle(s, v)} />
            </li>
          ))}
        </ul>
      </section>
      {current && <Editor key={`${scope.host}/${scope.profile}/${current.name}`} scope={scope} skill={current} onClose={() => go("")} onChanged={reload} onDirty={setDirty} />}
      {creating && <NewSkill scope={scope} onClose={() => setCreating(false)} onCreated={(n) => { setCreating(false); reload(); setOpen(n); }} />}
      {pending !== undefined && (
        <Confirm title="Ungespeicherte Änderungen verwerfen?" yes="Verwerfen" danger onClose={() => setPending(undefined)}
          onYes={async () => { const t = pending; setPending(undefined); setDirty(false); if (t === null) setCreating(true); else setOpen(t || undefined); }}>
          <p style={{ margin: 0 }}>Im Editor gibt es Änderungen, die noch nicht gespeichert sind.</p>
        </Confirm>
      )}
    </div>
  );
}
