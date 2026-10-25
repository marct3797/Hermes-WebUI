import { useState } from "react";
import { extApi, type Plugin, type PluginCatalogEntry, type PluginResult } from "../../extApi";
import { useAsync } from "../../useAsync";
import { Icon } from "../Icon";
import { Confirm, Loading, Modal, Pill, Problem, SearchBox, Switch, TRUST, type Scope } from "./common";
import { t } from "../../i18n";

const IDENT_RE = /^([A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}|https:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9_./~-]{1,200})$/;
export const STATUS: Record<string, string> = { enabled: "aktiv", disabled: "deaktiviert" };
const SOURCE: Record<string, string> = { bundled: "Mitgeliefert", user: "Installiert", git: "Git" };

/** Installation bestätigen. Verlangt das Plugin zusätzliche Berechtigungen, zeigt der Dialog das und installiert erst nach erneutem Klick. */
export function PluginInstallDialog({ scope, what, body, onClose, onDone }: { scope: Scope; what: string; body: { identifier?: string; catalog_name?: string }; onClose: () => void; onDone: () => void }) {
  const [consent, setConsent] = useState(false);
  return (
    <Confirm title={`${what} installieren?`} yes={consent ? t("Trotzdem installieren") : t("Installieren")} onClose={onClose}
      onYes={async () => {
        const r = await extApi.installPlugin(scope.host, scope.profile, { ...body, ...(consent ? { force: true } : {}) });
        if (r.consent_required) { setConsent(true); throw new Error(t("Das Plugin verlangt zusätzliche Berechtigungen (Werkzeuge, Hooks oder Env-Variablen). Prüfe die Quelle und bestätige noch einmal.")); }
        onDone();
      }}>
      <p style={{ margin: 0 }}>{t("Plugins führen Code auf dem Host")} <b>{scope.host}</b> {t("aus und gelten für alle Profile dieses Hosts. Installiere nur Quellen, denen du vertraust.")}</p>
      <p className="mono small t3" style={{ margin: 0 }}>{body.identifier ?? body.catalog_name}</p>
    </Confirm>
  );
}

export function PluginCatalogGrid({ entries, onPick }: { entries: PluginCatalogEntry[]; onPick: (e: PluginCatalogEntry) => void }) {
  return (
    <ul className="ext-list ext-grid">
      {entries.map((e) => (
        <li key={e.name} className="card ext-row">
          <button type="button" className="ext-main" onClick={() => onPick(e)} aria-label={`${e.name} ansehen`}>
            <b>{e.name}</b><span className="small muted">{e.description}</span>
            <span className="row" style={{ gap: 6, flexWrap: "wrap" }}>
              <Pill>{TRUST[e.tier] ?? e.tier}</Pill>{e.category && <Pill>{e.category}</Pill>}{e.version && <span className="mono small t3">v{e.version}</span>}
              {e.installed && <Pill tone="ok">{t("installiert")}</Pill>}{e.update_available && <Pill tone="warn">{t("Update")}</Pill>}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Detailansicht eines Katalogeintrags mit Installieren. */
export function PluginEntryDialog({ scope, entry, onClose, onDone }: { scope: Scope; entry: PluginCatalogEntry; onClose: () => void; onDone: () => void }) {
  const [install, setInstall] = useState(false);
  return (
    <Modal label={entry.name} onClose={onClose}>
      <h2>{entry.name}</h2>
      <p style={{ margin: 0 }}>{entry.description}</p>
      <p className="mono small t3" style={{ margin: 0 }}>{TRUST[entry.tier] ?? entry.tier}{entry.maintainer ? ` · ${entry.maintainer}` : ""}{entry.version ? ` · v${entry.version}` : ""}</p>
      {entry.repo && <a className="inline-link small" href={entry.repo} target="_blank" rel="noopener noreferrer">{t("Quelle ansehen")}</a>}
      {entry.requires_env.length > 0 && <p className="small" style={{ margin: 0 }}>{t("Braucht Env-Variablen:")} <span className="mono">{entry.requires_env.join(", ")}</span></p>}
      <div className="row" style={{ gap: 8, justifyContent: "flex-end" }}>
        <button type="button" className="btn btn-s" onClick={onClose}>{t("Schließen")}</button>
        <button type="button" className="btn btn-s btn-p" disabled={entry.installed} onClick={() => setInstall(true)}>{entry.installed ? t("Bereits installiert") : t("Installieren")}</button>
      </div>
      {install && <PluginInstallDialog scope={scope} what={entry.name} body={{ catalog_name: entry.name }} onClose={() => setInstall(false)} onDone={() => { setInstall(false); onDone(); }} />}
    </Modal>
  );
}

function Detail({ scope, plugin, onClose, onChanged }: { scope: Scope; plugin: Plugin; onClose: () => void; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [note, setNote] = useState<string>();
  const [consent, setConsent] = useState<PluginResult>();
  const [ask, setAsk] = useState(false);
  const update = async (accept: boolean) => {
    setBusy(true); setError(undefined); setNote(undefined);
    try {
      const r = await extApi.pluginAction(scope.host, scope.profile, plugin.name, "update", accept);
      if (r.consent_required) setConsent(r); else { setConsent(undefined); setNote("Aktualisiert."); onChanged(); }
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  return (
    <section className="card ext-detail" aria-label={`Plugin ${plugin.name}`}>
      <header className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <h2 className="grow" style={{ margin: 0 }}>{plugin.name}</h2>
        <Pill>{STATUS[plugin.runtime_status ?? ""] ?? plugin.runtime_status ?? t("unbekannt")}</Pill>
        <button type="button" className="btn btn-s btn-g" onClick={onClose} aria-label={t("Detail schließen")}><Icon name="x" size={14} /></button>
      </header>
      <p style={{ margin: 0 }}>{plugin.description || t("Keine Beschreibung.")}</p>
      <dl className="ext-dl">
        <dt>{t("Version")}</dt><dd className="mono">{plugin.version || t("unbekannt")}</dd>
        <dt>{t("Herkunft")}</dt><dd>{SOURCE[plugin.source] ?? plugin.source}</dd>
        {plugin.auth_required && <><dt>{t("Anmeldung")}</dt><dd>{t("nötig")}{plugin.auth_command ? <>: <span className="mono">{plugin.auth_command}</span></> : ""}</dd></>}
      </dl>
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <button type="button" className="btn btn-s" disabled={busy || !plugin.can_update_git} title={plugin.can_update_git ? undefined : t("Nur Git-Plugins lassen sich aktualisieren")} onClick={() => void update(false)}><Icon name="refresh" size={14} />{t("Aktualisieren")}</button>
        <span className="grow" />
        <button type="button" className="btn btn-s btn-d" disabled={busy || !plugin.can_remove} title={plugin.can_remove ? undefined : t("Mitgelieferte Plugins lassen sich nicht entfernen")} onClick={() => setAsk(true)}>{t("Entfernen")}</button>
      </div>
      {consent && <div className="banner" role="alert"><Icon name="alert" /><span>{t("Das Update verlangt geänderte Berechtigungen.")} <button type="button" className="linkish" onClick={() => void update(true)}>{t("Trotzdem aktualisieren")}</button></span></div>}
      {note && <p className="small t3" role="status" style={{ margin: 0 }}>{note}</p>}
      <Problem error={error} />
      {ask && (
        <Confirm title={t("Plugin entfernen?")} yes="Entfernen" danger onClose={() => setAsk(false)}
          onYes={async () => { await extApi.removePlugin(scope.host, scope.profile, plugin.name); setAsk(false); onChanged(); onClose(); }}>
          <p style={{ margin: 0 }}><b>{plugin.name}</b> {t("wird vom Host")} <b>{scope.host}</b> {t("gelöscht und steht danach in keinem Profil mehr bereit.")}</p>
        </Confirm>
      )}
    </section>
  );
}

export function PluginsPanel({ scope }: { scope: Scope }) {
  const [rev, setRev] = useState(0);
  const list = useAsync(() => extApi.plugins(scope.host, scope.profile), [scope.host, scope.profile, rev]);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string>();
  const [error, setError] = useState<unknown>();
  const [ident, setIdent] = useState("");
  const [install, setInstall] = useState<{ what: string; body: { identifier?: string; catalog_name?: string } }>();
  const [catalog, setCatalog] = useState(false);
  const [pick, setPick] = useState<PluginCatalogEntry>();
  const cat = useAsync(() => (catalog ? extApi.pluginCatalog(scope.host, scope.profile) : Promise.resolve({ entries: [] as PluginCatalogEntry[] })), [catalog, scope.host, scope.profile, rev]);
  const [cq, setCq] = useState("");
  const reload = () => setRev((r) => r + 1);
  const plugins = list.data?.plugins ?? [];
  const needle = q.trim().toLowerCase();
  const shown = plugins.filter((p) => !needle || `${p.name} ${p.description}`.toLowerCase().includes(needle));
  const current = plugins.find((p) => p.name === open);
  const toggle = async (p: Plugin, on: boolean) => {
    setError(undefined);
    try { await extApi.pluginAction(scope.host, scope.profile, p.name, on ? "enable" : "disable"); reload(); } catch (e) { setError(e); }
  };
  const cneedle = cq.trim().toLowerCase();
  return (
    <div className="ext-split">
      <section aria-label={t("Plugins")} className="col" style={{ gap: 10 }}>
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <SearchBox value={q} onChange={setQ} label={t("Plugins durchsuchen")} />
          <span className="grow" />
          <button type="button" className="btn btn-s" onClick={() => setCatalog(true)}>{t("Aus Katalog installieren")}</button>
        </div>
        <form className="row" style={{ gap: 8, flexWrap: "wrap" }} onSubmit={(e) => { e.preventDefault(); if (IDENT_RE.test(ident.trim())) setInstall({ what: ident.trim(), body: { identifier: ident.trim() } }); }}>
          <input className="field field-line grow" style={{ minWidth: 220 }} value={ident} onChange={(e) => setIdent(e.target.value)} placeholder={t("owner/repo oder https-Git-Adresse")} aria-label={t("Plugin-Kennung")} spellCheck={false} />
          <button type="submit" className="btn btn-s btn-p" disabled={!IDENT_RE.test(ident.trim())}>{t("Plugin installieren")}</button>
        </form>
        <Problem error={error} />
        {list.loading && <Loading what="Plugins" />}
        {list.error && <Problem error={new Error(list.error)} />}
        {list.data && !shown.length && <div className="empty" style={{ padding: "24px 0" }}><p className="muted">{plugins.length ? t("Kein Plugin passt zur Suche.") : t("Auf diesem Host sind keine Plugins installiert. Installiere eines aus dem Katalog oder per Git-Kennung.")}</p></div>}
        <ul className="ext-list">
          {shown.map((p) => (
            <li key={p.name} className={`card ext-row${open === p.name ? " sel" : ""}${p.runtime_status === "enabled" ? "" : " off"}`}>
              <button type="button" className="ext-main" onClick={() => setOpen(p.name)} aria-label={t("Plugin {name} öffnen", { name: p.name })} aria-current={open === p.name}>
                <b>{p.name}</b><span className="small muted">{p.description}</span>
                <span className="row" style={{ gap: 6, flexWrap: "wrap" }}><Pill>{SOURCE[p.source] ?? p.source}</Pill>{p.version && <span className="mono small t3">v{p.version}</span>}</span>
              </button>
              <Switch on={p.runtime_status === "enabled"} label={`${p.name} aktiv`} onChange={(v) => void toggle(p, v)} />
            </li>
          ))}
        </ul>
      </section>
      {current && <Detail key={`${scope.host}/${current.name}`} scope={scope} plugin={current} onClose={() => setOpen(undefined)} onChanged={reload} />}
      {install && <PluginInstallDialog scope={scope} what={install.what} body={install.body} onClose={() => setInstall(undefined)} onDone={() => { setInstall(undefined); setIdent(""); reload(); }} />}
      {catalog && (
        <Modal label={t("Plugin-Katalog")} onClose={() => setCatalog(false)} wide>
          <header className="row"><h2 className="grow" style={{ margin: 0 }}>{t("Plugin-Katalog")}</h2><button type="button" className="btn btn-s btn-g" onClick={() => setCatalog(false)} aria-label={t("Katalog schließen")}><Icon name="x" size={14} /></button></header>
          <SearchBox value={cq} onChange={setCq} label={t("Katalog durchsuchen")} />
          {cat.loading && <Loading what="Katalog" />}
          {cat.error && <Problem error={new Error(cat.error)} />}
          <PluginCatalogGrid entries={(cat.data?.entries ?? []).filter((e) => !cneedle || `${e.name} ${e.description}`.toLowerCase().includes(cneedle))} onPick={setPick} />
          {pick && <PluginEntryDialog scope={scope} entry={pick} onClose={() => setPick(undefined)} onDone={() => { setPick(undefined); setCatalog(false); reload(); }} />}
        </Modal>
      )}
    </div>
  );
}
