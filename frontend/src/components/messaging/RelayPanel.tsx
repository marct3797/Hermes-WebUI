import { useCallback, useEffect, useState } from "react";
import { api } from "../../api";
import { useAction } from "../useAction";
import type { AgentRef, RelayLink, RelayStatus } from "../../types";
import { t } from "../../i18n";

/** Team-Gateway: Chat-Konten mit dem gemeinsamen Bot verknüpfen. Erscheint nur, wenn die Instanz Plattformen über das Relay führt. */
export function RelayPanel({ agent }: { agent: AgentRef }) {
  const [st, setSt] = useState<RelayStatus | null>(null);
  const [link, setLink] = useState<RelayLink | null>(null);
  const [state, setState] = useState("");
  const [typed, setTyped] = useState<Record<string, string>>({});
  const { run, notes, busy } = useAction();
  const load = useCallback((first = false) => api.relayStatus(agent).then(setSt, () => { if (first) setSt(null); }), [agent.host, agent.runtime, agent.agent]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void load(true); }, [load]);
  if (!st || st.platforms.length === 0) return null;

  return (
    <section aria-label={t("Team-Gateway")} className="panel">
      <h2>{t("Team-Gateway")}</h2>
      <p className="muted">{t("Hier verknüpfst du dein Chat-Konto mit dem gemeinsamen Bot: Code anfordern und dem Bot als Direktnachricht schicken.")}</p>
      {st.managed_by === "portal" && <p className="banner">{t("Die Konten dieser Instanz werden im Nous Portal verwaltet.")}</p>}
      {notes}
      {st.platforms.map((p) => (
        <div key={p.platform}>
          <h3>{p.platform}{p.bot_url && <> · <a href={p.bot_url} target="_blank" rel="noreferrer noopener">{t("Bot öffnen")}</a></>}</h3>
          <ul>
            {p.accounts.map((a) => (
              <li key={a.id}>
                <strong>{a.label || a.id}</strong> {a.linked_at && <span className="muted">{a.linked_at}</span>}
                <input aria-label={t("Zum Trennen „trennen“ eintippen: {name}", { name: a.label || a.id })} value={typed[`${p.platform}:${a.id}`] ?? ""} onChange={(e) => { const v = e.target.value; const k = `${p.platform}:${a.id}`; setTyped((o) => ({ ...o, [k]: v })); }} />
                <button type="button" disabled={busy || typed[`${p.platform}:${a.id}`]?.trim() !== "trennen"} onClick={() => void run(async () => { await api.relayUnlink(agent, p.platform, a.id, "trennen"); await load(); })}>{t("Konto {name} trennen", { name: a.label || a.id })}</button>
              </li>
            ))}
          </ul>
          <button type="button" disabled={busy || st.managed_by === "portal"} onClick={() => void run(async () => { setLink(await api.relayLink(agent, p.platform)); setState(""); })}>{t("Konto {p} verknüpfen", { p: p.platform })}</button>
          {link?.platform === p.platform && (
            <div role="status">
              <p>{t("Schicke dem Bot diese Nachricht:")} <code>{link.command}</code></p>
              {link.bot_url && <a href={link.bot_url} target="_blank" rel="noreferrer noopener">{t("Bot öffnen")}</a>}
              <button type="button" disabled={busy} onClick={() => void run(async () => { setState((await api.relayState(agent, link.code)).state); await load(); })}>{t("Stand prüfen")}</button>
              {state && <span> {state === "pending" ? t("wartet auf deine Nachricht") : state === "refused" ? t("abgelehnt") : t("eingelöst oder abgelaufen")}</span>}
            </div>
          )}
        </div>
      ))}
    </section>
  );
}
