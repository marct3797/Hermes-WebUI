import { useRef, useState } from "react";
import { api } from "../../api";
import { agentPath } from "../../router";
import type { AccountState, CliAuthEntry, AgentRef, HostAccount, HostInfo, ProviderMatrix, RuntimeInfo } from "../../types";
import { sigilFor, useUi } from "../../ui";
import { useAsync } from "../../useAsync";
import { Icon } from "../Icon";
import { Link } from "../Link";
import { Sigil } from "../Sigil";
import { StatusDot, STATUS_LABEL } from "../Status";
import { AccountPanel } from "./AccountPanel";
import { CliDot } from "./CliPanel";
import { ModelEditor } from "./ModelEditor";

type Props = { host: HostInfo; runtime: RuntimeInfo };
/** Was unter der Tabelle geöffnet ist: das Modell eines Profils oder ein Zugang in einem Profil. */
type Pick = { profile: string; what: "model" | string };

/**
 * Anbieter auf einem Host: je Profil Modell und Anbieter, je Zugang (Codex, Claude, OpenCode Go) der Stand in jedem Profil.
 * Die Daten holt das BFF vom Dashboard der Maschine; Änderungen gehen auch dorthin.
 */
export function HostProviders({ host, runtime }: Props) {
  const { sigils } = useUi();
  const [reload, setReload] = useState(0);
  const [pick, setPick] = useState<Pick>();
  const [done, setDone] = useState<string>();
  const state = useAsync(() => api.providerMatrix(host.id, runtime.id), [host.id, runtime.id, reload]);
  const cliAuth = useAsync(() => api.cliAuth(host.id), [host.id]); // nur lesend, Fehler zeigt das CLI-Panel
  // Beim Neuladen bleibt die Tabelle stehen, damit nichts springt.
  const last = useRef<ProviderMatrix>();
  if (state.data) last.current = state.data;
  const matrix = state.data ?? last.current;

  const labelOf = (name: string) => runtime.agents.find((a) => a.id === name)?.label ?? name;
  const refOf = (name: string): AgentRef => ({ host: host.id, runtime: runtime.id, agent: name });
  const changed = (message: string) => { setDone(message); setPick(undefined); setReload((n) => n + 1); };
  const toggle = (profile: string, what: string) => { setDone(undefined); setPick((p) => (p && p.profile === profile && p.what === what ? undefined : { profile, what })); };

  const usable = !!matrix?.available;
  const picked = pick && matrix?.profiles.find((p) => p.name === pick.profile);
  const account = pick && pick.what !== "model" ? matrix?.accounts.find((a) => a.id === pick.what) : undefined;

  return (
    <section className="card hub-host" aria-label={`Anbieter auf ${host.label}`}>
      <header className="card-h">
        <StatusDot status={host.status} />
        <h2>{host.label}</h2>
        <span className="tag">{host.kind === "local" ? "lokal" : "remote"}</span>
        <span className="muted small">{runtime.label}{runtime.version ? ` ${runtime.version}` : ""}</span>
        <span className="muted small" style={{ marginLeft: "auto" }}>{STATUS_LABEL[host.status]}</span>
        <button type="button" className="btn btn-s btn-i btn-g" aria-label={`Anbieter von ${host.label} neu laden`} title="Neu laden" onClick={() => setReload((n) => n + 1)}>
          <Icon name="refresh" size={14} />
        </button>
      </header>

      <div className="hub-body col" style={{ gap: 12 }}>
        {state.error && !matrix && <p className="banner" role="alert"><Icon name="alert" /><span>Anbieter von {host.label} nicht ladbar: {state.error}</span></p>}
        {!matrix && state.loading && <p className="muted small">Lade…</p>}
        {matrix && !matrix.available && matrix.reason && (
          <p className="banner" role="alert"><Icon name="alert" /><span>Das Dashboard von {host.label} antwortet nicht ({matrix.reason}). Ohne Dashboard lassen sich hier weder Anbieter lesen noch ändern; die Profile stehen aus der Config.</span></p>
        )}
        {done && <p className="hint crimt" role="status" style={{ margin: 0 }}>{done}</p>}

        {matrix && (
          <div className="hub-scroll">
            <table className="hub-tbl">
              <thead>
                <tr>
                  <th scope="col">Profil</th>
                  <th scope="col">Anbieter · Modell</th>
                  {matrix.accounts.map((a) => <th key={a.id} scope="col">{a.label}<span className="mono t3 hub-cli">{a.cli}</span></th>)}
                </tr>
              </thead>
              <tbody>
                {matrix.profiles.map((p) => (
                  <tr key={p.name}>
                    <th scope="row" data-label="Profil">
                      <Link to={agentPath(refOf(p.name), "soul")} className="hub-profile" title="SOUL & Profil">
                        <Sigil name={labelOf(p.name)} config={sigilFor(sigils, refOf(p.name))} size="xs" />
                        <span className="trunc">{labelOf(p.name)}</span>
                      </Link>
                      {p.error && <span className="hint hub-err" title={p.error}>nicht lesbar</span>}
                    </th>
                    <td data-label="Anbieter · Modell">
                      <button type="button" className={`hub-cell${pick?.profile === p.name && pick.what === "model" ? " on" : ""}`} disabled={!usable || !!p.error}
                        aria-label={`Modell von ${labelOf(p.name)} ändern`} aria-pressed={pick?.profile === p.name && pick.what === "model"} onClick={() => toggle(p.name, "model")}>
                        <span className="mono small trunc">{p.provider ?? "—"} · {p.model ?? "—"}</span>
                        <Icon name="edit" size={12} />
                      </button>
                    </td>
                    {matrix.accounts.map((a) => (
                      <td key={a.id} data-label={a.label}>
                        <AccountCell cli={cliAuth.data?.clis?.find((c) => c.id === a.cli || (a.cli === "claude" && c.id === "claude-code"))} account={a} state={a.profiles[p.name]} profile={labelOf(p.name)} disabled={!usable || !!p.error}
                          on={pick?.profile === p.name && pick.what === a.id} onClick={() => toggle(p.name, a.id)} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {pick && picked && (
          <div className="hub-panel card" role="region" aria-label={pick.what === "model" ? `Modell von ${labelOf(picked.name)}` : `${account?.label ?? pick.what} in ${labelOf(picked.name)}`}>
            {pick.what === "model" ? (
              <ModelEditor key={picked.name} agent={refOf(picked.name)} profile={picked} onSaved={changed} onClose={() => setPick(undefined)} />
            ) : account ? (
              <AccountPanel key={`${picked.name}/${account.id}`} agent={refOf(picked.name)} account={account} state={account.profiles[picked.name]} onChanged={changed} onClose={() => setPick(undefined)} />
            ) : null}
          </div>
        )}

        {matrix && (
          <p className="hint">
            Die Zugänge gelten je Profil, jedes Profil hat seine eigene Anmeldung. Die CLIs ({matrix.accounts.map((a) => a.cli).join(", ")}) auf dem Host zu steuern braucht einen Terminal-Dienst dort; der ist noch nicht angebunden.
          </p>
        )}
      </div>
    </section>
  );
}

function AccountCell({ cli, account, state, profile, on, disabled, onClick }: { account: HostAccount; state: AccountState | undefined; cli?: CliAuthEntry; profile: string; on: boolean; disabled: boolean; onClick: () => void }) {
  const set = !!state?.configured;
  return (
    <button type="button" className={`hub-cell${on ? " on" : ""}${set ? "" : " off"}`} disabled={disabled} aria-pressed={on}
      aria-label={`${account.label} für ${profile}: ${set ? (state?.via === "login" ? "angemeldet" : "Key hinterlegt") : "nicht eingerichtet"}`} onClick={onClick}>
      {set ? <span className="tag tag-m">{state?.via === "login" ? "ANGEMELDET" : "KEY"}</span> : <span className="muted small">einrichten</span>}
      {!set && cli && <CliDot entry={cli} />}
      {set && state?.detail && <span className="mono t3 small trunc hub-detail">{state.detail}</span>}
    </button>
  );
}
