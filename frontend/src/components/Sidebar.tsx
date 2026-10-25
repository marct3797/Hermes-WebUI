import { useState } from "react";
import { useHosts } from "../hosts";
import { agentKey, agentPath, sameAgent } from "../router";
import { useRoomNeeds } from "../roomNeeds";
import { useActivity } from "../runs";
import type { AgentRef, Me, SessionSummary } from "../types";
import { sigilFor, useUi } from "../ui";
import { useKnowledgeProviders } from "../knowledge";
import { Icon } from "./Icon";
import { Link } from "./Link";
import { Sigil } from "./Sigil";
import { AgentDot, StatusDot } from "./Status";

type Props = {
  me: Me;
  path: string;
  active?: AgentRef;
  sessionId?: string;
  sessions: SessionSummary[];
  sessionsLoading: boolean;
  open: boolean;
  onClose: () => void;
  onLogout: () => void;
};

type NavItem = { to: string; label: string; icon: string };
// Oben immer sichtbar: was Aufmerksamkeit braucht. Darunter die Chats (Agents), danach aufklappbare Gruppen.
const TOP: NavItem[] = [
  { to: "/", label: "Cockpit", icon: "grid" },
  { to: "/inbox", label: "Inbox", icon: "inbox" },
  { to: "/rooms", label: "Räume", icon: "orbit" },
];
const GROUPS: { id: string; label: string; items: NavItem[] }[] = [
  { id: "work", label: "Arbeit", items: [
    { to: "/kanban", label: "Kanban", icon: "kanban" },
    { to: "/jobs", label: "Zeitpläne", icon: "clock" },
  ] },
  { id: "know", label: "Wissen", items: [
    { to: "/memory", label: "Gedächtnis", icon: "memory" },
    { to: "/knowledge", label: "Wissen", icon: "file" },
    { to: "/search", label: "Inhaltssuche", icon: "search" },
  ] },
  { id: "ext", label: "Erweiterungen", items: [
    { to: "/extensions", label: "Skills, MCP, Plugins", icon: "wrench" },
    { to: "/marketplace", label: "Marktplatz", icon: "layers" },
  ] },
  { id: "ops", label: "Betrieb", items: [
    { to: "/hosts", label: "Hosts", icon: "server" },
    { to: "/providers", label: "Anbieter", icon: "coin" },
    { to: "/logs", label: "Logs", icon: "layers" },
    { to: "/system", label: "System", icon: "shield" },
  ] },
];
const STORE = "hermes-nav-groups";
function readOpen(): Record<string, boolean> {
  try { return JSON.parse(localStorage.getItem(STORE) ?? "{}") as Record<string, boolean>; } catch { return {}; }
}
// Bereiche eines Hermes-Agents: stehen unter dem gewählten Agent, damit man sie nicht erst in einer Icon-Leiste suchen muss.
const MODULES = [
  { module: "soul", label: "SOUL & Profil", icon: "spark" },
  { module: "lebenszyklus", label: "Profile & Betrieb", icon: "server" },
  { module: "config", label: "Hermes-Einstellungen", icon: "sliders" },
  { module: "modelle", label: "Modelle", icon: "spark" },
  { module: "endpunkte", label: "Eigene Endpunkte", icon: "spark" },
  { module: "sitzungen-verwalten", label: "Sitzungen verwalten", icon: "spark" },
  { module: "zugang", label: "Zugang und Webhooks", icon: "spark" },
  { module: "providers", label: "Keys & Nutzung", icon: "coin" },
  { module: "skills", label: "Skills", icon: "layers" },
  { module: "tools", label: "Werkzeuge", icon: "wrench" },
  { module: "messaging", label: "Messaging", icon: "send" },
  { module: "hermes-memory", label: "Hermes-Gedächtnis", icon: "memory" },
] as const;


export function Sidebar(p: Props) {
  const { hosts, error } = useHosts();
  const { sigils } = useUi();
  const { needs, byAgent } = useActivity();
  const { needs: roomNeeds } = useRoomNeeds();
  const wissen = useKnowledgeProviders().length > 0; // nur sichtbar, wenn ein Wissens-Anbieter eingerichtet ist
  const open = (to: string) => (to === "/inbox" ? needs.length + roomNeeds.length : to === "/rooms" ? roomNeeds.length : 0);
  const [stored, setStored] = useState<Record<string, boolean>>(readOpen);
  // Die Gruppe der aktuellen Seite ist immer offen; sonst gilt die gemerkte Wahl des Nutzers.
  const isOpen = (g: (typeof GROUPS)[number]) => g.items.some((n) => p.path === n.to || p.path.startsWith(`${n.to}/`)) || stored[g.id] === true;
  const toggle = (g: (typeof GROUPS)[number]) => setStored((prev) => {
    const next = { ...prev, [g.id]: !isOpen(g) };
    try { localStorage.setItem(STORE, JSON.stringify(next)); } catch { /* ohne Speicher gilt die Auswahl nur bis zum Neuladen */ }
    return next;
  });
  const link = (n: NavItem) => (
    <Link key={n.to} to={n.to} className={p.path === n.to ? "on" : undefined} aria-current={p.path === n.to ? "page" : undefined} onClick={p.onClose}>
      <Icon name={n.icon} size={18} />{n.label}
      {open(n.to) > 0 && <span className="ct" aria-label={`${open(n.to)} offen`}>{open(n.to)}</span>}
    </Link>
  );
  return (
    <>
      {p.open && <div className="scrim" onClick={p.onClose} aria-hidden />}
      <aside className={`side${p.open ? " open" : ""}`} aria-label="Navigation">
        <Link to="/" className="brand" onClick={p.onClose} aria-label="Hermes, zum Cockpit">
          <span className="mk" aria-hidden />
          <b>HERMES</b>
          <span className="tag" style={{ marginLeft: "auto" }}>WEBUI</span>
        </Link>

        <div className="side-scroll">
          <nav aria-label="Übersicht" className="nav">{TOP.map(link)}</nav>

          <nav aria-label="Bereiche" className="nav nav-groups">
            {GROUPS.map((g) => {
              const items = g.items.filter((n) => n.to !== "/knowledge" || wissen);
              const expanded = isOpen(g);
              return (
                <div key={g.id} className="nav-group">
                  <button type="button" className="nav-group-h" aria-expanded={expanded} aria-controls={`nav-${g.id}`} onClick={() => toggle(g)}>
                    <Icon name={expanded ? "chevd" : "chevr"} size={14} />{g.label}
                    <span className="r">{items.length}</span>
                  </button>
                  {expanded && <div id={`nav-${g.id}`} className="nav-group-b">
                    {items.map(link)}
                    {g.id === "ops" && hosts?.map((h) => (
                      <div key={h.id} className="nav-host" role="group" aria-label={`Werkzeuge ${h.label}`}>
                        <span className="lbl">{h.label}</span>
                        <Link to={`/hosts/${encodeURIComponent(h.id)}/terminal`} className={p.path === `/hosts/${encodeURIComponent(h.id)}/terminal` ? "on" : undefined} onClick={p.onClose}><Icon name="terminal" size={14} />Terminal</Link>
                        <Link to={`/hosts/${encodeURIComponent(h.id)}/workspace`} className={p.path === `/hosts/${encodeURIComponent(h.id)}/workspace` ? "on" : undefined} onClick={p.onClose}><Icon name="file" size={14} />Dateien & Git</Link>
                      </div>
                    ))}
                  </div>}
                </div>
              );
            })}
          </nav>

          {error && <p className="error small" role="alert" style={{ padding: "0 16px" }}>Hosts nicht ladbar: {error}</p>}
          {!hosts && !error && <p className="muted small" style={{ padding: "0 16px" }}>Lade…</p>}
          {hosts?.map((h) => (
            <section key={h.id} aria-label={h.label}>
              <h2 className="hostbar">
                <StatusDot status={h.status} />
                <b>{h.label.toUpperCase()}</b>
                {h.kind === "remote" && <span className="tag">remote</span>}
                <span className="r">{h.runtimes.map((r) => `${r.id} · ${r.agents.length}`).join(" · ")}</span>
              </h2>
              {h.status !== "online" && h.detail && <p className="muted small" style={{ padding: "0 16px 4px" }}>{h.detail}</p>}
              {h.runtimes.map((r) => (
                <div key={r.id}>
                  {h.runtimes.length > 1 && <p className="lbl" style={{ padding: "4px 16px 2px" }}>{r.label}</p>}
                  {r.agents.map((a) => {
                    const ref = { host: h.id, runtime: r.id, agent: a.id };
                    const isActive = sameAgent(p.active, ref);
                    const act = byAgent.get(agentKey(ref));
                    return (
                      <div key={a.id}>
                        <Link to={agentPath(ref)} className={`agent${isActive ? " on" : ""}`}
                          aria-current={isActive && !p.sessionId ? "page" : undefined} onClick={p.onClose}
                          style={r.status !== "online" ? { opacity: 0.7 } : undefined}>
                          <Sigil name={a.label} config={sigilFor(sigils, ref)} size="xs" />
                          <span className="grow trunc">{a.label}</span>
                          {act && act.waiting > 0 && <span className="ct" aria-label={`${act.waiting} wartet auf dich`}>{act.waiting}</span>}
                          <AgentDot act={act} status={r.status} />
                        </Link>
                        {isActive && r.id === "hermes" && (
                          <div className="side-sessions side-modules" role="group" aria-label={`Bereiche von ${a.label}`}>
                            {MODULES.map((m) => {
                              const to = agentPath(ref, m.module);
                              return (
                                <Link key={m.module} to={to} className={p.path === to ? "on" : undefined} aria-current={p.path === to ? "page" : undefined} onClick={p.onClose}>
                                  <Icon name={m.icon} size={14} />{m.label}
                                </Link>
                              );
                            })}
                          </div>
                        )}
                        {isActive && (
                          <div className="side-sessions" role="group" aria-label={`Sessions von ${a.label}`}>
                            <Link to={agentPath(ref)} onClick={p.onClose}><Icon name="plus" size={14} />Neuer Chat</Link>
                            {p.sessionsLoading && <p className="muted small" style={{ padding: "0 8px" }}>Lade…</p>}
                            {p.sessions.map((s) => (
                              <Link key={s.id} to={agentPath(ref, "chat", s.id)} className={s.id === p.sessionId ? "on" : undefined}
                                aria-current={s.id === p.sessionId ? "page" : undefined} onClick={p.onClose}>
                                <span className="trunc">{s.title}</span>
                                {s.source && s.source !== "chat" && <span className="tag" style={{ marginLeft: "auto" }}>{s.source}</span>}
                              </Link>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}
            </section>
          ))}

        </div>

        <footer className="side-foot">
          <span className="avatar" aria-hidden>{p.me.user.name.slice(0, 1).toUpperCase()}</span>
          <span className="who"><b title={p.me.user.id}>{p.me.user.name}</b>{p.me.build && <span className="mono t3" style={{ fontSize: 10 }} title="Stand des Codes (Git)">Stand {p.me.build}</span>}</span>
          <Link to="/settings" className={`btn btn-s btn-i btn-g${p.path === "/settings" ? " on" : ""}`} aria-label="Darstellung" title="Darstellung" onClick={p.onClose}>
            <Icon name="sliders" size={16} />
          </Link>
          {p.me.auth_mode === "oidc" && <button type="button" className="btn btn-s btn-g" onClick={p.onLogout}>Abmelden</button>}
        </footer>
      </aside>
    </>
  );
}
