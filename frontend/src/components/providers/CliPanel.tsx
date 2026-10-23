import { useState } from "react";
import { api } from "../../api";
import { useHosts } from "../../hosts";
import type { CliAuth, CliAuthEntry, HostInfo } from "../../types";
import { useAsync } from "../../useAsync";
import { Icon } from "../Icon";
import { Link } from "../Link";

export const CLI_NAME: Record<string, string> = { codex: "OpenAI Codex", claude: "Claude Code", "claude-code": "Claude Code", opencode: "OpenCode", agy: "Antigravity", antigravity: "Antigravity" };
export const CLI_DOT: Record<CliAuthEntry["state"], { cls: string; text: string }> = {
  signed_in: { cls: "dot-on", text: "angemeldet" }, signed_out: { cls: "dot-err", text: "abgemeldet" }, unknown: { cls: "dot-off", text: "unbekannt" },
};

/** Kleiner Zustandspunkt (Form und Farbe), nur lesend. */
export function CliDot({ entry }: { entry: CliAuthEntry }) {
  const d = CLI_DOT[entry.state];
  return <span className={`dot ${d.cls}`} role="img" aria-label={`CLI ${CLI_NAME[entry.id] ?? entry.id}: ${d.text}`} title={`${CLI_NAME[entry.id] ?? entry.id}: ${d.text}`} />;
}

function Badge({ entry }: { entry: CliAuthEntry }) {
  if (entry.state === "signed_in") return <span className="tag tag-m">ANGEMELDET{entry.method ? ` · ${entry.method}` : ""}</span>;
  if (entry.state === "signed_out") return <span className="tag tag-e">ABGEMELDET</span>;
  return <span className="tag" title={entry.reason ?? undefined}>UNBEKANNT{entry.reason ? ` · ${entry.reason}` : ""}</span>;
}

function HostClis({ host }: { host: HostInfo }) {
  const [fresh, setFresh] = useState<CliAuth>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const loaded = useAsync(() => api.cliAuth(host.id), [host.id]);
  const data = fresh ?? loaded.data;
  const check = async () => {
    setBusy(true); setError(undefined);
    try { setFresh(await api.cliAuthRefresh(host.id)); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  return (
    <div className="card prov-card" role="group" aria-label={`Coding-CLIs auf ${host.label}`}>
      <div className="row prov-head"><b className="grow">{host.label}</b>
        <button type="button" className="btn btn-s btn-g" disabled={busy || !data?.available} onClick={() => void check()}><Icon name="refresh" size={14} />Prüfen</button></div>
      {loaded.loading && !data && <p className="hint">Lade…</p>}
      {(loaded.error || error) && <p className="hint error" role="alert">Anmeldestatus nicht ladbar: {error ?? loaded.error}</p>}
      {data && !data.available && <p className="hint">{data.reason ?? "Host-Dienst nicht eingerichtet"}</p>}
      {data?.available && !data.clis?.length && <p className="hint">Keine CLI im Host-Dienst eingetragen.</p>}
      <ul className="col" style={{ gap: 8, listStyle: "none", padding: 0, margin: 0 }}>
        {data?.clis?.map((c) => (
          <li key={c.id} className="col" style={{ gap: 4 }}>
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              <b className="grow">{CLI_NAME[c.id] ?? c.id}</b><Badge entry={c} />
              <Link to={`/hosts/${encodeURIComponent(host.id)}/terminal?cli=${encodeURIComponent(c.id)}`} className="btn btn-s" aria-label={`Terminal für ${CLI_NAME[c.id] ?? c.id} auf ${host.label} öffnen`}>Terminal öffnen</Link>
            </div>
            {c.state === "signed_out" && <p className="hint">Im Terminal anmelden (Knopf).{c.id.startsWith("claude") ? " Das Abo gilt nur in der echten CLI im Terminal." : ""}</p>}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Coding-CLIs je Host: Anmeldezustand aus den Statusbefehlen des Host-Dienstes, Prüfen und Terminal öffnen. */
export function CliPanel() {
  const { hosts } = useHosts();
  return (
    <section aria-label="Coding-CLIs" className="col" style={{ gap: 10 }}>
      <span className="lbl">Coding-CLIs auf den Hosts</span>
      {hosts?.length === 0 && <p className="panel-empty">Kein Host eingerichtet.</p>}
      <ul className="prov-grid">{hosts?.map((h) => <li key={h.id}><HostClis host={h} /></li>)}</ul>
    </section>
  );
}
