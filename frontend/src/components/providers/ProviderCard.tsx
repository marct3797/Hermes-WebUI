import { useState } from "react";
import { fmtAgo } from "../../format";
import { fmtTokens, fmtUsd } from "../../stats";
import type { AgentRef, ProviderGroup } from "../../types";
import { Icon } from "../Icon";
import { KeyForm } from "./KeyForm";

type Props = { agent: AgentRef; group: ProviderGroup; days: number; onSaved: (message: string) => void };

/** Ein Anbieter: wie er eingerichtet ist (Key, Anmeldung), was darüber lief und das Formular zum Eintragen des Keys. */
export function ProviderCard({ agent, group, days, onSaved }: Props) {
  const [editing, setEditing] = useState(false);
  const u = group.usage;
  const hasSecret = group.keys.some((k) => k.secret);
  const setKeys = group.keys.filter((k) => k.set);
  return (
    <li className={`card prov-card${group.configured ? "" : " off"}`}>
      <div className="row prov-head">
        <b className="grow trunc">{group.label}</b>
        {group.keys.some((k) => k.set) && <span className="tag tag-m">KEY</span>}
        {group.oauth?.logged_in && <span className="tag tag-m">ANGEMELDET</span>}
        {!group.configured && group.used && <span className="tag">NUR GENUTZT</span>}
      </div>

      {u && u.sessions > 0 ? (
        <p className="mono small prov-use">
          {u.sessions} {u.sessions === 1 ? "Session" : "Sessions"} · {fmtTokens(u.input_tokens + u.output_tokens)} Token{u.cost_usd > 0 ? ` · ${fmtUsd(u.cost_usd)}` : ""} in {days} T
          {u.last_used_at ? <span className="t3"> · zuletzt {fmtAgo(u.last_used_at * 1000)}</span> : null}
        </p>
      ) : group.configured ? <p className="hint">Keine Nutzung in den letzten {days} Tagen.</p> : null}
      {u && u.models.length > 0 && <p className="hint prov-models">{[...new Set(u.models)].join(" · ")}</p>}

      {setKeys.length > 0 && (
        <ul className="prov-keys">
          {setKeys.map((k) => <li key={k.var}><span className="mono small">{k.var}</span><span className="mono small t3">gesetzt</span></li>)}
        </ul>
      )}
      {group.oauth && (group.oauth.logged_in || setKeys.length === 0) && (
        <p className="small prov-oauth">
          {group.oauth.logged_in ? <>Angemeldet{group.oauth.source ? ` über ${group.oauth.source}` : ""}.</> : <>Nicht angemeldet.</>}
          {!group.oauth.logged_in && group.oauth.cli_command && <> Die Anmeldung läuft im Terminal des Servers: <code className="mono">{group.oauth.cli_command}</code></>}
        </p>
      )}

      {editing ? (
        <KeyForm agent={agent} group={group} onCancel={() => setEditing(false)} onSaved={(m) => { setEditing(false); onSaved(m); }} />
      ) : hasSecret && (
        <button type="button" className="btn btn-s" style={{ alignSelf: "flex-start" }} onClick={() => setEditing(true)}>
          <Icon name={setKeys.length > 0 ? "edit" : "plus"} size={14} />{setKeys.length > 0 ? "Key ersetzen" : "Key eintragen"}
        </button>
      )}
    </li>
  );
}
