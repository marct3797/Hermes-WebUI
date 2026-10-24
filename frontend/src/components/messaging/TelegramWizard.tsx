import { useEffect, useRef, useState } from "react";
import { ApiError, api } from "../../api";
import type { AgentRef, TelegramPairing, TelegramPoll } from "../../types";
import { Icon } from "../Icon";
import { StepUpNote } from "../providers/StepUpNote";
import { POLL_MS, sleep } from "./poll";

const ids = (text: string) => text.split(/[,\s]+/).filter(Boolean);
const valid = (text: string) => ids(text).length > 0 && ids(text).every((i) => /^\d{1,20}$/.test(i));

/**
 * Telegram-Bot per Assistent: Hermes holt über einen Dienst von Nous einen Bot; hier öffnet man den Link in Telegram, bestätigt dort und trägt
 * ein, wer den Bot nutzen darf. Das Bot-Token bleibt im Dashboard und erreicht diesen Browser nie.
 */
export function TelegramWizard({ agent, onClose, onApplied }: { agent: AgentRef; onClose: () => void; onApplied: () => void }) {
  const [pairing, setPairing] = useState<TelegramPairing>();
  const [poll, setPoll] = useState<TelegramPoll>();
  const [users, setUsers] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [stepUp, setStepUp] = useState(false);
  const [done, setDone] = useState<{ bot: string | null; restartStarted: boolean; restartError: string | null }>();
  const started = useRef(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const fail = (e: unknown) => { if (e instanceof ApiError && e.code === "step_up_required") setStepUp(true); else setError((e as Error).message); };

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    (async () => {
      try { const p = await api.telegramStart(agent); if (alive.current) setPairing(p); } catch (e) { if (alive.current) fail(e); }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!pairing) return;
    let stop = false;
    (async () => {
      while (!stop && alive.current) {
        try {
          const r = await api.telegramPoll(agent, pairing.pairing_id);
          if (stop) return;
          setPoll(r);
          if (r.status === "ready") { setUsers((u) => u || r.owner_user_id || ""); return; }
        } catch (e) { if (!stop) fail(e); return; }
        await sleep(POLL_MS);
      }
    })();
    return () => { stop = true; };
  }, [pairing?.pairing_id]); // eslint-disable-line react-hooks/exhaustive-deps

  const apply = async () => {
    if (!pairing) return;
    setBusy(true); setError(undefined); setStepUp(false);
    try {
      const r = await api.telegramApply(agent, pairing.pairing_id, [...new Set(ids(users))]);
      setDone({ bot: r.bot_username, restartStarted: r.restart_started, restartError: r.restart_error });
      onApplied();
    } catch (e) { fail(e); } finally { setBusy(false); }
  };
  const cancel = async () => {
    if (pairing && !done) { try { await api.telegramCancel(agent, pairing.pairing_id); } catch { /* die Kopplung läuft von selbst ab */ } }
    onClose();
  };

  return (
    <div className="tool-prov" aria-label="Telegram-Assistent">
      {error && <p className="banner" role="alert"><Icon name="alert" /><span>{error}</span></p>}
      {stepUp && <StepUpNote what="Der Assistent" />}
      {!pairing && !error && !stepUp && <p className="muted small">Bereite die Kopplung vor…</p>}
      {pairing && !done && (
        <>
          <p style={{ margin: 0 }}>1. Link in Telegram öffnen und dort die Erstellung des Bots bestätigen.{pairing.suggested_username ? ` Vorgeschlagener Name: @${pairing.suggested_username}.` : ""}</p>
          <div className="row" style={{ gap: 8 }}>
            <a className="btn btn-s btn-p" href={pairing.deep_link} target="_blank" rel="noreferrer noopener">In Telegram öffnen</a>
          </div>
          {poll?.status !== "ready" && <p className="muted small" aria-live="polite">Warte auf die Bestätigung in Telegram…</p>}
          {poll?.status === "ready" && (
            <>
              <p style={{ margin: 0 }} aria-live="polite">Bot @{poll.bot_username ?? "?"} ist bereit. 2. Wer darf den Bot nutzen?</p>
              <div className="pf-fld">
                <label htmlFor="tg-users">Erlaubte Telegram-Nutzer-IDs</label>
                <input id="tg-users" className="pf-in mono" value={users} onChange={(e) => setUsers(e.target.value)} placeholder="Zahlen, mit Komma getrennt" />
                <span className="hint">Ohne Liste wäre der Bot für jeden offen; darum ist mindestens eine ID nötig.</span>
              </div>
              <div className="row" style={{ gap: 8 }}>
                <button type="button" className="btn btn-s btn-p" disabled={busy || !valid(users)} onClick={() => void apply()}>Übernehmen</button>
              </div>
            </>
          )}
        </>
      )}
      {done && (
        <p role="status" style={{ margin: 0 }}>Übernommen. Bot @{done.bot ?? "?"} ist eingerichtet.{" "}
          {done.restartStarted ? "Das Gateway wird neu gestartet." : `Neustart nötig: das Gateway wurde nicht neu gestartet${done.restartError ? ` (${done.restartError})` : ""}.`}</p>
      )}
      <div className="row" style={{ gap: 8 }}>
        <button type="button" className="btn btn-s btn-g" onClick={() => void cancel()}>{done ? "Schließen" : "Abbrechen"}</button>
      </div>
    </div>
  );
}
