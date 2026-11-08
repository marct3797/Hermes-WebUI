import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api } from "../../api";
import type { AgentRef, GatewayAction, GatewayState } from "../../types";
import { Icon } from "../Icon";
import { StepUpNote } from "../providers/StepUpNote";
import { POLL_MS, sleep } from "./poll";
import { t } from "../../i18n";

type What = "start" | "stop" | "restart";
const plural = (n: number) => `${n} laufende Sitzung${n === 1 ? "" : "en"}`;

/**
 * Zustand des Gateways und Start, Stopp, Neustart. Hermes startet dafür nur einen Prozess: „gestartet“ heißt nicht „läuft“, darum fragt die
 * Leiste danach den Zustand und das Protokoll ab. Ist das Gateway beschäftigt, unterbrechen Neustart und Stopp laufende Sitzungen erst nach
 * ausdrücklicher Bestätigung.
 */
export function GatewayBar({ agent, onChanged }: { agent: AgentRef; onChanged: () => void }) {
  const [state, setState] = useState<GatewayState>();
  const [log, setLog] = useState<GatewayAction>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [stepUp, setStepUp] = useState(false);
  const [ask, setAsk] = useState<{ what: What; message: string }>();
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const refresh = useCallback(async () => {
    try { const s = await api.gateway(agent); if (alive.current) setState(s); } catch (e) { if (alive.current) setError((e as Error).message); }
  }, [agent.host, agent.runtime, agent.agent]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void refresh(); }, [refresh]);

  const run = async (what: What, confirmed = false) => {
    setBusy(true); setError(undefined); setStepUp(false); setLog(undefined);
    try {
      await api.gatewayAction(agent, what, confirmed);
      setAsk(undefined);
      for (let i = 0; i < 10 && alive.current; i += 1) {
        const l = await api.gatewayLog(agent, `gateway-${what}`);
        if (alive.current) setLog(l);
        if (!l.running) break;
        await sleep(POLL_MS);
      }
      await refresh();
      onChanged();
    } catch (e) {
      if (e instanceof ApiError && e.code === "interrupt_confirmation_required") setAsk({ what, message: e.message });
      else if (e instanceof ApiError && e.code === "step_up_required") setStepUp(true);
      else setError((e as Error).message);
    } finally { if (alive.current) setBusy(false); }
  };

  return (
    <section className="card gw-bar" role="region" aria-label={t("Gateway")}>
      <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
        <b>{t("Gateway: {running}", { running: state ? (state.running ? "läuft" : t("gestoppt")) : "…" })}</b>
        {state && state.active_sessions > 0 && <span className="tag tag-m">{plural(state.active_sessions)}</span>}
        <span className="grow" />
        {state && !state.running && <button type="button" className="btn btn-s btn-p" disabled={busy} onClick={() => void run("start")}><Icon name="play" size={14} />{t("Gateway starten")}</button>}
        {state?.running && <button type="button" className="btn btn-s btn-g" disabled={busy} onClick={() => void run("restart")}><Icon name="refresh" size={14} />{t("Neu starten")}</button>}
        {state?.running && <button type="button" className="btn btn-s btn-g" disabled={busy} onClick={() => void run("stop")}><Icon name="stop" size={14} />{t("Anhalten")}</button>}
      </div>
      {ask && (
        <div className="banner" role="alert"><Icon name="alert" /><span>{ask.message}{" "}
          <button type="button" className="linkish" disabled={busy} onClick={() => void run(ask.what, true)}>{t("Trotzdem unterbrechen")}</button>{" "}
          <button type="button" className="linkish" onClick={() => setAsk(undefined)}>{t("Lieber nicht")}</button></span></div>
      )}
      {stepUp && <StepUpNote what={t("Das Gateway zu steuern")} />}
      {error && <p className="banner" role="alert"><Icon name="alert" /><span>{error}</span></p>}
      {log && (
        <div className="muted small" aria-live="polite">
          <div>{log.running ? t("Befehl wird noch ausgeführt…") : log.exit_code === 0 || log.exit_code === null ? t("Befehl ausgeführt.") : t("Befehl endete mit Fehler (Exit {exit_code}).", { exit_code: log.exit_code })}</div>
          {log.lines.slice(-6).map((l, i) => <div key={i} className="mono">{l}</div>)}
        </div>
      )}
    </section>
  );
}
