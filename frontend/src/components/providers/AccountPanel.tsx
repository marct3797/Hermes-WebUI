import { useState } from "react";
import { api } from "../../api";
import type { AccountState, AgentRef, HostAccount } from "../../types";
import { useAsync } from "../../useAsync";
import { Icon } from "../Icon";
import { KeyForm } from "./KeyForm";
import { LoginFlow } from "./LoginFlow";

type Props = { agent: AgentRef; account: HostAccount; state: AccountState | undefined; onChanged: (message: string) => void; onClose: () => void };

/** Ein Zugang (Codex, Claude, OpenCode Go) in einem Profil: Stand, Anmeldung und Key. */
export function AccountPanel({ agent, account, state, onChanged, onClose }: Props) {
  const [editingKey, setEditingKey] = useState(false);
  // Die Key-Variablen des Anbieters stehen in der Anbieterliste des Profils; sie werden erst geholt, wenn man den Zugang öffnet.
  const overview = useAsync(() => api.providers(agent, 7), [agent.host, agent.runtime, agent.agent]);
  const group = overview.data?.providers.find((g) => g.id === account.provider);
  const hasKey = !!group?.keys.some((k) => k.secret);
  const keySet = !!group?.keys.some((k) => k.set && k.secret);
  const via = state?.via === "login" ? `Angemeldet${state.detail ? ` über ${state.detail}` : ""}` : state?.via === "key" ? `Key hinterlegt${state.detail ? ` (${state.detail})` : ""}` : "Nicht eingerichtet";

  return (
    <div className="col" style={{ gap: 12 }}>
      <p className="small" role="status"><b>{account.label}</b> in <span className="mono">{agent.agent}</span>: {via}.</p>
      <p className="hint">{account.hint}</p>
      {account.login !== "key" && <LoginFlow agent={agent} provider={account.provider} kind={account.login} label={account.label} onDone={onChanged} />}
      {overview.error && <p className="hint">Keys nicht ladbar: {overview.error}</p>}
      {overview.data && !group && account.login === "key" && <p className="hint">Dieses Profil kennt den Anbieter „{account.provider}“ nicht. Vermutlich ist die Hermes-Version dort älter.</p>}
      {group && hasKey && (editingKey ? (
        <KeyForm agent={agent} group={group} onCancel={() => setEditingKey(false)} onSaved={(m) => { setEditingKey(false); onChanged(m); }} />
      ) : (
        <button type="button" className="btn btn-s" style={{ alignSelf: "flex-start" }} onClick={() => setEditingKey(true)}>
          <Icon name={keySet ? "edit" : "plus"} size={14} />{keySet ? "Key ersetzen" : "Key eintragen"}
        </button>
      ))}
      <button type="button" className="btn btn-s btn-g" style={{ alignSelf: "flex-start" }} onClick={onClose}>Schließen</button>
    </div>
  );
}
