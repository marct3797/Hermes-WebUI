import { useEffect, useMemo, useRef, useState } from "react";
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

type Props = { agent: AgentRef; label: string; runtimeLabel: string; sessionId?: string };

const AUTOMATION = /^(cron|webhook|automation|schedule)/i;
type Filter = "chats" | "automation";

/** Sessions des Agents nach Tag gruppiert, mit Suche, Filter und Tastenkürzeln (N = neuer Chat, / = Suche). */
export function SessionColumn({ agent, label, runtimeLabel, sessionId }: Props) {
  const { sessions, sessionsLoading } = useShell();
  const snap = useRunSnapshot();
  const { byAgent } = useActivity();
  const { sigils } = useUi();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("chats");
  const [pinnedOnly, setPinnedOnly] = useState(false);
  const search = useRef<HTMLInputElement>(null);

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
        <div className="row" style={{ gap: 12 }}>
          <Sigil name={label} config={sigilFor(sigils, agent)} size="m" state={agentState} />
          <div className="col grow" style={{ gap: 2, minWidth: 0 }}>
            <span className="sess-name trunc">{label}</span>
            <span className="mono t3 trunc" style={{ fontSize: 10.5 }}>{agent.host} · {runtimeLabel.toLowerCase()}</span>
          </div>
          <Link to={agentPath(agent, "profil")} className="btn btn-s btn-i btn-g" aria-label={`Profil von ${label} bearbeiten`} title="Profil bearbeiten"><Icon name="edit" size={14} /></Link>
        </div>
        <Link to={agentPath(agent)} className="btn btn-p" style={{ width: "100%" }}><Icon name="plus" size={14} />Neuer Chat<span className="kbd">N</span></Link>
        <label className="search">
          <Icon name="search" size={14} />
          <input ref={search} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Sessions durchsuchen" aria-label="Sessions durchsuchen" />
          <span className="kbd">/</span>
        </label>
        <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
          <button type="button" className={`chip chip-s${filter === "chats" ? " on" : ""}`} aria-pressed={filter === "chats"} onClick={() => setFilter("chats")}>Chats<span className="n">{counts.chats}</span></button>
          {counts.automation > 0 && (
            <button type="button" className={`chip chip-s${filter === "automation" ? " on" : ""}`} aria-pressed={filter === "automation"} onClick={() => setFilter("automation")}>Automation<span className="n">{counts.automation}</span></button>
          )}
          {counts.pinned > 0 && (
            <button type="button" className={`chip chip-s${pinnedOnly ? " on" : ""}`} aria-pressed={pinnedOnly} aria-label="Nur angepinnte" onClick={() => setPinnedOnly(!pinnedOnly)}><Icon name="pin" size={12} />{counts.pinned}</button>
          )}
        </div>
      </div>

      <div className="sess-list">
        {sessionsLoading && <p className="muted small" style={{ padding: "12px 16px" }}>Lade…</p>}
        {!sessionsLoading && empty && <p className="muted small" style={{ padding: "12px 16px" }}>{query ? "Keine Treffer." : "Noch keine Sessions."}</p>}
        {(["today", "yesterday", "older"] as const).map((g) => groups[g].length > 0 && (
          <div key={g} role="group" aria-label={DAY_LABEL[g]}>
            <div className="sgrp lbl">{DAY_LABEL[g]}</div>
            {groups[g].map((s) => {
              const on = s.id === sessionId;
              const state = stateOf(s.id);
              const at = toMs(s.updatedAt);
              return (
                <Link key={s.id} to={agentPath(agent, "chat", s.id)} className={`srow${on ? " on" : ""}${state ? " live" : ""}`} aria-current={on ? "page" : undefined}>
                  <span className="t">
                    {state && <i className={`dot ${state === "wait" ? "dot-wait" : "dot-run"}`} />}
                    {s.pinned && <Icon name="pin" size={12} className="t3" />}
                    {isAuto(s) && <Icon name="clock" size={12} className="t3" />}
                    <span className="trunc">{s.title}</span>
                  </span>
                  <span className="m">
                    {s.messageCount != null && <span>{s.messageCount} Nachr.</span>}
                    {at !== undefined && <span>{g === "older" ? fmtDay(at) : fmtTime(at)}</span>}
                    {state && <span className="crimt">{state === "wait" ? "wartet" : "läuft"}</span>}
                  </span>
                </Link>
              );
            })}
          </div>
        ))}
      </div>

      <div className="sess-foot">
        <Icon name="globe" size={14} className="t3" />
        <span className="mono t3 trunc" style={{ fontSize: 10.5 }}>{location.host}/h/{agent.host}/{agent.runtime}/{agent.agent}</span>
      </div>
    </aside>
  );
}
