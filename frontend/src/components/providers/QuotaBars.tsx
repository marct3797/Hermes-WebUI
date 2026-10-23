import { useState } from "react";
import { dec } from "../../format";
import type { Quota, QuotaProvider, QuotaWindow } from "../../types";
import { Icon } from "../Icon";

export const PLUGIN_CMD = "hermes plugins install ai-usage-tracker --enable";

const WINDOW_DE: Record<string, string> = {
  "Current session": "Aktuelle Sitzung", "Current week": "Aktuelle Woche", Session: "Sitzung", Weekly: "Woche", Monthly: "Monat", "Rolling (5h)": "Rollierend (5 Std)",
  Chat: "Chat", Completions: "Vervollständigungen",
};
const BADGE: Record<string, [text: string, cls: string]> = { exhausted: ["Erschöpft", "q-bad"], low: ["Knapp", "q-mid"], auth_failed: ["Zugang prüfen", "q-bad"], unavailable: ["Nicht abfragbar", ""] };

/** „in 1 Std 35 Min“, „in 4 Tagen 3 Std“; unter einer Minute „in weniger als 1 Min“. */
export function fmtIn(s: number): string {
  const min = Math.floor(s / 60);
  if (min < 1) return "in weniger als 1 Min";
  if (min < 60) return `in ${min} Min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `in ${h} Std${min % 60 ? ` ${min % 60} Min` : ""}`;
  const d = Math.floor(h / 24);
  return `in ${d} ${d === 1 ? "Tag" : "Tagen"}${h % 24 ? ` ${h % 24} Std` : ""}`;
}

const pct = (n: number) => `${Number.isInteger(n) ? n : dec(n)} %`;
const level = (rest: number | null) => (rest === null ? "q-unk" : rest > 30 ? "q-ok" : rest >= 10 ? "q-mid" : "q-bad");

/** Uhrzeit des Resets für den Tooltip; ein reines Datum bleibt ein Datum. */
function resetTitle(w: QuotaWindow): string | undefined {
  if (!w.reset_at) return undefined;
  const ms = Date.parse(w.reset_at);
  if (Number.isNaN(ms)) return w.reset_at;
  return /^\d{4}-\d{2}-\d{2}$/.test(w.reset_at) ? `Reset am ${new Date(ms).toLocaleDateString("de-DE", { timeZone: "UTC", day: "2-digit", month: "2-digit", year: "numeric" })}` : `Reset am ${new Date(ms).toLocaleString("de-DE")}`;
}

function Window({ w }: { w: QuotaWindow }) {
  const rest = w.remaining_percent;
  const name = WINDOW_DE[w.label] ?? w.label;
  return (
    <li className="q-win" title={w.label}>
      <span className="q-wl">{name}</span>
      <div className="q-track" role="progressbar" aria-label={`${name}: ${rest === null ? "unbekannt" : `${pct(rest)} übrig`}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={rest ?? undefined}>
        <i className={level(rest)} style={{ width: `${rest ?? 0}%` }} />
      </div>
      <span className="q-rest mono">{rest === null ? "?" : `${pct(rest)} übrig`}</span>
      <span className="q-reset mono t3" title={resetTitle(w)}>{w.reset_in_s !== null ? fmtIn(w.reset_in_s) : (w.reset_at ?? "")}</span>
      {w.detail && <span className="q-detail t3 small">{w.detail}</span>}
    </li>
  );
}

function Block({ p }: { p: QuotaProvider }) {
  const badge = BADGE[p.state];
  return (
    <li className="card q-prov" aria-label={p.label}>
      <div className="row prov-head">
        <b className="grow">{p.label}</b>
        {p.plan && <span className="tag tag-m">{p.plan}</span>}
        {badge && <span className={`tag q-tag ${badge[1]}`}>{badge[0]}</span>}
      </div>
      {p.windows.length > 0 && <ul className="q-wins">{p.windows.map((w) => <Window key={w.label} w={w} />)}</ul>}
      {p.reason && <p className="hint">{p.reason}</p>}
    </li>
  );
}

export function PluginMissing({ reason }: { reason: string | null }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => { try { await navigator.clipboard.writeText(PLUGIN_CMD); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* keine Zwischenablage */ } };
  return (
    <div className="banner q-missing" role="status">
      <Icon name="alert" />
      <div className="col" style={{ gap: 6 }}>
        <span>{reason ?? "Plugin ai-usage-tracker auf diesem Host nicht installiert"}. Ohne das Plugin gibt es keine Restkontingente.</span>
        <span className="row" style={{ gap: 6 }}>
          <code className="mono">{PLUGIN_CMD}</code>
          <button type="button" className="btn btn-s btn-g" aria-label="Befehl kopieren" onClick={() => void copy()}><Icon name="copy" size={12} />{copied ? "Kopiert" : ""}</button>
        </span>
        <span className="hint">Oder <code className="mono">deploy/install-quota-plugin.sh</code> (Trockenlauf zeigt die genauen Befehle). Danach das Dashboard neu starten.</span>
      </div>
    </div>
  );
}

/** Kontingente eines Profils: je Anbieter ein Block mit Plan, Balken je Fenster und Zustand. */
export function QuotaBars({ quota }: { quota: Quota }) {
  if (quota.state === "plugin_missing") return <PluginMissing reason={quota.reason} />;
  if (quota.state !== "ok") return <p className="banner" role="alert"><Icon name="alert" /><span>Kontingente nicht abfragbar: {quota.reason}</span></p>;
  const shown = quota.providers.filter((p) => p.quota_capable || p.windows.length > 0 || p.state === "auth_failed");
  const rest = quota.providers.filter((p) => !shown.includes(p));
  return (
    <div className="col" style={{ gap: 10 }}>
      {shown.length === 0 ? <p className="panel-empty">Das Plugin meldet keinen Anbieter mit Kontingent.</p> : <ul className="prov-grid q-grid">{shown.map((p) => <Block key={p.id} p={p} />)}</ul>}
      {rest.length > 0 && (
        <details className="q-rest-list">
          <summary className="hint">Nicht abfragbar ({rest.length})</summary>
          <ul className="hint" style={{ margin: "6px 0 0", paddingLeft: 18 }}>{rest.map((p) => <li key={p.id}><b>{p.label}</b>: {p.reason}</li>)}</ul>
        </details>
      )}
    </div>
  );
}

/** Abschnitt mit Überschrift und „Neu laden“; `quota` fehlt, solange nichts geladen ist. */
export function QuotaSection({ title = "Restkontingente", quota, error, loading, onReload, children }: { title?: string; quota?: Quota; error?: string; loading: boolean; onReload: () => void; children?: React.ReactNode }) {
  return (
    <section aria-label={title} className="col" style={{ gap: 10 }}>
      <div className="row" style={{ gap: 8 }}>
        <span className="lbl grow">{title}</span>
        {quota?.cached && <span className="muted small">aus dem Zwischenspeicher</span>}
        <button type="button" className="btn btn-s btn-g" aria-label={`${title} neu laden`} disabled={loading} onClick={onReload}><Icon name="refresh" size={14} />Neu laden</button>
      </div>
      {error && !quota && <p className="banner" role="alert"><Icon name="alert" /><span>Kontingente nicht ladbar: {error}</span></p>}
      {!quota && !error && !children && <div className="q-skel" aria-busy="true" aria-label="Lade Kontingente" />}
      {children ?? (quota && <QuotaBars quota={quota} />)}
    </section>
  );
}
