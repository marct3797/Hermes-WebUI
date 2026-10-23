import { useState } from "react";
import { api } from "../api";
import { Icon } from "../components/Icon";
import { PageHead } from "../components/PageHead";
import { ProviderCard } from "../components/providers/ProviderCard";
import { useHosts } from "../hosts";
import type { AgentRef } from "../types";
import { useAsync } from "../useAsync";

const DAYS = [7, 30, 90] as const;

/** Coding-Werkzeuge, die die WebUI später je Host anbindet. Hier steht, was feststeht; Abo-Zugänge laufen nicht über Hermes-Anbieter. */
const CODING_CLIS = [
  ["claude-code", "Claude Code", "Abo über die CLI auf dem Host. Die Abo-Anmeldung darf nicht in fremden Oberflächen genutzt werden, geplant ist eine Terminal-Ansicht der echten CLI."],
  ["opencode", "OpenCode", "Eigener Server auf dem Host (HTTP und Ereignisstrom), Anbieter-Keys liegen in seiner eigenen Config."],
  ["antigravity", "Antigravity", "CLI auf dem Host, Anmeldung im Terminal. Eine Programmschnittstelle ist nicht bekannt."],
  ["codex", "OpenAI Codex", "Anmeldung über ChatGPT oder Key. Hermes kann sie als Anbieter nutzen (siehe „OpenAI Codex“ oben)."],
] as const;

/** Anbieter eines Hermes-Profils: welche eingerichtet sind, was darüber lief, Key eintragen. Alles über das Dashboard der Maschine. */
export function ProvidersPage({ agent, label }: { agent: AgentRef; label: string }) {
  const [days, setDays] = useState<number>(30);
  const [reload, setReload] = useState(0);
  const [done, setDone] = useState<string>();
  const [showOff, setShowOff] = useState(false);
  const state = useAsync(() => api.providers(agent, days), [agent.host, agent.runtime, agent.agent, days, reload]);
  const { hosts } = useHosts();

  const all = state.data?.providers ?? [];
  const active = all.filter((p) => p.configured || p.used);
  const off = all.filter((p) => !p.configured && !p.used);
  const saved = (message: string) => { setDone(message); setReload((n) => n + 1); };
  const installed = new Set((hosts ?? []).flatMap((h) => h.runtimes.map((r) => r.id)));

  return (
    <main className="page">
      <PageHead title="Anbieter" sub={state.data ? `${label} · ${active.length} eingerichtet` : label}>
        <div className="row" role="group" aria-label="Zeitraum" style={{ gap: 6 }}>
          {DAYS.map((d) => <button key={d} type="button" className={`chip chip-s${days === d ? " on" : ""}`} aria-pressed={days === d} onClick={() => setDays(d)}>{d} Tage</button>)}
        </div>
      </PageHead>
      {state.error && <p className="banner" role="alert"><Icon name="alert" /><span>Anbieter nicht ladbar: {state.error}. Anbieter und Keys kommen aus dem Dashboard der Maschine, siehe „SOUL & Profil“.</span></p>}
      {state.loading && !state.data && <p className="muted">Lade…</p>}
      {done && <p className="hint crimt" role="status" style={{ margin: 0 }}>{done}</p>}
      {state.data?.warnings.map((w) => <p key={w} className="hint" role="status">{w}</p>)}

      {state.data && (
        <>
          <section aria-label="Eingerichtete Anbieter" className="col" style={{ gap: 10 }}>
            <span className="lbl">Eingerichtet</span>
            {active.length === 0 ? <p className="panel-empty">Noch kein Anbieter eingerichtet.</p> : (
              <ul className="prov-grid">{active.map((g) => <ProviderCard key={g.id} agent={agent} group={g} days={days} onSaved={saved} />)}</ul>
            )}
          </section>

          {off.length > 0 && (
            <section aria-label="Weitere Anbieter" className="col" style={{ gap: 10 }}>
              <button type="button" className="btn btn-s" style={{ alignSelf: "flex-start" }} aria-expanded={showOff} onClick={() => setShowOff((v) => !v)}>
                <Icon name="plus" size={14} />{showOff ? "Weitere Anbieter ausblenden" : `Anbieter hinzufügen (${off.length} verfügbar)`}
              </button>
              {showOff && <ul className="prov-grid">{off.map((g) => <ProviderCard key={g.id} agent={agent} group={g} days={days} onSaved={saved} />)}</ul>}
            </section>
          )}

          <p className="hint">Keys gelten für dieses Profil ({agent.agent}), jedes Profil hat seine eigene Liste. Die Werte erscheinen nie in der WebUI, nur in geschwärzter Form. Restkontingente der Konten (etwa Abo-Fenster) zeigt die WebUI noch nicht: Hermes liefert sie nicht über sein Dashboard.</p>
        </>
      )}

      <section aria-label="Coding-CLIs" className="col" style={{ gap: 10 }}>
        <span className="lbl">Coding-CLIs</span>
        <ul className="prov-grid">
          {CODING_CLIS.map(([id, name, text]) => (
            <li key={id} className="card prov-card off">
              <div className="row prov-head"><b className="grow">{name}</b>{installed.has(id) ? <span className="tag tag-m">ANGEBUNDEN</span> : <span className="tag">NOCH NICHT ANGEBUNDEN</span>}</div>
              <p className="hint">{text}</p>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
