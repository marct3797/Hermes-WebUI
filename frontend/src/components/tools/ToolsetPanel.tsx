import { useRef, useState } from "react";
import { ApiError, api } from "../../api";
import type { AgentRef, ToolProvider, ToolsetRow } from "../../types";
import { type Async, useAsync } from "../../useAsync";
import { Icon } from "../Icon";
import { StepUpNote, webUrl } from "../providers/StepUpNote";

type Props = { agent: AgentRef; row: ToolsetRow; onChanged: () => void };

/** Während eine Änderung neu geladen wird, bleiben die letzten Daten stehen (kein Aufblitzen, keine verlorenen Eingaben). */
function kept<T>(now: Async<T>, last: { current?: T }): T | undefined {
  if (now.data !== undefined) last.current = now.data;
  return now.data ?? last.current;
}

const STATUS: Record<string, string> = { ready: "bereit", needs_keys: "Key fehlt", needs_auth: "Anmeldung fehlt", needs_setup: "Einrichtung fehlt" };

/**
 * Eine Werkzeug-Gruppe einrichten: ein- und ausschalten, Anbieter wählen, Werkzeug-Keys eintragen, Modell wählen.
 * Gruppen, Anbieter und Variablen kommen vom Dashboard. Ein Key-Wert geht nur an das BFF und wird danach nie wieder angezeigt (nur „gesetzt“).
 * Bewusst nicht hier: Terminal-Backend umstellen, Programme nachinstallieren, Rechte vergeben, beliebige Variablen schreiben.
 */
export function ToolsetPanel({ agent, row, onChanged }: Props) {
  const [version, setVersion] = useState(0);
  const deps = [agent.host, agent.runtime, agent.agent, row.name, version];
  const configNow = useAsync(() => api.toolConfig(agent, row.name), deps);
  const modelsNow = useAsync(() => api.toolModels(agent, row.name), deps);
  const lastConfig = useRef<Awaited<ReturnType<typeof api.toolConfig>>>(undefined);
  const lastModels = useRef<Awaited<ReturnType<typeof api.toolModels>>>(undefined);
  const config = { ...configNow, data: kept(configNow, lastConfig) };
  const models = { ...modelsNow, data: kept(modelsNow, lastModels) };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [stepUp, setStepUp] = useState(false);
  const [consent, setConsent] = useState<string>();
  const [chosen, setChosen] = useState<string>();

  const run = async (action: () => Promise<unknown>, afterwards?: () => void) => {
    setBusy(true); setError(undefined); setStepUp(false);
    try {
      await action();
      afterwards?.();
      setVersion((v) => v + 1);
      onChanged();
    } catch (e) {
      if (e instanceof ApiError && e.code === "step_up_required") setStepUp(true);
      else if (e instanceof ApiError && e.code === "install_consent_required") setConsent(e.message);
      else setError((e as Error).message);
    } finally { setBusy(false); }
  };

  const toggle = () => run(() => api.toggleTool(agent, row.name, !row.enabled, consent !== undefined), () => setConsent(undefined));
  const catalog = models.data?.has_models ? models.data : undefined;
  const model = chosen ?? catalog?.current ?? "";

  return (
    <section className="card tool-panel" role="region" aria-label={`Einstellungen für ${row.label ?? row.name}`}>
      <div className="row" style={{ gap: 8 }}>
        <b>{row.label ?? row.name}</b>
        <span className={`tag${row.enabled ? " tag-c" : ""}`}>{row.enabled ? "aktiv" : "aus"}</span>
        <button type="button" className={`btn btn-s ${row.enabled ? "btn-g" : "btn-p"}`} disabled={busy} onClick={() => void toggle()}>
          {row.enabled ? "Ausschalten" : consent !== undefined ? "Zustimmen und einschalten" : "Einschalten"}
        </button>
      </div>
      {consent !== undefined && <p className="banner" role="alert"><Icon name="alert" /><span>{consent}</span></p>}
      {stepUp && <StepUpNote what="Diese Änderung" />}
      {error && <p className="banner" role="alert"><Icon name="alert" /><span>{error}</span></p>}
      {config.loading && !config.data && <p className="muted small">Lade…</p>}
      {config.error && <p className="banner" role="alert"><Icon name="alert" /><span>Einstellungen nicht ladbar: {config.error}</span></p>}
      {config.data && !config.data.has_category && <p className="muted small">Diese Gruppe hat keine Anbieter und keine Keys zu verwalten.</p>}
      {config.data?.providers.map((p) => (
        <Provider key={p.name} provider={p} name={row.name} busy={busy} agent={agent}
          onChoose={(capability) => run(() => api.setToolProvider(agent, row.name, p.name, capability))}
          onKey={(key, value) => run(() => api.setToolKeys(agent, row.name, { [key]: value }))} />
      ))}
      {catalog && (
        <div className="pf-fld">
          <label htmlFor={`model-${row.name}`}>Modell</label>
          <div className="row" style={{ gap: 8 }}>
            <select id={`model-${row.name}`} className="pf-in" value={model} onChange={(e) => setChosen(e.target.value)}>
              {catalog.models.map((m) => <option key={m.id} value={m.id}>{m.display ?? m.id}{m.price ? ` · ${m.price}` : ""}</option>)}
            </select>
            <button type="button" className="btn btn-s btn-p" disabled={busy || model === catalog.current} onClick={() => void run(() => api.setToolModel(agent, row.name, model), () => setChosen(undefined))}>Modell speichern</button>
          </div>
        </div>
      )}
    </section>
  );
}

function Provider({ provider: p, name, busy, onChoose, onKey }: {
  provider: ToolProvider; name: string; busy: boolean; agent: AgentRef;
  onChoose: (capability?: "search" | "extract") => void; onKey: (key: string, value: string) => void;
}) {
  const parts = p.capabilities && p.capabilities.length > 1 ? p.capabilities.filter((c): c is "search" | "extract" => c === "search" || c === "extract") : [];
  return (
    <div className="tool-prov">
      <div className="row" style={{ gap: 8 }}>
        <b>{p.name}</b>
        {p.badge && <span className="tag tag-m">{p.badge}</span>}
        {p.status && <span className="tag">{STATUS[p.status] ?? p.status}</span>}
        {p.is_active && <span className="tag tag-c">aktiv</span>}
        {parts.length > 0 ? parts.map((c) => (
          <button key={c} type="button" className="btn btn-s btn-g" disabled={busy} aria-label={`${p.name} für ${c === "search" ? "Suche" : "Extraktion"} wählen`} onClick={() => onChoose(c)}>
            {c === "search" ? "Für Suche" : "Für Extraktion"}
          </button>
        )) : <button type="button" className="btn btn-s btn-g" disabled={busy} aria-label={`${p.name} wählen`} onClick={() => onChoose()}>Wählen</button>}
      </div>
      {p.env_vars.map((v) => <KeyField key={`${name}-${p.name}-${v.key}`} id={`${name}-${p.name}-${v.key}`} envVar={v} busy={busy} onSave={(value) => onKey(v.key, value)} />)}
    </div>
  );
}

function KeyField({ id, envVar: v, busy, onSave }: { id: string; envVar: ToolProvider["env_vars"][number]; busy: boolean; onSave: (value: string) => void }) {
  const [value, setValue] = useState("");
  const link = webUrl(v.url ?? undefined);
  return (
    <form className="pf-fld" onSubmit={(e) => { e.preventDefault(); onSave(value.trim()); setValue(""); }}>
      <label htmlFor={id}>{v.key}</label>
      <div className="row" style={{ gap: 8 }}>
        <input id={id} aria-label={v.key} className="pf-in mono grow" type="password" autoComplete="off" spellCheck={false} value={value} placeholder={v.is_set ? "Neuen Wert einfügen, um ihn zu ersetzen" : v.prompt ?? ""} onChange={(e) => setValue(e.target.value)} />
        <span className={`tag${v.is_set ? " tag-c" : ""}`}>{v.is_set ? "gesetzt" : "nicht gesetzt"}</span>
        <button type="submit" className="btn btn-s btn-p" disabled={busy || !value.trim()} aria-label={`${v.key} speichern`}>Speichern</button>
      </div>
      {link && <a className="hint" href={link} target="_blank" rel="noreferrer noopener">Key beim Anbieter anlegen</a>}
    </form>
  );
}
