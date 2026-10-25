import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../api";
import { DAY_LABEL, dayGroup, fmtDay, fmtTime, toMs, type DayGroup } from "../../format";
import { isEditable } from "../../keys";
import { agentKey, agentPath, navigate } from "../../router";
import { convKey } from "../../runStore";
import { useActivity, useRunSnapshot } from "../../runs";
import { useShell } from "../../shell";
import type { AgentRef, SessionSummary } from "../../types";
import { sigilFor, useUi } from "../../ui";
import { Icon } from "../Icon";
import { Link } from "../Link";
import { Sigil } from "../Sigil";
import { t } from "../../i18n";

type Props = { agent: AgentRef; label: string; runtimeLabel: string; sessionId?: string };

const AUTOMATION = /^(cron|webhook|automation|schedule)/i;
type Filter = "chats" | "automation";

/** Sessions des Agents nach Tag gruppiert, mit Suche, Filter und Tastenkürzeln (N = neuer Chat, / = Suche). */
export function SessionColumn({ agent, label, runtimeLabel, sessionId }: Props) {
  const { sessions, sessionsLoading, hasMoreSessions, loadingMoreSessions, loadMoreSessions, renameSession, deleteSession, refreshSessions } = useShell();
  const snap = useRunSnapshot();
  const { byAgent } = useActivity();
  const { sigils } = useUi();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("chats");
  const [pinnedOnly, setPinnedOnly] = useState(false);
  const search = useRef<HTMLInputElement>(null);
  // Aktion an einer Session: Menü offen, Umbenennen, Löschen bestätigen (immer nur eine Zeile zugleich).
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [mode, setMode] = useState<"rename" | "delete" | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const closeAction = () => { setMenuFor(null); setMode(null); setActionError(null); };
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setActionError(null);
    try { await fn(); closeAction(); } catch (e) { setActionError((e as Error).message); } finally { setBusy(false); }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isEditable(e.target)) return;
      if (e.key === "/") { e.preventDefault(); search.current?.focus(); }
      else if (e.key.toLowerCase() === "n" && !e.shiftKey) { e.preventDefault(); navigate(agentPath(agent)); }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [agent]);

  const isAuto = (s: SessionSummary) => !!s.source && AUTOMATION.test(s.source);
  const counts = useMemo(() => ({
    chats: sessions.filter((s) => !isAuto(s)).length,
    automation: sessions.filter(isAuto).length,
    pinned: sessions.filter((s) => s.pinned).length,
  }), [sessions]);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const shown = sessions.filter((s) => (filter === "automation" ? isAuto(s) : !isAuto(s))
      && (!pinnedOnly || s.pinned) && (!q || s.title.toLowerCase().includes(q)));
    shown.sort((a, b) => (toMs(b.updatedAt) ?? 0) - (toMs(a.updatedAt) ?? 0));
    const out: Record<DayGroup, SessionSummary[]> = { today: [], yesterday: [], older: [] };
    for (const s of shown) out[dayGroup(toMs(s.updatedAt))].push(s);
    return out;
  }, [sessions, query, filter, pinnedOnly]);

  // Zustand je Session aus dem Run-Zustand: auch eine Session im Hintergrund zeigt „läuft“ oder „wartet“.
  const stateOf = (sid: string): "wait" | "live" | undefined => {
    const st = snap.convs.get(convKey(agent, sid))?.state;
    if (!st || (st.runStatus !== "running" && st.runStatus !== "starting")) return undefined;
    return st.items.some((i) => (i.kind === "approval" && !i.decision) || (i.kind === "clarify" && !i.answer)) ? "wait" : "live";
  };
  const act = byAgent.get(agentKey(agent));
  const agentState = act?.waiting ? "wait" : act?.running ? "live" : undefined;
  const empty = !groups.today.length && !groups.yesterday.length && !groups.older.length;

  return (
    <aside className="sess" aria-label={`Sessions von ${label}`}>
      <div className="sess-h">
        <div className="col" style={{ gap: 8 }}>
          <div className="row" style={{ gap: 12 }}>
            <Sigil name={label} config={sigilFor(sigils, agent)} size="m" state={agentState} />
            <div className="col grow" style={{ gap: 2, minWidth: 0 }}>
              <span className="sess-name trunc">{label}</span>
              <span className="mono t3 trunc" style={{ fontSize: 10.5 }}>{agent.host} · {runtimeLabel.toLowerCase()}</span>
            </div>
          </div>
          <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
            {agent.runtime === "hermes" && (
              <>
                <Link to={agentPath(agent, "soul")} className="btn btn-s btn-i btn-g" aria-label={`SOUL von ${label}`} title={t("SOUL & Profil")}><Icon name="spark" size={14} /></Link>
                <Link to={agentPath(agent, "providers")} className="btn btn-s btn-i btn-g" aria-label={`Keys von ${label}`} title={t("Keys & Nutzung")}><Icon name="coin" size={14} /></Link>
                <Link to={agentPath(agent, "skills")} className="btn btn-s btn-i btn-g" aria-label={`Skills von ${label}`} title={t("Skills")}><Icon name="layers" size={14} /></Link>
                <Link to={agentPath(agent, "tools")} className="btn btn-s btn-i btn-g" aria-label={`Werkzeuge von ${label}`} title={t("Werkzeuge")}><Icon name="wrench" size={14} /></Link>
              </>
            )}
            <Link to={agentPath(agent, "profil")} className="btn btn-s btn-i btn-g" aria-label={`Profil von ${label} bearbeiten`} title={t("Profil bearbeiten")}><Icon name="edit" size={14} /></Link>
          </div>
        </div>
        <Link to={agentPath(agent)} className="btn btn-p" style={{ width: "100%" }}><Icon name="plus" size={14} />{t("Neuer Chat")}<span className="kbd">N</span></Link>
        <label className="search">
          <Icon name="search" size={14} />
          <input ref={search} value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("Sessions durchsuchen")} aria-label={t("Sessions durchsuchen")} />
          <span className="kbd">/</span>
        </label>
        <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
          <button type="button" className={`chip chip-s${filter === "chats" ? " on" : ""}`} aria-pressed={filter === "chats"} onClick={() => setFilter("chats")}>{t("Chats")}<span className="n">{counts.chats}</span></button>
          {counts.automation > 0 && (
            <button type="button" className={`chip chip-s${filter === "automation" ? " on" : ""}`} aria-pressed={filter === "automation"} onClick={() => setFilter("automation")}>{t("Automation")}<span className="n">{counts.automation}</span></button>
          )}
          {counts.pinned > 0 && (
            <button type="button" className={`chip chip-s${pinnedOnly ? " on" : ""}`} aria-pressed={pinnedOnly} aria-label={t("Nur angepinnte")} onClick={() => setPinnedOnly(!pinnedOnly)}><Icon name="pin" size={12} />{counts.pinned}</button>
          )}
        </div>
      </div>

      <div className="sess-list">
        {sessionsLoading && <p className="muted small" style={{ padding: "12px 16px" }}>{t("Lade…")}</p>}
        {!sessionsLoading && empty && <p className="muted small" style={{ padding: "12px 16px" }}>{query ? t("Keine Treffer.") : t("Noch keine Sessions.")}</p>}
        {(["today", "yesterday", "older"] as const).map((g) => groups[g].length > 0 && (
          <div key={g} role="group" aria-label={DAY_LABEL[g]}>
            <div className="sgrp lbl">{DAY_LABEL[g]}</div>
            {groups[g].map((s) => {
              const on = s.id === sessionId;
              const state = stateOf(s.id);
              const at = toMs(s.updatedAt);
              const editing = menuFor === s.id && mode === "rename";
              const deleting = menuFor === s.id && mode === "delete";
              return (
                <div key={s.id} className="srow-wrap">
                  {editing ? (
                    <form className="srow-edit" onSubmit={(e) => { e.preventDefault(); if (draft.trim() && renameSession) void run(() => renameSession(s.id, draft.trim())); }}>
                      <input autoFocus value={draft} maxLength={100} onChange={(e) => setDraft(e.target.value)} aria-label={t("Neuer Titel")} onKeyDown={(e) => { if (e.key === "Escape") closeAction(); }} />
                      <button type="submit" className="btn btn-s btn-p" disabled={busy || !draft.trim()}>{t("Speichern")}</button>
                      <button type="button" className="btn btn-s btn-g" onClick={closeAction}>{t("Abbrechen")}</button>
                      {actionError && <p className="error small" role="alert" style={{ flexBasis: "100%" }}>{actionError}</p>}
                    </form>
                  ) : (
                    <Link to={agentPath(agent, "chat", s.id)} className={`srow${on ? " on" : ""}${state ? " live" : ""}`} aria-current={on ? "page" : undefined}>
                      <span className="t">
                        {state && <i className={`dot ${state === "wait" ? "dot-wait" : "dot-run"}`} />}
                        {s.pinned && <Icon name="pin" size={12} className="t3" />}
                        {isAuto(s) && <Icon name="clock" size={12} className="t3" />}
                        <span className="trunc">{s.title}</span>
                      </span>
                      <span className="m">
                        {s.messageCount != null && <span>{t("{messageCount} Nachr.", { messageCount: s.messageCount })}</span>}
                        {at !== undefined && <span>{g === "older" ? fmtDay(at) : fmtTime(at)}</span>}
                        {state && <span className="crimt">{state === "wait" ? t("wartet") : "läuft"}</span>}
                      </span>
                    </Link>
                  )}
                  {!editing && renameSession && (
                    <button type="button" className="srow-act btn btn-i btn-g btn-s" aria-label={t("Aktionen für {title}", { title: s.title })} aria-expanded={menuFor === s.id} onClick={() => { if (menuFor === s.id) closeAction(); else { setMenuFor(s.id); setMode(null); setActionError(null); } }}>
                      <Icon name="dots" size={14} />
                    </button>
                  )}
                  {menuFor === s.id && !editing && (
                    <div className="srow-menu" role="menu" aria-label={t("Aktionen für {title}", { title: s.title })}>
                      {!deleting && (
                        <>
                          <button type="button" role="menuitem" onClick={() => { setDraft(s.title); setMode("rename"); }}><Icon name="edit" size={14} />{t("Umbenennen")}</button>
                          <button type="button" role="menuitem" disabled={busy} onClick={() => void run(async () => { const r = await api.fork(agent, s.id); refreshSessions(); navigate(agentPath(agent, "chat", r.session_id)); })}><Icon name="fork" size={14} />{t("Als Kopie abzweigen")}</button>
                          <button type="button" role="menuitem" className="danger" onClick={() => setMode("delete")}><Icon name="x" size={14} />{t("Löschen…")}</button>
                        </>
                      )}
                      {deleting && (
                        <div className="srow-confirm">
                          <p className="small">{t("„{title}“ wird endgültig gelöscht. Das lässt sich nicht rückgängig machen.", { title: s.title })}</p>
                          <div className="row" style={{ gap: 6 }}>
                            <button type="button" className="btn btn-s btn-danger" disabled={busy} onClick={() => deleteSession && void run(async () => { await deleteSession(s.id); if (on) navigate(agentPath(agent)); })}>{t("Endgültig löschen")}</button>
                            <button type="button" className="btn btn-s btn-g" onClick={closeAction}>{t("Abbrechen")}</button>
                          </div>
                        </div>
                      )}
                      {actionError && <p className="error small" role="alert">{actionError}</p>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>

      {hasMoreSessions && !query && (
        <button type="button" className="btn btn-s btn-g sess-more" disabled={loadingMoreSessions} onClick={loadMoreSessions}>
          {loadingMoreSessions ? t("Lade…") : t("Ältere laden ({length} geladen)", { length: sessions.length })}
        </button>
      )}
      <div className="sess-foot">
        <Icon name="globe" size={14} className="t3" />
        <span className="mono t3 trunc" style={{ fontSize: 10.5 }}>{location.host}/h/{agent.host}/{agent.runtime}/{agent.agent}</span>
      </div>
    </aside>
  );
}
