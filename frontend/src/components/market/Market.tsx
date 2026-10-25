import { useState } from "react";
import { extApi, type CustomSource, type PluginCatalogEntry, type RegistryEntry } from "../../extApi";
import { useAsync } from "../../useAsync";
import { Icon } from "../Icon";
import { Confirm, Loading, Modal, Pill, Problem, SearchBox, type Scope } from "../extensions/common";
import { McpCatalog, McpForm, prefillOf } from "../extensions/McpPanel";
import { PluginCatalogGrid, PluginEntryDialog, PluginInstallDialog } from "../extensions/PluginsPanel";
import { t } from "../../i18n";

export const KIND_LABEL: Record<string, string> = {
  github: "GitHub-Repository", "well-known": "Well-Known-Domain", url: "Direkt-URL (SKILL.md)", "mcp-registry": "MCP-Registry", "plugin-git": "Plugin-Git-Quelle", hub: "Hub-Quelle",
};
const HINT: Record<string, string> = {
  get github() { return t("owner/repo oder owner/repo/unterordner"); }, "well-known": "https://example.com (liefert /.well-known/skills/index.json)", url: "https://example.com/pfad/SKILL.md",
  get "mcp-registry"() { return t("https://registry.modelcontextprotocol.io (nur https, öffentliche Adressen)"); }, get "plugin-git"() { return t("owner/repo oder https-Git-Adresse"); },
};

function RegistryDialog({ scope, entry, onClose, onAdded }: { scope: Scope; entry: RegistryEntry; onClose: () => void; onAdded: () => void }) {
  const [form, setForm] = useState(false);
  return (
    <Modal label={entry.name} onClose={onClose}>
      <h2 style={{ wordBreak: "break-all" }}>{entry.name}</h2>
      <p style={{ margin: 0 }}>{entry.description || t("Keine Beschreibung.")}</p>
      <p className="mono small t3" style={{ margin: 0 }}>{entry.version && `v${entry.version} · `}{entry.transport ?? t("kein automatischer Start bekannt")}{entry.url ? ` · ${entry.url}` : ""}{entry.command ? ` · ${entry.command} ${entry.args.join(" ")}` : ""}</p>
      {entry.env.length > 0 && <p className="small" style={{ margin: 0 }}>{t("Env-Variablen:")} <span className="mono">{entry.env.map((v) => v.name + (v.required ? "*" : "")).join(", ")}</span></p>}
      {entry.repo && <a className="inline-link small" href={entry.repo} target="_blank" rel="noopener noreferrer">{t("Quelltext ansehen")}</a>}
      {!entry.installable && <p className="hint" style={{ margin: 0 }}>{t("Für dieses Paket ist kein npm-, PyPI- oder Remote-Zugang eingetragen. Hinzufügen geht nur von Hand über „Server hinzufügen“.")}</p>}
      <div className="row" style={{ gap: 8, justifyContent: "flex-end" }}>
        <button type="button" className="btn btn-s" onClick={onClose}>{t("Schließen")}</button>
        <button type="button" className="btn btn-s btn-p" disabled={!entry.installable} onClick={() => setForm(true)}>{t("Als Server hinzufügen")}</button>
      </div>
      {form && <McpForm scope={scope} initial={prefillOf(entry)} onClose={() => setForm(false)} onDone={() => { setForm(false); onAdded(); onClose(); }} />}
    </Modal>
  );
}

function RegistryList({ scope, source }: { scope: Scope; source: string }) {
  const [input, setInput] = useState("");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<RegistryEntry>();
  const [added, setAdded] = useState(false);
  const res = useAsync(() => extApi.registry(source, q), [source, q]);
  return (
    <div className="col" style={{ gap: 10 }}>
      <form className="row" style={{ gap: 8 }} onSubmit={(e) => { e.preventDefault(); setQ(input.trim()); }} role="search">
        <SearchBox value={input} onChange={setInput} label={t("Registry durchsuchen")} /><button type="submit" className="btn btn-s btn-p">{t("Suchen")}</button>
      </form>
      {added && <p className="small t3" role="status" style={{ margin: 0 }}>{t("Server hinzugefügt. Er erscheint unter Erweiterungen, Tab MCP.")}</p>}
      {res.loading && <Loading what="Einträge" />}
      {res.error && <Problem error={new Error(res.error)} />}
      {res.data && !res.data.entries.length && <div className="empty" style={{ padding: "24px 0" }}><p className="muted">{t("Die Registry liefert nichts zu dieser Suche.")}</p></div>}
      <ul className="ext-list ext-grid">
        {(res.data?.entries ?? []).map((e) => (
          <li key={e.name} className="card ext-row">
            <button type="button" className="ext-main" onClick={() => setOpen(e)} aria-label={`${e.name} ansehen`}>
              <b style={{ wordBreak: "break-all" }}>{e.name}</b><span className="small muted">{e.description}</span>
              <span className="row" style={{ gap: 6, flexWrap: "wrap" }}>{e.transport ? <Pill>{e.transport}</Pill> : <Pill tone="warn">{t("nicht automatisch")}</Pill>}{e.version && <span className="mono small t3">v{e.version}</span>}</span>
            </button>
          </li>
        ))}
      </ul>
      {open && <RegistryDialog scope={scope} entry={open} onClose={() => setOpen(undefined)} onAdded={() => setAdded(true)} />}
    </div>
  );
}

export function McpMarket({ scope }: { scope: Scope }) {
  const sources = useAsync(() => extApi.sources(), []);
  const [source, setSource] = useState("catalog");
  const regs = [...(sources.data?.builtin ?? []).map((b) => ({ id: "official", label: b.label })), ...(sources.data?.custom ?? []).filter((c) => c.kind === "mcp-registry").map((c) => ({ id: c.id, label: c.label }))];
  return (
    <section className="col" style={{ gap: 10 }} aria-label={t("MCP-Marktplatz")}>
      <label className="row small" style={{ gap: 6 }}>{t("Quelle")}
        <select className="field field-line" style={{ width: "auto" }} value={source} onChange={(e) => setSource(e.target.value)} aria-label={t("MCP-Quelle")}>
          <option value="catalog">{t("Katalog des Hosts")}</option>{regs.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
        </select>
      </label>
      {source === "catalog"
        ? <McpCatalog scope={scope} load={(q) => extApi.marketMcp(scope.host, q, scope.profile)} onInstalled={() => undefined} />
        : <RegistryList key={source} scope={scope} source={source} />}
    </section>
  );
}

export function PluginMarket({ scope }: { scope: Scope }) {
  const [q, setQ] = useState("");
  const [category, setCategory] = useState("");
  const [rev, setRev] = useState(0);
  const [pick, setPick] = useState<PluginCatalogEntry>();
  const [custom, setCustom] = useState<CustomSource>();
  const res = useAsync(() => extApi.marketPlugins(scope.host, { q: q.trim(), category }), [scope.host, q, category, rev]);
  return (
    <section className="col" style={{ gap: 10 }} aria-label={t("Plugin-Marktplatz")}>
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <SearchBox value={q} onChange={setQ} label={t("Plugins suchen")} />
        <select className="field field-line" style={{ width: "auto" }} value={category} onChange={(e) => setCategory(e.target.value)} aria-label={t("Kategorie")}>
          <option value="">{t("Alle Kategorien")}</option>{(res.data?.categories ?? []).map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>
      {res.loading && <Loading what="Plugins" />}
      {res.error && <Problem error={new Error(res.error)} />}
      {res.data && !res.data.entries.length && <div className="empty" style={{ padding: "24px 0" }}><p className="muted">{t("Kein Plugin im Katalog passt zur Suche.")}</p></div>}
      <PluginCatalogGrid entries={res.data?.entries ?? []} onPick={setPick} />
      {(res.data?.custom.length ?? 0) > 0 && <>
        <h3 style={{ margin: "8px 0 0" }}>{t("Eigene Git-Quellen")}</h3>
        <ul className="ext-list ext-grid">
          {res.data!.custom.map((c) => (
            <li key={c.id} className="card ext-row">
              <button type="button" className="ext-main" onClick={() => setCustom(c)} aria-label={`${c.label} installieren`}>
                <b>{c.label}</b><span className="mono small muted">{c.target}</span><span className="row"><Pill>{t("Eigene Quelle")}</Pill></span>
              </button>
            </li>
          ))}
        </ul>
      </>}
      {pick && <PluginEntryDialog scope={scope} entry={pick} onClose={() => setPick(undefined)} onDone={() => { setPick(undefined); setRev((r) => r + 1); }} />}
      {custom && <PluginInstallDialog scope={scope} what={custom.label} body={{ identifier: custom.target }} onClose={() => setCustom(undefined)} onDone={() => setCustom(undefined)} />}
    </section>
  );
}

export function SourcesPanel({ scope }: { scope: Scope }) {
  const [rev, setRev] = useState(0);
  const mine = useAsync(() => extApi.sources(), [rev]);
  const hub = useAsync(() => extApi.hostSources(scope.host, scope.profile), [scope.host, scope.profile]);
  const [kind, setKind] = useState("github");
  const [target, setTarget] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [doomed, setDoomed] = useState<CustomSource>();
  const data = mine.data;
  const add = async () => {
    setBusy(true); setError(undefined);
    try { await extApi.addSource({ label: label.trim(), kind, target: target.trim() }); setLabel(""); setTarget(""); setRev((r) => r + 1); } catch (e) { setError(e); } finally { setBusy(false); }
  };
  return (
    <section className="col" style={{ gap: 14 }} aria-label={t("Quellen")}>
      <div className="col" style={{ gap: 8 }}>
        <h2 style={{ margin: 0 }}>{t("Vorinstallierte Quellen")}</h2>
        <ul className="ext-list ext-grid">
          {(hub.data?.sources ?? []).filter((s) => s.kind === "hub").map((s) => (
            <li key={s.ref} className="card ext-row"><div className="ext-main"><b>{s.label}</b><span className="row" style={{ gap: 6 }}><Pill>{t("Hub")}</Pill>{!s.searchable && <span className="small t3">{t("nur über die Suche des Hubs")}</span>}</span></div></li>
          ))}
          {(data?.builtin ?? []).map((b) => (
            <li key={b.id} className="card ext-row"><div className="ext-main"><b>{b.label}</b><span className="mono small muted">{b.target}</span><span className="row"><Pill>{KIND_LABEL[b.kind]}</Pill></span></div></li>
          ))}
        </ul>
        {hub.error && <Problem error={new Error(hub.error)} />}
      </div>
      <div className="col" style={{ gap: 8 }}>
        <h2 style={{ margin: 0 }}>{t("Eigene Quellen{data}", { data: data ? ` (${data.custom.length} von ${data.max})` : "" })}</h2>
        {mine.loading && <Loading what="Quellen" />}
        {mine.error && <Problem error={new Error(mine.error)} />}
        {data && !data.custom.length && <p className="muted small" style={{ margin: 0 }}>{t("Noch keine eigenen Quellen. Füge unten ein GitHub-Repository, eine Domain oder eine MCP-Registry hinzu.")}</p>}
        <ul className="ext-list ext-grid">
          {(data?.custom ?? []).map((c) => (
            <li key={c.id} className="card ext-row">
              <div className="ext-main"><b>{c.label}</b><span className="mono small muted" style={{ wordBreak: "break-all" }}>{c.target}</span><span className="row"><Pill>{KIND_LABEL[c.kind] ?? c.kind}</Pill></span></div>
              <button type="button" className="btn btn-s btn-d" onClick={() => setDoomed(c)} aria-label={`${c.label} entfernen`}>{t("Entfernen")}</button>
            </li>
          ))}
        </ul>
      </div>
      <form className="card col" style={{ gap: 8, padding: 14 }} onSubmit={(e) => { e.preventDefault(); void add(); }} aria-label={t("Quelle hinzufügen")}>
        <h2 style={{ margin: 0 }}>{t("Quelle hinzufügen")}</h2>
        <label className="col" style={{ gap: 4 }}><span className="small">{t("Art")}</span>
          <select className="field field-line" value={kind} onChange={(e) => setKind(e.target.value)} aria-label={t("Art")}>
            {(data?.kinds ?? ["github", "well-known", "url", "mcp-registry", "plugin-git"]).map((k) => <option key={k} value={k}>{KIND_LABEL[k] ?? k}</option>)}
          </select></label>
        <label className="col" style={{ gap: 4 }}><span className="small">{t("Ziel")}</span>
          <input className="field field-line" value={target} onChange={(e) => setTarget(e.target.value)} placeholder={HINT[kind]} aria-label={t("Ziel")} spellCheck={false} />
          <span className="hint">{HINT[kind]}</span></label>
        <label className="col" style={{ gap: 4 }}><span className="small">{t("Beschriftung")}</span>
          <input className="field field-line" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} aria-label={t("Beschriftung")} /></label>
        <Problem error={error} />
        <div className="row" style={{ justifyContent: "flex-end" }}><button type="submit" className="btn btn-s btn-p" disabled={busy || !target.trim() || !label.trim()}><Icon name="plus" size={14} />{busy ? t("Füge hinzu…") : t("Quelle hinzufügen")}</button></div>
      </form>
      {doomed && (
        <Confirm title={t("Quelle entfernen?")} yes="Entfernen" danger onClose={() => setDoomed(undefined)} onYes={async () => { await extApi.removeSource(doomed.id); setDoomed(undefined); setRev((r) => r + 1); }}>
          <p style={{ margin: 0 }}><b>{doomed.label}</b> {t("wird aus der Liste entfernt. Bereits installierte Erweiterungen bleiben bestehen.")}</p>
        </Confirm>
      )}
    </section>
  );
}
