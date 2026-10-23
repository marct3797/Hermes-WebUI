import { useMemo, useState } from "react";
import { AgentCard } from "../components/cockpit/AgentCard";
import { UsagePanel } from "../components/cockpit/UsagePanel";
import { NeedsPanel, RunningPanel, SystemPanel } from "../components/cockpit/Panels";
import { Icon } from "../components/Icon";
import { StatusDot } from "../components/Status";
import { fmtDate, fmtTime } from "../format";
import { useHosts } from "../hosts";
import { agentKey } from "../router";
import { useActivity, useRunSnapshot } from "../runs";
import { sigilFor, useUi } from "../ui";
import { useAgentSessions } from "../useAgentSessions";
import { useUsage } from "../useUsage";
import { useNow } from "../useNow";

type Filter = "all" | "run" | "need" | `host:${string}`;

/** Startseite: alle Agents mit Zustand und letztem Chat, rechts Freigaben, laufende Runs und der Zustand der Hosts. */
export function CockpitPage() {
  const { hosts, configError, error } = useHosts();
  const { sigils } = useUi();
  const { needs, live, byAgent } = useActivity();
  const { log } = useRunSnapshot();
  const now = useNow(true);
  const [filter, setFilter] = useState<Filter>("all");

  const all = useMemo(() => (hosts ?? []).flatMap((h) => h.runtimes.flatMap((r) => r.agents.map((a) => ({ h, r, a, ref: { host: h.id, runtime: r.id, agent: a.id } })))), [hosts]);
  const onlineRefs = useMemo(() => all.filter((x) => x.r.status === "online").map((x) => x.ref), [all]);
  const chats = useAgentSessions(onlineRefs);
  const usage = useUsage(onlineRefs);

  if (!hosts) {
    return <main className="page">{error ? <p className="banner" role="alert"><Icon name="alert" />Hosts nicht ladbar: {error}</p> : <p className="muted">Lade…</p>}</main>;
  }

  const act = (key: string) => byAgent.get(key);
  const counts = {
    all: all.length,
    run: all.filter((x) => act(agentKey(x.ref))?.running).length,
    need: all.filter((x) => act(agentKey(x.ref))?.waiting).length,
  };
  const shown = all.filter((x) => {
    const a = act(agentKey(x.ref));
    return filter === "all" || (filter === "run" ? !!a?.running : filter === "need" ? !!a?.waiting : filter === `host:${x.h.id}`);
  });
  const onlineAgents = onlineRefs.length;
  const approvals = needs.filter((n) => n.kind === "approval").length;
  const questions = needs.filter((n) => n.kind === "clarify").length;
  const problems = needs.length - approvals - questions;
  const hostsOnline = hosts.filter((h) => h.status === "online").length;
  const offline = hosts.filter((h) => h.status !== "online").map((h) => h.label);
  const errorOf = (key: string) => {
    const n = needs.find((x) => (x.kind === "failed" || x.kind === "lost") && agentKey(x.agent) === key);
    return n && "error" in n ? n.error : undefined;
  };

  const chips: Array<{ id: Filter; label: string; n: number }> = [
    { id: "all", label: "Alle", n: counts.all },
    ...(hosts.length > 1 ? hosts.map((h) => ({ id: `host:${h.id}` as Filter, label: h.label, n: all.filter((x) => x.h.id === h.id).length })) : []),
    { id: "run", label: "Läuft", n: counts.run },
    { id: "need", label: "Braucht dich", n: counts.need },
  ];

  return (
    <main className="page">
      <header className="ph">
        <div className="col" style={{ gap: 6 }}>
          <span className="lbl">Profil-Cockpit</span>
          <h1>Alle Agents</h1>
        </div>
        <span className="ph-sub" style={{ marginBottom: 5 }}>
          {fmtDate(now)} · {fmtTime(now)} · {hosts.length} {hosts.length === 1 ? "Host" : "Hosts"} · {all.length} Agents
        </span>
        <div className="row filters" role="group" aria-label="Filter">
          {chips.map((c) => (
            <button key={c.id} type="button" className={`chip${filter === c.id ? " on" : ""}`} aria-pressed={filter === c.id} onClick={() => setFilter(c.id)}>
              {c.label}<span className="n">{c.n}</span>
            </button>
          ))}
        </div>
      </header>

      {error && <p className="banner" role="alert"><Icon name="alert" />Hosts nicht ladbar: {error}</p>}

      <div className="kpis" role="group" aria-label="Kennzahlen">
        <div className="kpi">
          <span className="lbl">Aktiv</span>
          <span className="v">{counts.run}<small>/ {onlineAgents}</small></span>
          <span className="kpi-note">{live.length} {live.length === 1 ? "Run läuft" : "Runs laufen"} · {needs.filter((n) => n.kind === "approval" || n.kind === "clarify").length} warten</span>
        </div>
        <div className={`kpi${needs.length ? " hot" : ""}`}>
          <span className={`lbl${needs.length ? " crimt" : ""}`}>Braucht dich</span>
          <span className="v">{needs.length}</span>
          <span className="kpi-note">
            {needs.length === 0 ? "nichts offen" : [approvals && `${approvals} ${approvals === 1 ? "Freigabe" : "Freigaben"}`, questions && `${questions} ${questions === 1 ? "Rückfrage" : "Rückfragen"}`, problems && `${problems} Fehler`].filter(Boolean).join(" · ")}
          </span>
        </div>
        <div className="kpi">
          <span className="lbl">Hosts</span>
          <span className="v">{hostsOnline}<small>/ {hosts.length}</small></span>
          <span className="kpi-note">{offline.length ? `${offline.join(", ")} nicht erreichbar` : "alle erreichbar"}</span>
        </div>
        <div className="kpi">
          <span className="lbl">Agents</span>
          <span className="v">{all.length}</span>
          <span className="kpi-note">{onlineAgents} erreichbar</span>
        </div>
      </div>

      {onlineRefs.length > 0 && <UsagePanel stats={usage.stats} byAgent={usage.byAgent} loading={usage.loading} now={now} />}

      <div className="two">
        <div className="l">
          {shown.length === 0 && <p className="muted">{all.length === 0 ? "Keine Agents konfiguriert. Hosts und Agents stehen in der hosts.json des BFF." : "Kein Agent passt zu diesem Filter."}</p>}
          {hosts.map((h) => {
            const cards = shown.filter((x) => x.h.id === h.id);
            if (cards.length === 0) return null;
            return (
              <section key={h.id} className="col" style={{ gap: 12 }} aria-label={h.label}>
                <div className="hostline">
                  <StatusDot status={h.status} />
                  <h2 className="lbl t2">{h.label}</h2>
                  <span className="meta">{[...h.runtimes.map((r) => `${r.id}${r.version ? ` ${r.version}` : ""}`), h.address].filter(Boolean).join(" · ")}</span>
                </div>
                <div className="pgrid">
                  {cards.map(({ r, a, ref }) => {
                    const key = agentKey(ref);
                    return (
                      <AgentCard key={key} agent={ref} label={a.label} runtime={r} hostStatus={h.status} sigil={sigilFor(sigils, ref)}
                        act={act(key)} chat={chats.get(key)} now={now} error={errorOf(key)} />
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
        <div className="r aside">
          <NeedsPanel needs={needs} log={log} sigils={sigils} now={now} />
          <RunningPanel live={live} sigils={sigils} now={now} />
          <SystemPanel hosts={hosts} configError={configError} />
        </div>
      </div>
    </main>
  );
}
