import { useCallback, useState } from "react";
import { api } from "../api";
import { DiagChecks } from "../components/DiagChecks";
import { Icon } from "../components/Icon";
import { PageHead } from "../components/PageHead";
import { StatusDot } from "../components/Status";
import { useHosts } from "../hosts";
import { agentKey } from "../router";
import type { AgentRef, DiagReport, Security } from "../types";
import { useAsync } from "../useAsync";

type Entry = { busy: boolean; report?: DiagReport; error?: string };

/** Anmeldeschutz: ehrlich sagen, ob die Frische der Anmeldung belegt ist (Warnung nur, wenn sie es nicht ist). */
function StepUpNote({ step }: { step: Security["step_up"] }) {
  const min = Math.round(step.window_s / 60);
  const text: Record<Security["step_up"]["proof"], string> = {
    off: "Anmeldeschutz aus: Terminal, Schlüssel und Installationen verlangen keine frische Anmeldung (HERMES_WEBUI_STEP_UP=off). Sinnvoll nur, wenn die WebUI ausschließlich im privaten Netz erreichbar ist.",
    auth_time: `Anmeldeschutz an: Riskante Aktionen verlangen eine Anmeldung, die höchstens ${min} Minuten alt ist. Der Anbieter belegt die Anmeldezeit (auth_time).`,
    prompt_login_only: `Anmeldeschutz an, aber die Frische nicht belegbar: Der Anbieter liefert kein auth_time. Die WebUI verlässt sich darauf, dass er die erneute Anmeldung erzwingt (prompt=login). Einmal prüfen: mit einer älteren Sitzung ein Terminal öffnen, die Anmeldung muss verlangt werden. Gültig sind höchstens ${min} Minuten.`,
    unknown: "Anmeldeschutz an, Frische nicht prüfbar: Der Anbieter nennt weder auth_time noch seine unterstützten Angaben. Riskante Aktionen bleiben gesperrt, bis er auth_time liefert.",
    unavailable: "Anmeldeschutz an; die Angaben des Anbieters sind gerade nicht lesbar.",
  };
  const warn = !["off", "auth_time"].includes(step.proof);
  return <p role="note" aria-label="Anmeldeschutz" className={`small${warn ? " banner" : " muted"}`} style={{ maxWidth: 720 }}>{warn && <Icon name="alert" />}{text[step.proof]}</p>;
}

/**
 * System: der Diagnose-Ring. Prüft jeden Agent gegen das, was die WebUI von ihm erwartet (lesend), und kann einen
 * kurzen echten Lauf starten. So sieht man Abweichungen der Hermes-API, bevor sie im Chat auffallen.
 */
export function SystemPage() {
  const { hosts, error: hostsError } = useHosts();
  const [results, setResults] = useState<Record<string, Entry>>({});
  const security = useAsync(() => api.security(), []); // fehlt die Route (älteres BFF), bleibt die Karte weg

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

  // Höchstens 4 Agents gleichzeitig: schnell genug, ohne Hermes und den Browser (6 Verbindungen je Host) zu überfahren. Jedes Ergebnis erscheint, sobald es da ist.
  const checkAll = () => {
    const queue = agents.filter((a) => a.online);
    const worker = async () => { for (let a = queue.shift(); a; a = queue.shift()) await run(a.ref, false); };
    const workers = Math.min(4, queue.length); // vorher festhalten: die Warteschlange schrumpft schon beim Start
    for (let i = 0; i < workers; i++) void worker();
  };
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
      {security.data && <StepUpNote step={security.data.step_up} />}
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
