import { useCallback, useState } from "react";
import { api } from "../api";
import { DiagChecks } from "../components/DiagChecks";
import { Icon } from "../components/Icon";
import { PageHead } from "../components/PageHead";
import { StatusDot } from "../components/Status";
import { useHosts } from "../hosts";
import { agentKey } from "../router";
import type { AgentRef, DiagReport } from "../types";

type Entry = { busy: boolean; report?: DiagReport; error?: string };

/**
 * System: der Diagnose-Ring. Prüft jeden Agent gegen das, was die WebUI von ihm erwartet (lesend), und kann einen
 * kurzen echten Lauf starten. So sieht man Abweichungen der Hermes-API, bevor sie im Chat auffallen.
 */
export function SystemPage() {
  const { hosts, error: hostsError } = useHosts();
  const [results, setResults] = useState<Record<string, Entry>>({});

  const agents = (hosts ?? []).flatMap((h) =>
    h.runtimes.flatMap((r) => r.agents.map((a) => ({ ref: { host: h.id, runtime: r.id, agent: a.id } as AgentRef, label: a.label, host: h.label, runtimeLabel: r.label, online: r.status === "online" }))),
  );

  const run = useCallback(async (ref: AgentRef, withRun: boolean) => {
    const key = agentKey(ref);
    setResults((r) => ({ ...r, [key]: { ...r[key], busy: true, error: undefined } }));
    try {
      const report = await (withRun ? api.diagnoseRun(ref) : api.diagnose(ref));
      setResults((r) => ({ ...r, [key]: { busy: false, report: withRun ? { ...report, checks: [...(r[key]?.report?.checks.filter((c) => !c.id.startsWith("run.")) ?? []), ...report.checks] } : report } }));
    } catch (e) {
      setResults((r) => ({ ...r, [key]: { ...r[key], busy: false, error: (e as Error).message } }));
    }
  }, []);

  const checkAll = () => { for (const a of agents) if (a.online) void run(a.ref, false); };
  const all = Object.values(results).flatMap((r) => (r.report ? [r.report.status] : []));
  const sub = all.length ? `${all.filter((s) => s === "ok").length} in Ordnung · ${all.filter((s) => s === "warn").length} Abweichungen · ${all.filter((s) => s === "fail").length} Fehler` : "noch nicht geprüft";

  return (
    <main className="page">
      <PageHead title="System" sub={sub}>
        <button type="button" className="btn btn-s" onClick={checkAll} disabled={agents.every((a) => !a.online)}><Icon name="refresh" size={14} />Alle prüfen</button>
      </PageHead>
      <p className="muted small" style={{ maxWidth: 720 }}>
        Die Prüfung liest nur. Der Lauftest schickt einem Agent einen kurzen Auftrag („Antworte nur mit dem Wort OK“) und legt dafür eine Session an, die in dessen Liste bleibt.
      </p>
      {hostsError && <p className="banner" role="alert"><Icon name="alert" />Hosts nicht ladbar: {hostsError}</p>}
      {!hosts && !hostsError && <p className="muted">Lade…</p>}
      <div className="diag-list">
        {agents.map((a) => {
          const key = agentKey(a.ref);
          const entry = results[key];
          return (
            <section key={key} className={`card diag-card${entry?.report ? ` diag-${entry.report.status}` : ""}`} aria-label={`${a.host} ${a.label}`}>
              <header className="card-h">
                <StatusDot status={a.online ? "online" : "unreachable"} />
                <h2>{a.label}</h2>
                <span className="muted small">{a.host} · {a.runtimeLabel}</span>
                <span className="row" style={{ marginLeft: "auto", gap: 6 }}>
                  <button type="button" className="btn btn-s" disabled={!a.online || entry?.busy} onClick={() => void run(a.ref, false)}>
                    <Icon name="refresh" size={14} />{entry?.busy ? "Prüfe…" : "Prüfen"}
                  </button>
                  <button type="button" className="btn btn-s" disabled={!a.online || entry?.busy} onClick={() => void run(a.ref, true)} title="Startet einen kurzen Lauf und legt eine Session an">
                    <Icon name="play" size={14} />Lauftest
                  </button>
                </span>
              </header>
              {entry?.error && <p className="error small" role="alert" style={{ padding: "0 14px" }}>{entry.error}</p>}
              {!a.online && !entry && <p className="muted small" style={{ padding: "0 14px 10px" }}>Runtime nicht erreichbar.</p>}
              {entry?.report && <DiagChecks checks={entry.report.checks} />}
            </section>
          );
        })}
      </div>
    </main>
  );
}
