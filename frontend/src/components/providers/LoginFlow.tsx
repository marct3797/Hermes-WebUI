import { useEffect, useRef, useState } from "react";
import { ApiError, api } from "../../api";
import type { AgentRef, OAuthStart } from "../../types";
import { Icon } from "../Icon";
import { StepUpNote, webUrl } from "./StepUpNote";

type Props = {
  agent: AgentRef;
  provider: string;
  /** device: Code auf einer Seite eingeben und warten. pkce: Seite öffnen, den dort angezeigten Code hier einfügen. */
  kind: "device" | "pkce";
  label: string;
  onDone: (message: string) => void;
};

type Phase =
  | { step: "idle" }
  | { step: "starting" }
  | { step: "waiting"; start: OAuthStart }
  | { step: "submitting"; start: OAuthStart }
  | { step: "checking"; start: OAuthStart };

const MIN_POLL_S = 0.2;
const DEFAULT_POLL_S = 5;
const CHECK_MS = 300;

/**
 * Anmeldung bei einem Anbieter über das Dashboard der Maschine: Code oder Link anzeigen, auf die Bestätigung warten.
 * Das Dashboard hält die Sitzung; die WebUI fragt nur nach und zeigt, was zu tun ist. Zugangsdaten sehen weder Browser noch BFF.
 */
export function LoginFlow({ agent, provider, kind, label, onDone }: Props) {
  const [phase, setPhase] = useState<Phase>({ step: "idle" });
  const [code, setCode] = useState("");
  const [error, setError] = useState<string>();
  const [stepUp, setStepUp] = useState(false);
  const done = useRef(onDone);
  done.current = onDone;

  const session = phase.step === "waiting" || phase.step === "checking" ? phase.start.session_id : undefined;
  // Nach dem Übergeben des Codes steht die Antwort gleich bereit; beim Warten auf eine Bestätigung gilt der Takt, den das Dashboard nennt.
  const interval = phase.step === "checking" ? CHECK_MS : phase.step === "waiting" ? Math.max(MIN_POLL_S, phase.start.poll_interval ?? DEFAULT_POLL_S) * 1000 : 0;
  const polling = phase.step === "checking" || (phase.step === "waiting" && kind === "device");

  useEffect(() => {
    if (!session || !polling) return;
    let stopped = false;
    let misses = 0;
    let timer: ReturnType<typeof setTimeout>;
    const stop = (message?: string) => { setPhase({ step: "idle" }); if (message) setError(message); };
    const tick = async () => {
      try {
        const r = await api.oauthPoll(agent, provider, session);
        if (stopped) return;
        if (r.status === "approved") { stop(); done.current(`${label} ist angemeldet.`); return; }
        if (r.status === "expired") { stop("Der Code ist abgelaufen. Bitte die Anmeldung neu starten."); return; }
        if (r.status === "error") { stop(r.error_message || "Die Anmeldung ist fehlgeschlagen."); return; }
        misses = 0;
      } catch (e) {
        if (stopped) return;
        if (++misses >= 3) { stop(`Die Anmeldung ließ sich nicht abfragen: ${(e as Error).message}`); return; }
      }
      timer = setTimeout(tick, interval);
    };
    timer = setTimeout(tick, interval);
    return () => { stopped = true; clearTimeout(timer); };
  }, [session, polling, interval, agent, provider, label]);

  const fail = (e: unknown) => {
    if (e instanceof ApiError && e.code === "step_up_required") setStepUp(true);
    else setError((e as Error).message);
  };

  const start = async () => {
    setError(undefined); setStepUp(false); setCode(""); setPhase({ step: "starting" });
    try {
      const s = await api.oauthStart(agent, provider);
      if (!s.session_id) throw new Error("Das Dashboard hat keine Anmeldung gestartet.");
      setPhase({ step: "waiting", start: s });
    } catch (e) { setPhase({ step: "idle" }); fail(e); }
  };

  const submit = async (s: OAuthStart) => {
    setError(undefined); setStepUp(false); setPhase({ step: "submitting", start: s });
    try {
      const r = await api.oauthSubmit(agent, provider, s.session_id, code.trim());
      setCode("");
      if (r.status === "approved" || r.ok === true) { setPhase({ step: "idle" }); done.current(`${label} ist angemeldet.`); return; }
      setPhase({ step: "checking", start: s });
    } catch (e) { setPhase({ step: "waiting", start: s }); fail(e); }
  };

  const cancel = () => { setPhase({ step: "idle" }); setCode(""); setError(undefined); };

  const current = phase.step === "idle" || phase.step === "starting" ? undefined : phase.start;
  const link = webUrl(current?.verification_url ?? current?.auth_url);
  const minutes = current?.expires_in ? Math.max(1, Math.round(current.expires_in / 60)) : undefined;
  return (
    <div className="login-flow col" style={{ gap: 10 }}>
      {!current ? (
        <button type="button" className="btn btn-s btn-p" style={{ alignSelf: "flex-start" }} disabled={phase.step === "starting"} onClick={() => void start()}>
          <Icon name="lock" size={14} />{phase.step === "starting" ? "Starte…" : kind === "device" ? "Mit Gerätecode anmelden" : "Anmeldung starten"}
        </button>
      ) : (
        <div className="login-box" role="group" aria-label={`Anmeldung bei ${label}`}>
          {kind === "device" ? (
            <>
              <p className="small">1. Diese Seite öffnen und anmelden: {link ? <a href={link} target="_blank" rel="noreferrer noopener">{link}</a> : <span className="mono">{current.verification_url ?? "(keine Adresse geliefert)"}</span>}</p>
              <p className="small">2. Diesen Code dort eingeben:</p>
              <p className="login-code mono" aria-label="Gerätecode">{current.user_code ?? "—"}</p>
              <p className="hint" role="status">Warte auf die Bestätigung{minutes ? `, der Code gilt etwa ${minutes} Min.` : ""}. Die Seite kann offen bleiben.</p>
            </>
          ) : (
            <form onSubmit={(e) => { e.preventDefault(); void submit(current); }} className="col" style={{ gap: 10 }}>
              <p className="small">1. Die Anthropic-Seite öffnen und anmelden: {link ? <a href={link} target="_blank" rel="noreferrer noopener">Seite öffnen</a> : <span className="mono">(keine Adresse geliefert)</span>}</p>
              <div className="pf-fld">
                <label htmlFor={`lc-${provider}`}>2. Den dort angezeigten Code einfügen</label>
                <input id={`lc-${provider}`} className="pf-in mono" type="password" autoComplete="off" spellCheck={false} value={code} onChange={(e) => setCode(e.target.value)} placeholder="Code einfügen" />
              </div>
              {phase.step === "checking" && <p className="hint" role="status">Prüfe die Anmeldung…</p>}
              <button type="submit" className="btn btn-s btn-p" style={{ alignSelf: "flex-start" }} disabled={!code.trim() || phase.step !== "waiting"}>
                <Icon name="check" size={14} />Code übergeben
              </button>
            </form>
          )}
          <button type="button" className="btn btn-s btn-g" style={{ alignSelf: "flex-start" }} onClick={cancel}>Abbrechen</button>
        </div>
      )}
      {stepUp && <StepUpNote what="Die Anmeldung bei einem Anbieter" />}
      {error && <p className="banner" role="alert"><Icon name="alert" /><span>{error}</span></p>}
    </div>
  );
}
