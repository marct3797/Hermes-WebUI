import { useMemo, useState } from "react";
import { api } from "../../api";
import { fmtCount } from "../../format";
import type { MemRow } from "../../types";
import { useAsync } from "../../useAsync";

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const SHOWN = 500; // shortcut: mehr Zeilen auf einmal machen den DOM träge; Filter eingrenzen oder sortieren, bis eine Seitenlogik nötig wird
export type Range = { from: number; to: number; label: string };
export const dayLabel = (ms: number, timeZone?: string) => new Date(ms).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", timeZone });

/** Tabelle der geladenen Erinnerungen. Sortierbar nach Datum und Kontext; ein Klick auf die Zeile wählt wie ein Klick auf den Knoten. */
export function GraphTable({ rows, selectedId, onSelect, range, onClearRange }: { rows: MemRow[]; selectedId?: string; onSelect: (id: string) => void; range?: Range; onClearRange: () => void }) {
  const [sort, setSort] = useState<{ by: "date" | "context"; dir: 1 | -1 }>({ by: "date", dir: -1 });
  const shown = useMemo(() => {
    const inRange = range ? rows.filter((r) => { const t = r.date ? Date.parse(r.date) : NaN; return t >= range.from && t < range.to; }) : rows;
    const key = (r: MemRow) => (sort.by === "date" ? (r.date ? Date.parse(r.date) : -Infinity) : (r.context ?? "").toLowerCase());
    return inRange.slice().sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0) * sort.dir);
  }, [rows, range, sort]);
  const head = (by: "date" | "context", text: string) => (
    <th aria-sort={sort.by === by ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>
      <button type="button" className="linkish" onClick={() => setSort((s) => ({ by, dir: s.by === by ? (s.dir === 1 ? -1 : 1) : by === "date" ? -1 : 1 }))}>{text}{sort.by === by ? (sort.dir === 1 ? " ▲" : " ▼") : ""}</button>
    </th>
  );
  return (
    <div className="graph-table">
      {range && <p className="row small" style={{ gap: 8 }}><span>Zeitraum: {range.label}</span><button type="button" className="btn btn-s btn-g" onClick={onClearRange}>Zeitraum aufheben</button></p>}
      {shown.length === 0 ? <p className="panel-empty">Keine Erinnerungen für diesen Filter</p> : (
        <div className="graph-table-scroll">
          <table className="tbl">
            <thead><tr><th>Text</th>{head("context", "Kontext")}<th>Entitäten</th>{head("date", "Datum")}</tr></thead>
            <tbody>
              {shown.slice(0, SHOWN).map((r) => (
                <tr key={r.id} className={r.id === selectedId ? "on" : undefined} aria-selected={r.id === selectedId}>
                  <td><button type="button" className="mem-open" onClick={() => onSelect(r.id)}>{cut(r.text ?? r.id, 220)}</button></td>
                  <td className="small">{r.context ?? "—"}</td>
                  <td className="small">{r.entities.length ? cut(r.entities.join(", "), 80) : "—"}</td>
                  <td className="small mono">{r.date ? new Date(r.date).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" }) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {shown.length > SHOWN && <p className="muted small">Die ersten {SHOWN} von {fmtCount(shown.length)} Zeilen. Zeitraum oder Filter eingrenzen.</p>}
    </div>
  );
}

const DAY = 86_400_000;
type Bar = { from: number; to: number; count: number };

/** Tage zu Wochen (Montag), wenn es mehr als 60 Balken wären. */
export function bucket(points: Array<{ t: number; count: number }>): { bars: Bar[]; unit: "Tag" | "Woche" } {
  const weekly = points.length > 60;
  const out = new Map<number, Bar>();
  for (const p of points) {
    const day = Math.floor(p.t / DAY) * DAY;
    const from = weekly ? day - ((new Date(day).getUTCDay() + 6) % 7) * DAY : day;
    const b = out.get(from) ?? { from, to: from + (weekly ? 7 : 1) * DAY, count: 0 };
    b.count += p.count; out.set(from, b);
  }
  return { bars: [...out.values()].sort((a, b) => a.from - b.from), unit: weekly ? "Woche" : "Tag" };
}

/** Balken je Tag/Woche. Quelle: Hindsight-Zeitreihe der ganzen Bank; ohne sie die geladenen Erinnerungen. Ein Klick wählt den Zeitraum für die Tabelle. */
export function GraphTimeline({ provider, type, rows, range, onRange }: { provider: string; type: string; rows: MemRow[]; range?: Range; onRange: (r: Range | undefined) => void }) {
  const [period, setPeriod] = useState("90d");
  const series = useAsync(() => api.memoryTimeseries(provider, { type, period }).catch(() => undefined), [provider, type, period]);
  const pts = series.data?.points ?? [];
  const fromApi = pts.length > 0;
  const { bars, unit } = useMemo(() => bucket(fromApi ? pts.map((p) => ({ t: Date.parse(p.t), count: p.count })) : rows.flatMap((r) => (r.date ? [{ t: Date.parse(r.date), count: 1 }] : []))), [fromApi, pts, rows]);
  const max = Math.max(1, ...bars.map((b) => b.count));
  return (
    <section className="graph-timeline" aria-label="Zeitleiste">
      <div className="row small" style={{ gap: 8 }}>
        <label className="row" style={{ gap: 6 }}><span className="lbl">Zeitraum</span>
          <select className="field field-line" value={period} onChange={(e) => { setPeriod(e.target.value); onRange(undefined); }} aria-label="Zeitraum der Zeitleiste" disabled={!fromApi && !series.loading}>
            {["30d", "90d", "365d"].map((p) => <option key={p} value={p}>{p.replace("d", " Tage")}</option>)}
          </select></label>
        <span className="muted">{series.loading ? "Lade…" : fromApi ? `Alle Erinnerungen dieser Art, je ${unit}` : `Nur die geladenen Erinnerungen, je ${unit} (Zeitreihe nicht verfügbar)`}</span>
      </div>
      {bars.length === 0 ? <p className="panel-empty">Keine Erinnerungen mit Datum</p> : (
        <div className="graph-bars" role="group" aria-label="Erinnerungen pro Zeitraum">
          {bars.map((b) => {
            const label = unit === "Woche" ? `Woche ab ${dayLabel(b.from, "UTC")}` : dayLabel(b.from, "UTC"); // Balken sind UTC-Tage
            const on = range?.from === b.from;
            return <button key={b.from} type="button" className={`graph-bar${on ? " on" : ""}`} aria-pressed={on} aria-label={`${label}: ${fmtCount(b.count)} Erinnerungen`} title={`${label}: ${fmtCount(b.count)}`}
              style={{ height: `${Math.max(4, (b.count / max) * 100)}%` }} onClick={() => onRange(on ? undefined : { from: b.from, to: b.to, label })} />;
          })}
        </div>
      )}
    </section>
  );
}
