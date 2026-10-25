import { useState } from "react";
import { api } from "../../api";
import { useHosts } from "../../hosts";
import type { CliAuth, CliAuthEntry, HostInfo } from "../../types";
import { useAsync } from "../../useAsync";
import { Icon } from "../Icon";
import { Link } from "../Link";
import { t } from "../../i18n";

export const CLI_NAME: Record<string, string> = { codex: "OpenAI Codex", claude: "Claude Code", "claude-code": "Claude Code", opencode: "OpenCode", agy: "Antigravity", antigravity: "Antigravity" };
export const CLI_DOT: Record<CliAuthEntry["state"], { cls: string; text: string }> = {
  signed_in: { cls: "dot-on", text: "angemeldet" }, signed_out: { cls: "dot-err", text: "abgemeldet" }, unknown: { cls: "dot-off", get text() { return t("unbekannt"); } },
};

/** Kleiner Zustandspunkt (Form und Farbe), nur lesend. */
export function CliDot({ entry }: { entry: CliAuthEntry }) {
  const d = CLI_DOT[entry.state];
  return <span className={`dot ${d.cls}`} role="img" aria-label={`CLI ${CLI_NAME[entry.id] ?? entry.id}: ${d.text}`} title={`${CLI_NAME[entry.id] ?? entry.id}: ${d.text}`} />;
}

function Badge({ entry }: { entry: CliAuthEntry }) {
  if (entry.state === "signed_in") return <span className="tag tag-m">{t("ANGEMELDET{method}", { method: entry.method ? ` · ${entry.method}` : "" })}</span>;
  if (entry.state === "signed_out") return <span className="tag tag-e">{t("ABGEMELDET")}</span>;
  if (entry.checked_at === null) return <span className="tag" title={t("Wird nur auf Klick geprüft, nie beim Öffnen der Seite")}>{t("NICHT GEPRÜFT")}</span>;
  return <span className="tag" title={entry.reason ?? undefined}>{t("UNBEKANNT{reason}", { reason: entry.reason ? ` · ${entry.reason}` : "" })}</span>;
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
        <button type="button" className="btn btn-s btn-g" disabled={busy || !data?.available} onClick={() => void check()}><Icon name="refresh" size={14} />{t("Prüfen")}</button></div>
      {loaded.loading && !data && <p className="hint">{t("Lade…")}</p>}
      {(loaded.error || error) && <p className="hint error" role="alert">{t("Anmeldestatus nicht ladbar: {error}", { error: error ?? loaded.error })}</p>}
      {data && !data.available && <p className="hint">{data.reason ?? t("Host-Dienst nicht eingerichtet")}</p>}
      {data?.available && !data.clis?.length && <p className="hint">{t("Keine CLI im Host-Dienst eingetragen.")}</p>}
      {data?.clis?.some((c) => c.checked_at === null) && <p className="hint">{t("Der Anmeldestatus wird nie automatisch abgefragt (ein Statusbefehl kann den Schlüsselbund des Systems öffnen). „Prüfen“ liest ihn aus.")}</p>}
      <ul className="col" style={{ gap: 8, listStyle: "none", padding: 0, margin: 0 }}>
        {data?.clis?.map((c) => (
          <li key={c.id} className="col" style={{ gap: 4 }}>
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              <b className="grow">{CLI_NAME[c.id] ?? c.id}</b><Badge entry={c} />
              <Link to={`/hosts/${encodeURIComponent(host.id)}/terminal?cli=${encodeURIComponent(c.id)}`} className="btn btn-s" aria-label={t("Terminal für {id} auf {label} öffnen", { id: CLI_NAME[c.id] ?? c.id, label: host.label })}>{t("Terminal öffnen")}</Link>
            </div>
            {c.state === "signed_out" && <p className="hint">{t("Im Terminal anmelden (Knopf).{startsWith}", { startsWith: c.id.startsWith("claude") ? t(" Das Abo gilt nur in der echten CLI im Terminal.") : "" })}</p>}
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
    <section aria-label={t("Coding-CLIs")} className="col" style={{ gap: 10 }}>
      <span className="lbl">{t("Coding-CLIs auf den Hosts")}</span>
      {hosts?.length === 0 && <p className="panel-empty">{t("Kein Host eingerichtet.")}</p>}
      <ul className="prov-grid">{hosts?.map((h) => <li key={h.id}><HostClis host={h} /></li>)}</ul>
    </section>
  );
}
