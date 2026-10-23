import { useMemo, useState } from "react";
import { fmtDay } from "../../format";
import { aggregate, fmtTokens, fmtUsd, tokensOf, type SessionStat } from "../../stats";
import { USAGE_PAGE, type AgentUsage } from "../../useUsage";

const RANGES = [7, 14, 30] as const;

type Props = { stats: SessionStat[]; byAgent: Map<string, AgentUsage>; loading: boolean; now: number };

/**
 * Auswertung aus den Sessions, die Hermes liefert: Tokens, Tool-Aufrufe, Cache-Anteil, Modelle. Kosten erscheinen nur,
 * wenn Hermes welche meldet (viele Anbieter melden 0). Je Agent zählen die letzten 100 Sessions; reicht das nicht
 * bis an den Anfang des Zeitraums, steht das dabei.
 */
export function UsagePanel({ stats, byAgent, loading, now }: Props) {
  const [range, setRange] = useState<(typeof RANGES)[number]>(14);
  const minute = Math.floor(now / 60_000); // die Uhr tickt je Sekunde, die Auswertung rechnet nur je Minute neu
  const u = useMemo(() => aggregate(stats, range, minute * 60_000), [stats, range, minute]);
  const first = u.days[0]?.day ?? 0;
  const cut = [...byAgent.values()].some((d) => d.rows >= USAGE_PAGE && d.stats.length > 0 && Math.min(...d.stats.map((s) => s.startedAt)) > first);
  const peak = Math.max(1, ...u.days.map((d) => d.sessions));
  const topTokens = Math.max(1, ...u.byAgent.map(tokensOf));

  return (
    <section className="card usage" aria-label="Auswertung">
      <header className="card-h">
        <h2>Auswertung</h2>
        <div className="row" role="group" aria-label="Zeitraum" style={{ gap: 6, marginLeft: "auto" }}>
          {RANGES.map((r) => (
            <button key={r} type="button" className={`chip chip-s${range === r ? " on" : ""}`} aria-pressed={range === r} onClick={() => setRange(r)}>{r} Tage</button>
          ))}
        </div>
      </header>

      {loading && stats.length === 0 ? <p className="panel-empty">Lade…</p> : (
        <>
          <div className="kpis usage-kpis" role="group" aria-label={`Kennzahlen, letzte ${range} Tage`}>
            <div className="kpi"><span className="lbl">Sessions</span><span className="v">{u.totals.sessions}</span><span className="kpi-note">{u.totals.messages} Nachrichten</span></div>
            <div className="kpi"><span className="lbl">Tokens</span><span className="v">{fmtTokens(tokensOf(u.totals))}</span><span className="kpi-note">{fmtTokens(u.totals.input)} ein · {fmtTokens(u.totals.output)} aus</span></div>
            <div className="kpi"><span className="lbl">Tool-Aufrufe</span><span className="v">{fmtTokens(u.totals.toolCalls)}</span><span className="kpi-note">{u.totals.sessions ? `${(u.totals.toolCalls / u.totals.sessions).toLocaleString("de-DE", { maximumFractionDigits: 1 })} je Session` : "–"}</span></div>
            <div className="kpi"><span className="lbl">Cache-Anteil</span><span className="v">{u.cacheShare === undefined ? "–" : `${Math.round(u.cacheShare * 100)} %`}</span><span className="kpi-note">{u.cacheShare === undefined ? "nichts aus dem Cache gelesen" : `${fmtTokens(u.totals.cacheRead)} Tokens gelesen`}</span></div>
            {u.totals.cost > 0 && <div className="kpi"><span className="lbl">Kosten</span><span className="v">{fmtUsd(u.totals.cost)}</span><span className="kpi-note">laut Hermes</span></div>}
          </div>

          <figure className="usage-chart" aria-label={`Sessions pro Tag, letzte ${range} Tage`}>
            <div className="bars2" role="img" aria-label={u.days.map((d) => `${fmtDay(d.day)}: ${d.sessions}`).join(", ")}>
              {u.days.map((d) => (
                <span key={d.day} className="bar2" title={`${fmtDay(d.day)} · ${d.sessions} Sessions · ${fmtTokens(d.tokens)} Tokens`}>
                  <i style={{ height: `${Math.max(d.sessions ? 6 : 1, (d.sessions / peak) * 100)}%` }} className={d.sessions ? "" : "zero"} />
                </span>
              ))}
            </div>
            <figcaption className="mono t3"><span>{fmtDay(first)}</span><span>Sessions pro Tag, Spitze {peak}</span><span>heute</span></figcaption>
          </figure>

          <div className="usage-tables">
            <table className="utbl" aria-label="Nach Agent">
              <thead><tr><th scope="col">Agent</th><th scope="col">Sessions</th><th scope="col">Tokens</th><th scope="col">Tools</th></tr></thead>
              <tbody>
                {u.byAgent.length === 0 && <tr><td colSpan={4} className="muted">Keine Sessions in diesem Zeitraum.</td></tr>}
                {u.byAgent.map((a) => (
                  <tr key={a.agent}>
                    <th scope="row"><span className="trunc">{a.agent}</span><span className="ubar" style={{ width: `${(tokensOf(a) / topTokens) * 100}%` }} aria-hidden /></th>
                    <td>{a.sessions}</td><td>{fmtTokens(tokensOf(a))}</td><td>{fmtTokens(a.toolCalls)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="col" style={{ gap: 14, minWidth: 0 }}>
              <table className="utbl" aria-label="Nach Modell">
                <thead><tr><th scope="col">Modell</th><th scope="col">Sessions</th><th scope="col">Tokens</th></tr></thead>
                <tbody>
                  {u.byModel.slice(0, 6).map((m) => (
                    <tr key={m.model}><th scope="row"><span className="trunc">{m.model}</span></th><td>{m.sessions}</td><td>{fmtTokens(m.tokens)}</td></tr>
                  ))}
                </tbody>
              </table>
              {u.bySource.length > 0 && (
                <p className="small t2 usage-sources">
                  {u.bySource.map((s) => <span key={s.source} className="tag tag-m">{s.source} · {s.sessions}</span>)}
                </p>
              )}
            </div>
          </div>
          {cut && <p className="small muted" style={{ padding: "0 14px 12px" }}>Je Agent liest die Auswertung die letzten {USAGE_PAGE} Sessions. Bei sehr aktiven Agents fehlen deshalb Sessions vom Beginn des Zeitraums.</p>}
        </>
      )}
    </section>
  );
}
