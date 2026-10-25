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
import { t, tm } from "../i18n";

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
  { to: "/", get label() { return t("Cockpit"); }, icon: "grid" },
  { to: "/inbox", get label() { return t("Inbox"); }, icon: "inbox" },
  { to: "/rooms", get label() { return t("Räume"); }, icon: "orbit" },
  { to: "/assistant", get label() { return t("Assistent"); }, icon: "spark" },
];
const GROUPS: { id: string; label: string; items: NavItem[] }[] = [
  { id: "work", get label() { return t("Arbeit"); }, items: [
    { to: "/kanban", get label() { return t("Kanban"); }, icon: "kanban" },
    { to: "/achievements", get label() { return t("Erfolge"); }, icon: "spark" },
    { to: "/jobs", get label() { return t("Zeitpläne"); }, icon: "clock" },
  ] },
  { id: "know", get label() { return t("Wissen"); }, items: [
    { to: "/memory", get label() { return t("Gedächtnis"); }, icon: "memory" },
    { to: "/knowledge", get label() { return t("Wissen"); }, icon: "file" },
    { to: "/search", get label() { return t("Inhaltssuche"); }, icon: "search" },
  ] },
  { id: "ext", get label() { return t("Erweiterungen"); }, items: [
    { to: "/extensions", get label() { return t("Skills, MCP, Plugins"); }, icon: "wrench" },
    { to: "/marketplace", get label() { return t("Marktplatz"); }, icon: "layers" },
  ] },
  { id: "ops", get label() { return t("Betrieb"); }, items: [
    { to: "/hosts", get label() { return t("Hosts"); }, icon: "server" },
    { to: "/providers", get label() { return t("Anbieter"); }, icon: "coin" },
    { to: "/logs", get label() { return t("Logs"); }, icon: "layers" },
    { to: "/system", get label() { return t("System"); }, icon: "shield" },
  ] },
];
const STORE = "hermes-nav-groups";
function readOpen(): Record<string, boolean> {
  try { return JSON.parse(localStorage.getItem(STORE) ?? "{}") as Record<string, boolean>; } catch { return {}; }
}
// Bereiche eines Hermes-Agents: stehen unter dem gewählten Agent, damit man sie nicht erst in einer Icon-Leiste suchen muss.
const MODULES = [
  { module: "soul", get label() { return t("SOUL & Profil"); }, icon: "spark" },
  { module: "lebenszyklus", get label() { return t("Profile & Betrieb"); }, icon: "server" },
  { module: "config", get label() { return t("Hermes-Einstellungen"); }, icon: "sliders" },
  { module: "modelle", get label() { return t("Modelle"); }, icon: "spark" },
  { module: "endpunkte", get label() { return t("Eigene Endpunkte"); }, icon: "spark" },
  { module: "sitzungen-verwalten", get label() { return t("Sitzungen verwalten"); }, icon: "spark" },
  { module: "zugang", get label() { return t("Zugang und Webhooks"); }, icon: "spark" },
  { module: "sprache", get label() { return t("Sprache"); }, icon: "spark" },
  { module: "lerngraph", get label() { return t("Lerngraph"); }, icon: "spark" },
  { module: "einblicke", get label() { return t("System und Datenschutz"); }, icon: "spark" },
  { module: "providers", get label() { return t("Keys & Nutzung"); }, icon: "coin" },
  { module: "skills", get label() { return t("Skills"); }, icon: "layers" },
  { module: "tools", get label() { return t("Werkzeuge"); }, icon: "wrench" },
  { module: "messaging", get label() { return t("Messaging"); }, icon: "send" },
  { module: "hermes-memory", get label() { return t("Hermes-Gedächtnis"); }, icon: "memory" },
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
      <aside className={`side${p.open ? " open" : ""}`} aria-label={t("Navigation")}>
        <Link to="/" className="brand" onClick={p.onClose} aria-label={t("Hermes, zum Cockpit")}>
          <span className="mk" aria-hidden />
          <b>{t("HERMES")}</b>
          <span className="tag" style={{ marginLeft: "auto" }}>{t("WEBUI")}</span>
        </Link>

        <div className="side-scroll">
          <nav aria-label={t("Übersicht")} className="nav">{TOP.map(link)}</nav>

          <nav aria-label={t("Bereiche")} className="nav nav-groups">
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
                        <Link to={`/hosts/${encodeURIComponent(h.id)}/terminal`} className={p.path === `/hosts/${encodeURIComponent(h.id)}/terminal` ? "on" : undefined} onClick={p.onClose}><Icon name="terminal" size={14} />{t("Terminal")}</Link>
                        <Link to={`/hosts/${encodeURIComponent(h.id)}/workspace`} className={p.path === `/hosts/${encodeURIComponent(h.id)}/workspace` ? "on" : undefined} onClick={p.onClose}><Icon name="file" size={14} />{t("Dateien & Git")}</Link>
                      </div>
                    ))}
                  </div>}
                </div>
              );
            })}
          </nav>

          {error && <p className="error small" role="alert" style={{ padding: "0 16px" }}>{t("Hosts nicht ladbar: {error}", { error })}</p>}
          {!hosts && !error && <p className="muted small" style={{ padding: "0 16px" }}>{t("Lade…")}</p>}
          {hosts?.map((h) => (
            <section key={h.id} aria-label={h.label}>
              <h2 className="hostbar">
                <StatusDot status={h.status} />
                <b>{h.label.toUpperCase()}</b>
                {h.kind === "remote" && <span className="tag">{t("remote")}</span>}
                <span className="r">{h.runtimes.map((r) => `${r.id} · ${r.agents.length}`).join(" · ")}</span>
              </h2>
              {h.status !== "online" && h.detail && <p className="muted small" style={{ padding: "0 16px 4px" }}>{tm(h.detail)}</p>}
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
                            <Link to={agentPath(ref)} onClick={p.onClose}><Icon name="plus" size={14} />{t("Neuer Chat")}</Link>
                            {p.sessionsLoading && <p className="muted small" style={{ padding: "0 8px" }}>{t("Lade…")}</p>}
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
          <span className="who"><b title={p.me.user.id}>{p.me.user.name}</b>{p.me.build && <span className="mono t3" style={{ fontSize: 10 }} title={t("Stand des Codes (Git)")}>{t("Stand {build}", { build: p.me.build })}</span>}</span>
          <Link to="/settings" className={`btn btn-s btn-i btn-g${p.path === "/settings" ? " on" : ""}`} aria-label={t("Darstellung")} title={t("Darstellung")} onClick={p.onClose}>
            <Icon name="sliders" size={16} />
          </Link>
          {p.me.auth_mode === "oidc" && <button type="button" className="btn btn-s btn-g" onClick={p.onLogout}>{t("Abmelden")}</button>}
        </footer>
      </aside>
    </>
  );
}
