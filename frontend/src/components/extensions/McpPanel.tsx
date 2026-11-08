import { useState } from "react";
import { extApi, type McpCatalogEntry, type McpNew, type McpServer, type McpTest, type OAuthFlow, type RegistryEntry } from "../../extApi";
import { useAsync } from "../../useAsync";
import { Icon } from "../Icon";
import { Confirm, Loading, Modal, Pill, Problem, SearchBox, Switch, type Scope } from "./common";
import { t as tr } from "../../i18n";

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const ENV_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const lines = (t: string) => t.split("\n").map((l) => l.trim()).filter(Boolean);
const httpsOnly = (u: string | null) => (u && /^https:\/\//.test(u) ? u : null);

export type McpPrefill = Partial<{ name: string; transport: "stdio" | "http"; command: string; args: string[]; url: string; env: string[] }>;

/** Server hinzufügen. Env-Werte und Token werden nur geschrieben und nie wieder angezeigt. */
export function McpForm({ scope, initial = {}, onClose, onDone }: { scope: Scope; initial?: McpPrefill; onClose: () => void; onDone: (name: string) => void }) {
  const [name, setName] = useState(initial.name ?? "");
  const [transport, setTransport] = useState<"stdio" | "http">(initial.transport ?? "stdio");
  const [command, setCommand] = useState(initial.command ?? "");
  const [args, setArgs] = useState((initial.args ?? []).join("\n"));
  const [env, setEnv] = useState((initial.env ?? []).map((k) => `${k}=`).join("\n"));
  const [url, setUrl] = useState(initial.url ?? "");
  const [auth, setAuth] = useState("none");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const pairs = lines(env).map((l) => { const i = l.indexOf("="); return i < 1 ? [l, ""] as const : [l.slice(0, i).trim(), l.slice(i + 1)] as const; });
  const problems = [
    !NAME_RE.test(name) && tr("Name: Buchstaben, Ziffern, Bindestrich und Unterstrich, höchstens 64 Zeichen"),
    transport === "stdio" && !command.trim() && tr("Befehl fehlt"),
    transport === "stdio" && pairs.some(([k, v]) => !ENV_RE.test(k) || !v) && tr("Env-Zeilen brauchen die Form NAME=WERT"),
    transport === "http" && !/^https?:\/\/[^\s/@]+(\/\S*)?$/.test(url.trim()) && tr("URL muss mit http:// oder https:// beginnen und darf keine Zugangsdaten enthalten"),
    transport === "http" && auth === "header" && !token && tr("Bearer-Token fehlt"),
  ].filter(Boolean) as string[];
  const submit = async () => {
    setBusy(true); setError(undefined);
    const body: McpNew = transport === "stdio"
      ? { name, transport, command: command.trim(), args: lines(args), env: Object.fromEntries(pairs) }
      : { name, transport, url: url.trim(), auth, ...(auth === "header" ? { bearer_token: token } : {}) };
    try { await extApi.addMcp(scope.host, scope.profile, body); onDone(name); } catch (e) { setError(e); setBusy(false); }
  };
  return (
    <Modal label={tr("MCP-Server hinzufügen")} onClose={onClose} wide>
      <h2>{tr("MCP-Server hinzufügen")}</h2>
      <p className="hint" style={{ margin: 0 }}>{tr("Profil {profile} auf {host}. Env-Werte und Token werden nur geschrieben und danach nie angezeigt.", { profile: scope.profile, host: scope.host })}</p>
      <label className="col" style={{ gap: 4 }}><span className="small">{tr("Name")}</span>
        <input className="field field-line" value={name} onChange={(e) => setName(e.target.value)} aria-label={tr("Name")} spellCheck={false} autoFocus /></label>
      <fieldset className="row" style={{ gap: 16, border: 0, padding: 0, margin: 0 }}>
        <legend className="small">{tr("Transport")}</legend>
        <label className="row" style={{ gap: 6 }}><input type="radio" name="transport" checked={transport === "stdio"} onChange={() => setTransport("stdio")} />{tr("stdio (lokaler Befehl)")}</label>
        <label className="row" style={{ gap: 6 }}><input type="radio" name="transport" checked={transport === "http"} onChange={() => setTransport("http")} />{tr("http (Adresse)")}</label>
      </fieldset>
      {transport === "stdio" ? <>
        <label className="col" style={{ gap: 4 }}><span className="small">{tr("Befehl")}</span>
          <input className="field field-line" value={command} onChange={(e) => setCommand(e.target.value)} placeholder={tr("npx")} aria-label={tr("Befehl")} spellCheck={false} /></label>
        <label className="col" style={{ gap: 4 }}><span className="small">{tr("Argumente (eines pro Zeile)")}</span>
          <textarea className="field ext-code" rows={3} value={args} onChange={(e) => setArgs(e.target.value)} aria-label={tr("Argumente")} spellCheck={false} /></label>
        <label className="col" style={{ gap: 4 }}><span className="small">{tr("Umgebungsvariablen (NAME=WERT, eine pro Zeile)")}</span>
          <textarea className="field ext-code" rows={3} value={env} onChange={(e) => setEnv(e.target.value)} aria-label={tr("Umgebungsvariablen")} spellCheck={false} autoComplete="off" /></label>
      </> : <>
        <label className="col" style={{ gap: 4 }}><span className="small">{tr("URL")}</span>
          <input className="field field-line" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/mcp" aria-label={tr("URL")} spellCheck={false} /></label>
        <label className="col" style={{ gap: 4 }}><span className="small">{tr("Anmeldung")}</span>
          <select className="field field-line" value={auth} onChange={(e) => setAuth(e.target.value)} aria-label={tr("Anmeldung")}>
            <option value="none">{tr("Keine")}</option><option value="oauth">{tr("OAuth (Anmeldung im Browser)")}</option><option value="header">{tr("Bearer-Token")}</option>
          </select></label>
        {auth === "header" && <label className="col" style={{ gap: 4 }}><span className="small">{tr("Bearer-Token")}</span>
          <input className="field field-line" type="password" value={token} onChange={(e) => setToken(e.target.value)} aria-label={tr("Bearer-Token")} autoComplete="off" /></label>}
      </>}
      {name && problems.length > 0 && <ul className="hint" style={{ margin: 0, paddingLeft: 16 }}>{problems.map((p) => <li key={p}>{p}</li>)}</ul>}
      <Problem error={error} />
      <div className="row" style={{ gap: 8, justifyContent: "flex-end" }}>
        <button type="button" className="btn btn-s" onClick={onClose} disabled={busy}>{tr("Abbrechen")}</button>
        <button type="button" className="btn btn-s btn-p" disabled={problems.length > 0 || busy} onClick={() => void submit()}>{busy ? tr("Füge hinzu…") : tr("Server hinzufügen")}</button>
      </div>
    </Modal>
  );
}

/** Registry-Eintrag als Vorbelegung für das Formular. */
export const prefillOf = (e: RegistryEntry): McpPrefill => ({
  name: e.slug, transport: e.transport ?? "stdio", command: e.command ?? undefined, args: e.args, url: e.url ?? undefined, env: e.env.map((v) => v.name),
});

function CatalogInstall({ scope, entry, onClose, onDone }: { scope: Scope; entry: McpCatalogEntry; onClose: () => void; onDone: () => void }) {
  const [env, setEnv] = useState<Record<string, string>>({});
  const [enable, setEnable] = useState(true);
  const missing = entry.required_env.filter((v) => v.required && !env[v.name]);
  const source = httpsOnly(entry.source);
  return (
    <Confirm title={`${entry.name} installieren`} yes="Installieren" onClose={onClose}
      onYes={async () => { await extApi.installMcp(scope.host, scope.profile, { name: entry.name, env: Object.fromEntries(Object.entries(env).filter(([, v]) => v)), enable }); onDone(); }}>
      <p style={{ margin: 0 }}>{entry.description}</p>
      <p className="mono small t3" style={{ margin: 0 }}>{entry.transport}{entry.url ? ` · ${entry.url}` : ""}{entry.command ? ` · ${entry.command} ${entry.args.join(" ")}` : ""}</p>
      {entry.needs_install && <p className="banner" role="note"><Icon name="alert" /><span>{tr("Dieser Eintrag lädt Code per Git herunter und baut ihn, bevor er startet.")}</span></p>}
      {entry.required_env.map((v) => (
        <label key={v.name} className="col" style={{ gap: 4 }}><span className="small">{v.name}{v.required ? tr(" (nötig)") : ""}: {v.prompt}</span>
          <input className="field field-line" type="password" autoComplete="off" value={env[v.name] ?? ""} onChange={(e) => setEnv({ ...env, [v.name]: e.target.value })} aria-label={v.name} /></label>
      ))}
      {missing.length > 0 && <p className="hint" style={{ margin: 0 }}>{tr("Es fehlen noch: {v}. Ohne sie startet der Server meist nicht.", { v: missing.map((v) => v.name).join(", ") })}</p>}
      <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={enable} onChange={(e) => setEnable(e.target.checked)} />{tr("Nach der Installation aktivieren")}</label>
      {entry.post_install && <p className="small muted" style={{ margin: 0, whiteSpace: "pre-line" }}>{entry.post_install}</p>}
      {source && <a className="inline-link small" href={source} target="_blank" rel="noopener noreferrer">{tr("Dokumentation des Anbieters")}</a>}
    </Confirm>
  );
}

/** Katalog des Hosts mit Suche, Filter und Installation. `load` bestimmt die Quelle (Verwaltung oder Marktplatz). */
export function McpCatalog({ scope, load, onInstalled }: { scope: Scope; load: (q: string) => Promise<{ entries: McpCatalogEntry[] }>; onInstalled: () => void }) {
  const [q, setQ] = useState("");
  const [kind, setKind] = useState("");
  const [rev, setRev] = useState(0);
  const [chosen, setChosen] = useState<McpCatalogEntry>();
  const cat = useAsync(() => load(q.trim()), [scope.host, scope.profile, q, rev]);
  const needle = q.trim().toLowerCase();
  const entries = (cat.data?.entries ?? []).filter((e) => (!kind || e.auth_type === kind) && (!needle || `${e.name} ${e.description}`.toLowerCase().includes(needle)));
  const kinds = [...new Set((cat.data?.entries ?? []).map((e) => e.auth_type))].sort();
  return (
    <section className="col" style={{ gap: 10 }} aria-label={tr("MCP-Katalog")}>
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <SearchBox value={q} onChange={setQ} label={tr("Katalog durchsuchen")} />
        <select className="field field-line" style={{ width: "auto" }} value={kind} onChange={(e) => setKind(e.target.value)} aria-label={tr("Anmeldeart")}>
          <option value="">{tr("Alle Anmeldearten")}</option>{kinds.map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
      </div>
      {cat.loading && <Loading what="Katalog" />}
      {cat.error && <Problem error={new Error(cat.error)} />}
      {cat.data && !entries.length && <div className="empty" style={{ padding: "24px 0" }}><p className="muted">{tr("Kein Katalogeintrag passt zur Suche.")}</p></div>}
      <ul className="ext-list ext-grid">
        {entries.map((e) => (
          <li key={e.name} className="card ext-row">
            <button type="button" className="ext-main" onClick={() => setChosen(e)} aria-label={`${e.name} ansehen`}>
              <b>{e.name}</b><span className="small muted">{e.description}</span>
              <span className="row" style={{ gap: 6, flexWrap: "wrap" }}><Pill>{e.transport}</Pill><Pill>{e.auth_type}</Pill>{e.installed && <Pill tone="ok">{tr("installiert")}</Pill>}</span>
            </button>
          </li>
        ))}
      </ul>
      {chosen && <CatalogInstall scope={scope} entry={chosen} onClose={() => setChosen(undefined)} onDone={() => { setChosen(undefined); setRev((r) => r + 1); onInstalled(); }} />}
    </section>
  );
}

function Detail({ scope, server, onClose, onChanged }: { scope: Scope; server: McpServer; onClose: () => void; onChanged: () => void }) {
  const [test, setTest] = useState<McpTest>();
  const [flow, setFlow] = useState<OAuthFlow>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [ask, setAsk] = useState(false);
  const locked = server.source === "plugin";
  const run = async (fn: () => Promise<void>) => { setBusy(true); setError(undefined); try { await fn(); } catch (e) { setError(e); } finally { setBusy(false); } };
  const link = httpsOnly(flow?.authorization_url ?? null);
  return (
    <section className="card ext-detail" aria-label={`MCP-Server ${server.name}`}>
      <header className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <h2 className="grow" style={{ margin: 0 }}>{server.name}</h2>
        <Pill>{server.transport}</Pill>{locked && <Pill>{tr("von Plugin {plugin}", { plugin: server.plugin })}</Pill>}
        <button type="button" className="btn btn-s btn-g" onClick={onClose} aria-label={tr("Detail schließen")}><Icon name="x" size={14} /></button>
      </header>
      <dl className="ext-dl">
        {server.url && <><dt>{tr("Adresse")}</dt><dd className="mono">{server.url}</dd></>}
        {server.command && <><dt>{tr("Befehl")}</dt><dd className="mono">{[server.command, ...server.args].join(" ")}</dd></>}
        <dt>{tr("Env-Variablen")}</dt><dd className="mono">{server.env_names.length ? server.env_names.map((n) => `${n} (gesetzt)`).join(", ") : tr("keine")}</dd>
        <dt>{tr("Anmeldung")}</dt><dd>{server.auth ?? tr("keine")}</dd>
        <dt>{tr("Werkzeuge")}</dt><dd>{server.tool_count === null ? tr("alle") : server.tool_count}</dd>
        <dt>{tr("Status")}</dt><dd>{server.enabled ? tr("aktiv") : tr("deaktiviert")}</dd>
      </dl>
      {locked && <p className="hint" style={{ margin: 0 }}>{tr("Dieser Server gehört zu einem Plugin und lässt sich nur dort ändern.")}</p>}
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <button type="button" className="btn btn-s" disabled={busy} onClick={() => void run(async () => setTest(await extApi.testMcp(scope.host, scope.profile, server.name)))}><Icon name="play" size={14} />{tr("Verbindung testen")}</button>
        {server.transport === "http" && server.auth === "oauth" && !locked && (
          <button type="button" className="btn btn-s" disabled={busy} onClick={() => void run(async () => setFlow(await extApi.authMcp(scope.host, scope.profile, server.name)))}><Icon name="lock" size={14} />{tr("Anmelden")}</button>
        )}
        <span className="grow" />
        <button type="button" className="btn btn-s btn-d" disabled={busy || locked} onClick={() => setAsk(true)}>{tr("Entfernen")}</button>
      </div>
      {flow && <div className="banner" role="status" style={{ borderColor: "var(--line)" }}><Icon name="lock" /><span>
        {link ? <>{tr("Anmeldung bereit:")} <a className="inline-link" href={link} target="_blank" rel="noopener noreferrer">{tr("Seite des Anbieters öffnen")}</a>. </> : <>{tr("Status:")} {flow.status ?? tr("unbekannt")}{flow.error ? ` (${flow.error})` : ""}. </>}
        {flow.flow_id && <button type="button" className="linkish" onClick={() => void run(async () => setFlow({ ...flow, ...(await extApi.authStatus(scope.host, scope.profile, flow.flow_id!)) }))}>{tr("Status prüfen")}</button>}
        {flow.status && link && <> {tr("Status:")} {flow.status}.</>}
      </span></div>}
      {test && (test.ok
        ? <div role="status"><p style={{ margin: "0 0 6px" }}><b>{tr("Verbindung steht.")}</b> {test.tools.length} {tr("Werkzeuge,")} {test.prompts} {tr("Prompts,")} {test.resources} {tr("Ressourcen.")}</p>
            <ul className="ext-tools">{test.tools.map((t) => <li key={t.name}><span className="mono">{t.name}</span> <span className="small muted">{t.description}</span></li>)}</ul></div>
        : <p className="banner" role="alert"><Icon name="alert" /><span>{tr("Test fehlgeschlagen: {error}", { error: test.error ?? tr("unbekannter Fehler") })}</span></p>)}
      <Problem error={error} />
      {ask && (
        <Confirm title={tr("MCP-Server entfernen?")} yes="Entfernen" danger onClose={() => setAsk(false)}
          onYes={async () => { await extApi.removeMcp(scope.host, scope.profile, server.name); setAsk(false); onChanged(); onClose(); }}>
          <p style={{ margin: 0 }}><b>{server.name}</b> {tr("wird aus der Konfiguration des Profils")} <b>{scope.profile}</b> {tr("gelöscht. Gespeicherte Env-Werte und Anmeldungen müssen bei Bedarf neu eingegeben werden.")}</p>
        </Confirm>
      )}
    </section>
  );
}

export function McpPanel({ scope }: { scope: Scope }) {
  const [rev, setRev] = useState(0);
  const list = useAsync(() => extApi.mcp(scope.host, scope.profile), [scope.host, scope.profile, rev]);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string>();
  const [adding, setAdding] = useState(false);
  const [catalog, setCatalog] = useState(false);
  const [error, setError] = useState<unknown>();
  const reload = () => setRev((r) => r + 1);
  const servers = list.data?.servers ?? [];
  const needle = q.trim().toLowerCase();
  const shown = servers.filter((s) => !needle || `${s.name} ${s.command ?? ""} ${s.url ?? ""}`.toLowerCase().includes(needle));
  const current = servers.find((s) => s.name === open);
  const toggle = async (s: McpServer, enabled: boolean) => {
    setError(undefined);
    try { await extApi.toggleMcp(scope.host, scope.profile, s.name, enabled); reload(); } catch (e) { setError(e); }
  };
  return (
    <div className="ext-split">
      <section aria-label={tr("MCP-Server")} className="col" style={{ gap: 10 }}>
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <SearchBox value={q} onChange={setQ} label={tr("Server durchsuchen")} />
          <span className="grow" />
          <button type="button" className="btn btn-s" onClick={() => setCatalog(true)}>{tr("Aus Katalog installieren")}</button>
          <button type="button" className="btn btn-s btn-p" onClick={() => setAdding(true)}><Icon name="plus" size={14} />{tr("Server hinzufügen")}</button>
        </div>
        <Problem error={error} />
        {list.loading && <Loading what="MCP-Server" />}
        {list.error && <Problem error={new Error(list.error)} />}
        {list.data && !shown.length && <div className="empty" style={{ padding: "24px 0" }}><p className="muted">{servers.length ? tr("Kein Server passt zur Suche.") : tr("In diesem Profil ist noch kein MCP-Server eingerichtet. Füge einen hinzu oder installiere einen aus dem Katalog.")}</p></div>}
        <ul className="ext-list">
          {shown.map((s) => (
            <li key={s.name} className={`card ext-row${open === s.name ? " sel" : ""}${s.enabled ? "" : " off"}`}>
              <button type="button" className="ext-main" onClick={() => setOpen(s.name)} aria-label={tr("Server {name} öffnen", { name: s.name })} aria-current={open === s.name}>
                <b>{s.name}</b>
                <span className="mono small muted">{s.url ?? [s.command, ...s.args].join(" ")}</span>
                <span className="row" style={{ gap: 6, flexWrap: "wrap" }}><Pill>{s.transport}</Pill>{s.source === "plugin" && <Pill>{tr("Plugin")}</Pill>}
                  {s.tool_count !== null && <span className="mono small t3">{tr("{tool_count} Werkzeuge", { tool_count: s.tool_count })}</span>}</span>
              </button>
              <Switch on={s.enabled} label={`${s.name} aktiv`} onChange={(v) => void toggle(s, v)} disabled={s.source === "plugin"} />
            </li>
          ))}
        </ul>
      </section>
      {current && <Detail key={`${scope.host}/${scope.profile}/${current.name}`} scope={scope} server={current} onClose={() => setOpen(undefined)} onChanged={reload} />}
      {adding && <McpForm scope={scope} onClose={() => setAdding(false)} onDone={(n) => { setAdding(false); reload(); setOpen(n); }} />}
      {catalog && (
        <Modal label={tr("Aus Katalog installieren")} onClose={() => setCatalog(false)} wide>
          <header className="row"><h2 className="grow" style={{ margin: 0 }}>{tr("Aus Katalog installieren")}</h2><button type="button" className="btn btn-s btn-g" onClick={() => setCatalog(false)} aria-label={tr("Katalog schließen")}><Icon name="x" size={14} /></button></header>
          <McpCatalog scope={scope} load={() => extApi.mcpCatalog(scope.host, scope.profile)} onInstalled={reload} />
        </Modal>
      )}
    </div>
  );
}
