import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { Icon } from "../components/Icon";
import { GatewayBar } from "../components/messaging/GatewayBar";
import { PlatformPanel } from "../components/messaging/PlatformPanel";
import { PageHead } from "../components/PageHead";
import type { AgentRef, MsgPlatform } from "../types";

const STATE: Record<string, string> = { disabled: "aus", not_configured: "nicht eingerichtet", pending_restart: "Neustart nötig", startup_failed: "Start fehlgeschlagen", gateway_stopped: "Gateway gestoppt", connected: "verbunden", fatal: "Fehler" };
const stateLabel = (s?: string | null) => (s ? STATE[s] ?? s : "unbekannt");

/**
 * Messaging-Plattformen eines Agents (Telegram, Discord, Slack, WhatsApp …) und das Gateway, das sie bedient. Plattformen und Variablen kommen
 * vom Hermes-Dashboard; ohne Dashboard gibt es hier nichts zu tun. Nicht hier: WhatsApp koppeln (QR-Code), das geht über die Hermes-CLI.
 */
export function MessagingPage({ agent, label }: { agent: AgentRef; label: string }) {
  const [rows, setRows] = useState<MsgPlatform[]>();
  const [error, setError] = useState<string>();
  const [open, setOpen] = useState<string>();
  const [q, setQ] = useState("");
  const load = useCallback(() => api.messaging(agent).then((r) => { setRows(r.platforms); setError(undefined); }, (e: Error) => setError(e.message)), [agent.host, agent.runtime, agent.agent]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, [load]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return [...(rows ?? [])].filter((p) => !needle || `${p.name} ${p.id}`.toLowerCase().includes(needle))
      .sort((a, b) => Number(b.enabled || b.configured) - Number(a.enabled || a.configured));
  }, [rows, q]);
  const active = (rows ?? []).filter((p) => p.enabled).length;

  return (
    <main className="page">
      <PageHead title="Messaging" sub={rows ? `${label} · ${active} von ${rows.length} aktiv` : label} />
      {error && <p className="banner" role="alert"><Icon name="alert" />{error}</p>}
      {!rows && !error && <p className="muted">Lade…</p>}
      {rows && (
        <>
          <GatewayBar agent={agent} onChanged={() => void load()} />
          <div className="row mem-bar">
            <label className="search grow">
              <Icon name="search" size={14} />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Plattformen durchsuchen" aria-label="Plattformen durchsuchen" />
            </label>
          </div>
          <ul className="cap-grid" aria-label="Plattformen">
            {shown.map((p) => (
              <Fragment key={p.id}>
                <li className="card cap-card">
                  <div className="row" style={{ gap: 8 }}>
                    <b>{p.name}</b>
                    <span className={`tag${p.state === "connected" ? " tag-c" : p.state === "startup_failed" || p.state === "fatal" ? " tag-e" : ""}`}>{stateLabel(p.state)}</span>
                  </div>
                  {p.description && <p className="muted small">{p.description}</p>}
                  <button type="button" className="btn btn-s btn-g" aria-expanded={open === p.id} aria-label={`${p.name} einrichten`} onClick={() => setOpen(open === p.id ? undefined : p.id)}>
                    <Icon name="sliders" size={14} />Einrichten
                  </button>
                </li>
                {open === p.id && <li className="cap-wide"><PlatformPanel agent={agent} platform={p} onChanged={() => void load()} /></li>}
              </Fragment>
            ))}
          </ul>
          {shown.length === 0 && <p className="panel-empty">Keine Plattform gefunden.</p>}
        </>
      )}
    </main>
  );
}
