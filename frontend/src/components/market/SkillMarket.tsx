import { useState } from "react";
import { ApiError, extApi, type Hit, type InstallResponse, type Scan } from "../../extApi";
import { useAsync } from "../../useAsync";
import { Icon } from "../Icon";
import { Markdown } from "../Markdown";
import { Loading, Modal, Pill, Problem, SearchBox, TRUST } from "../extensions/common";

const SEVERITY: Record<string, string> = { critical: "kritisch", high: "hoch", medium: "mittel", low: "niedrig" };
const VERDICT: Record<string, string> = { safe: "unbedenklich", caution: "Vorsicht", dangerous: "gefährlich" };
const body = (md: string) => md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");

export function ScanBox({ scan }: { scan: Scan }) {
  const safe = scan.verdict === "safe";
  return (
    <section className={`ext-scan${safe ? "" : " bad"}`} aria-label="Sicherheitsprüfung">
      <h3 style={{ margin: 0 }}>Sicherheitsprüfung: <span className={safe ? "ext-ok" : "ext-bad"}>{VERDICT[scan.verdict] ?? scan.verdict}</span></h3>
      <p className="small muted" style={{ margin: "4px 0" }}>{scan.summary}{scan.policy_reason ? ` (${scan.policy_reason})` : ""}</p>
      {scan.findings.length === 0
        ? <p className="small" style={{ margin: 0 }}>Keine Funde.</p>
        : <ul className="ext-findings">{scan.findings.map((f, i) => (
          <li key={i}><Pill tone={f.severity === "critical" || f.severity === "high" ? "bad" : "warn"}>{SEVERITY[f.severity] ?? f.severity}</Pill>{" "}
            <span className="small">{f.description}</span> <span className="mono small t3">{f.file}{f.line ? `:${f.line}` : ""} · {f.category}</span></li>
        ))}</ul>}
      {scan.tier1 && <p className="small t3" style={{ margin: "4px 0 0" }}>Zweite Meinung (SkillEvaluator): {scan.tier1.passed ? "bestanden" : "nicht bestanden"}, {scan.tier1.findings} Funde.</p>}
    </section>
  );
}

/** Vorschau, Prüfergebnis und Installation in ein oder mehrere Profile. Nichts wird installiert, bevor das Prüfergebnis angezeigt und bestätigt ist. */
export function PreviewDialog({ host, hit, profiles, initial, onClose, onInstalled }: { host: string; hit: Hit; profiles: string[]; initial: string; onClose: () => void; onInstalled: () => void }) {
  const pv = useAsync(() => extApi.preview(host, hit.identifier, initial), [host, hit.identifier, initial]);
  const sc = useAsync(() => extApi.scan(host, hit.identifier, initial), [host, hit.identifier, initial]);
  const [chosen, setChosen] = useState<string[]>([initial]);
  const [confirm, setConfirm] = useState(false);
  const [risk, setRisk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [done, setDone] = useState<InstallResponse>();
  const scan = sc.data;
  const blocked = scan?.policy === "block";
  const clean = scan?.verdict === "safe";
  const run = async () => {
    setBusy(true); setError(undefined);
    try { const r = await extApi.install(host, { identifier: hit.identifier, profiles: chosen, accept_risk: risk }); setDone(r); setConfirm(false); onInstalled(); }
    catch (e) { setError(e instanceof ApiError && e.data?.code ? new Error(e.message) : e); } finally { setBusy(false); }
  };
  const toggle = (p: string) => setChosen((c) => (c.includes(p) ? c.filter((x) => x !== p) : [...c, p]));
  return (
    <Modal label={`Vorschau ${hit.name}`} onClose={onClose} wide>
      <header className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <h2 className="grow" style={{ margin: 0 }}>{hit.name}</h2>
        <Pill>{TRUST[hit.trust_level] ?? hit.trust_level}</Pill>{hit.installed && <Pill tone="ok">installiert</Pill>}
        <button type="button" className="btn btn-s btn-g" onClick={onClose} aria-label="Vorschau schließen"><Icon name="x" size={14} /></button>
      </header>
      <p className="mono small t3" style={{ margin: 0 }}>{hit.identifier}</p>
      {sc.loading && <Loading what="Prüfergebnis" />}
      {sc.error && <p className="banner" role="alert"><Icon name="alert" /><span>Die Sicherheitsprüfung ist nicht möglich: {sc.error}. Ohne Prüfergebnis wird nicht installiert.</span></p>}
      {scan && <ScanBox scan={scan} />}
      {scan && !clean && !blocked && <p className="banner" role="alert"><Icon name="alert" /><span><b>Achtung:</b> Die Prüfung meldet Funde. Lies sie, bevor du installierst.</span></p>}
      {blocked && <p className="banner" role="alert"><Icon name="alert" /><span><b>Blockiert:</b> Die Richtlinie erlaubt diese Installation nicht.</span></p>}
      {pv.loading && <Loading what="Vorschau" />}
      {pv.error && <Problem error={new Error(pv.error)} />}
      {pv.data && <>
        <div className="ext-md" aria-label="SKILL.md"><Markdown text={body(pv.data.skill_md) || "Keine SKILL.md vorhanden."} /></div>
        <p className="small" style={{ margin: 0 }}>Dateien ({pv.data.files.length}): <span className="mono">{pv.data.files.join(", ") || "keine"}</span></p>
      </>}
      {done ? (
        <div role="status"><b>Installation gestartet.</b>
          <ul style={{ margin: "6px 0 0", paddingLeft: 16 }}>{done.results.map((r) => <li key={r.profile}>{r.profile}: {r.ok ? "gestartet" : `fehlgeschlagen (${r.error})`}</li>)}</ul></div>
      ) : (
        <fieldset className="col" style={{ gap: 6, border: 0, padding: 0, margin: 0 }}>
          <legend className="small">Installieren in Profil(e)</legend>
          <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
            {profiles.map((p) => <label key={p} className="row" style={{ gap: 6 }}><input type="checkbox" checked={chosen.includes(p)} onChange={() => toggle(p)} />{p}</label>)}
          </div>
          {confirm && (
            <div className="col" style={{ gap: 6 }} role="group" aria-label="Installation bestätigen">
              <p style={{ margin: 0 }}>{hit.name} wird in {chosen.length} Profil(e) installiert: <b>{chosen.join(", ")}</b>. Skills können dem Agenten Anweisungen und Skripte mitgeben.</p>
              {!clean && <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={risk} onChange={(e) => setRisk(e.target.checked)} />Ich habe die Funde gelesen und installiere trotzdem</label>}
            </div>
          )}
          <Problem error={error} />
          <div className="row" style={{ gap: 8, justifyContent: "flex-end" }}>
            <button type="button" className="btn btn-s" onClick={onClose} disabled={busy}>Abbrechen</button>
            {confirm
              ? <button type="button" className="btn btn-s btn-p" disabled={busy || blocked || (!clean && !risk)} onClick={() => void run()}>{busy ? "Installiere…" : "Jetzt installieren"}</button>
              : <button type="button" className="btn btn-s btn-p" disabled={!scan || blocked || !chosen.length} onClick={() => setConfirm(true)}>Installieren in {chosen.length} Profil(en)</button>}
          </div>
        </fieldset>
      )}
    </Modal>
  );
}

export function SkillMarket({ host, profile, profiles }: { host: string; profile: string; profiles: string[] }) {
  const sources = useAsync(() => extApi.hostSources(host, profile), [host, profile]);
  const [input, setInput] = useState("");
  const [q, setQ] = useState("");
  const [source, setSource] = useState("all");
  const [category, setCategory] = useState("");
  const [rev, setRev] = useState(0);
  const [open, setOpen] = useState<Hit>();
  const res = useAsync(() => extApi.search(host, { q, source, category, profile }), [host, profile, q, source, category, rev]);
  const options = (sources.data?.sources ?? []).filter((s) => s.searchable && s.kind !== "plugin-git" && s.kind !== "mcp-registry");
  const data = res.data;
  return (
    <section className="col" style={{ gap: 10 }} aria-label="Skill-Marktplatz">
      <form className="row" style={{ gap: 8, flexWrap: "wrap" }} onSubmit={(e) => { e.preventDefault(); setQ(input.trim()); }} role="search">
        <SearchBox value={input} onChange={setInput} label="Skills suchen" placeholder="Skills suchen, z. B. pdf oder github" />
        <select className="field field-line" style={{ width: "auto" }} value={source} onChange={(e) => setSource(e.target.value)} aria-label="Quelle">
          <option value="all">Alle Quellen</option>{options.map((s) => <option key={s.ref} value={s.ref}>{s.label}</option>)}
        </select>
        <select className="field field-line" style={{ width: "auto" }} value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Kategorie">
          <option value="">Alle Kategorien</option>{(data?.categories ?? []).map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <button type="submit" className="btn btn-s btn-p">Suchen</button>
      </form>
      {res.loading && <Loading what="Ergebnisse" />}
      {res.error && <Problem error={new Error(res.error)} />}
      {data && <p className="mono small t3" style={{ margin: 0 }}>{data.results.length} Ergebnisse{data.featured ? " (Empfohlen)" : ""}{data.timed_out.length ? ` · keine Antwort von: ${data.timed_out.join(", ")}` : ""}</p>}
      {data?.note && <p className="hint" style={{ margin: 0 }}>{data.note}</p>}
      {data && !data.results.length && !data.note && <div className="empty" style={{ padding: "24px 0" }}><p className="muted">Nichts gefunden. Versuche einen anderen Suchbegriff oder eine andere Quelle.</p></div>}
      <ul className="ext-list ext-grid">
        {(data?.results ?? []).map((h) => (
          <li key={h.identifier} className="card ext-row">
            <button type="button" className="ext-main" onClick={() => setOpen(h)} aria-label={`${h.name} ansehen`}>
              <b>{h.name}</b><span className="small muted">{h.description}</span>
              <span className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                <Pill>{TRUST[h.trust_level] ?? h.trust_level}</Pill>{h.installed && <Pill tone="ok">installiert</Pill>}
                {h.tags.slice(0, 4).map((t) => <span key={t} className="mono small t3">#{t}</span>)}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {open && <PreviewDialog key={open.identifier} host={host} hit={open} profiles={profiles} initial={profile} onClose={() => setOpen(undefined)} onInstalled={() => setRev((r) => r + 1)} />}
    </section>
  );
}
