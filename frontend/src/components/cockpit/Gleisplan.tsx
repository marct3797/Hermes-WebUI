import type { Need, LiveRun } from "../../attention";
import { agentKey } from "../../router";
import type { AgentRef, SigilConfig } from "../../types";
import { Sigil } from "../Sigil";
import { sigilFor } from "../../ui";
import type { LastChat } from "../../useAgentSessions";
import { t } from "../../i18n";

const HOUR = 3_600_000;
const SPAN = 24 * HOUR;

type Row = { ref: AgentRef; label: string };
type Props = { rows: Row[]; chats: Map<string, LastChat>; live: LiveRun[]; needs: Need[]; sigils: Record<string, SigilConfig>; now: number };

/** Verlauf der letzten 24 Stunden, eine Zeile je Agent. Nur echte Daten: Striche sind Sessions (Zeitpunkt der letzten Aktivität),
 * Balken sind Runs, die diese WebUI gerade verfolgt. Wartende Runs sind schraffiert, Fehler gelb. */
export function Gleisplan({ rows, chats, live, needs, sigils, now }: Props) {
  const start = now - SPAN;
  const pct = (ms: number) => `${(Math.min(Math.max(ms - start, 0), SPAN) / SPAN * 100).toFixed(2)}%`;
  const first = Math.ceil(start / (3 * HOUR)) * 3 * HOUR;
  const ticks: number[] = [];
  for (let x = first; x <= now; x += 3 * HOUR) ticks.push(x);
  const hh = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }).slice(0, 2);
  return (
    <div className="gp" role="img" aria-label={t("Verlauf")}>
      <div className="gp-axis"><span />
        <div className="gp-tk">{ticks.map((x) => <span key={x} style={{ left: pct(x) }}>{hh(x)}</span>)}</div>
      </div>
      {rows.map(({ ref, label }) => {
        const key = agentKey(ref);
        const times = (chats.get(key)?.times ?? []).filter((x) => x >= start && x <= now);
        const runs = live.filter((r) => agentKey(r.agent) === key);
        const waits = needs.filter((n) => agentKey(n.agent) === key);
        return (
          <div key={key} className="gp-lane">
            <div className="gp-name"><Sigil name={label} config={sigilFor(sigils, ref)} size="xs" /><span className="trunc">{label}</span></div>
            <div className="gp-track">
              {ticks.map((x) => <i key={x} className="gp-grid" style={{ left: pct(x) }} />)}
              {times.map((x, i) => <i key={i} className="gp-tick" style={{ left: pct(x) }} title={new Date(x).toLocaleString()} />)}
              {runs.map((r) => {
                const from = r.startedAt ?? now - 60_000;
                return <i key={r.convKey} className={`gp-run${r.waiting ? " wait" : ""}`} style={{ left: pct(from), width: `max(6px, calc(${pct(now)} - ${pct(from)}))` }} title={r.topic ?? r.activity} />;
              })}
              {waits.map((n) => (
                <i key={n.id} className={`gp-run ${n.kind === "failed" || n.kind === "lost" ? "err" : "wait"}`}
                  style={{ left: pct(n.since), width: `max(6px, calc(${pct(now)} - ${pct(n.since)}))` }} title={n.topic} />
              ))}
            </div>
          </div>
        );
      })}
      <div className="gp-now" style={{ right: 0 }}><span>{t("jetzt")}</span></div>
      <div className="gp-leg">
        <span><i className="k tick" />{t("Sitzung")}</span><span><i className="k run" />{t("Läuft")}</span>
        <span><i className="k wait" />{t("wartet auf dich")}</span><span><i className="k err" />{t("Fehler")}</span>
      </div>
    </div>
  );
}
