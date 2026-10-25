import { useEffect, useState } from "react";
import { ApiError, api, toLogin } from "../../api";
import { dropDraft, peekDraft, stashDraft } from "../../soulDraft";
import type { AgentRef, SoulState } from "../../types";
import { Icon } from "../Icon";
import { DiffView } from "./DiffView";
import { SoulHistory } from "./SoulHistory";
import { t } from "../../i18n";

type Conflict = { current: string; hash: string };

/**
 * SOUL.md bearbeiten. Speichern prüft, dass der Text seit dem Laden unverändert blieb (sonst Konflikt mit Wahl),
 * verlangt eine frische Anmeldung und legt den bisherigen Text vorher im Verlauf ab.
 */
export function SoulEditor({ agent, label, initial }: { agent: AgentRef; label: string; initial: SoulState }) {
  const [stash] = useState(() => peekDraft(agent));
  useEffect(() => dropDraft(agent), [agent]);

  const [saved, setSaved] = useState(initial); // Stand auf dem Server, soweit die WebUI ihn kennt
  const [draft, setDraft] = useState(stash?.content ?? initial.content);
  const [base, setBase] = useState(stash?.base ?? initial.hash); // Fingerabdruck des Texts, auf dem der Entwurf aufbaut
  const [showDiff, setShowDiff] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [stepUp, setStepUp] = useState(false);
  const [conflict, setConflict] = useState<Conflict>();
  const [done, setDone] = useState<string | undefined>(stash ? t("Dein Entwurf aus der Anmeldung ist wieder da. Speichere ihn jetzt.") : undefined);

  const dirty = draft !== saved.content;
  const tooLong = draft.length > saved.max_chars;

  const adopt = (content: string, hash: string, history = saved.history) => {
    setSaved((s) => ({ ...s, content, hash, exists: true, history }));
    setDraft(content); setBase(hash); setConflict(undefined); setStepUp(false); setShowDiff(false);
  };

  const save = async (against = base) => {
    setBusy(true); setError(undefined); setDone(undefined); setStepUp(false);
    try {
      const r = await api.saveSoul(agent, draft, against);
      adopt(draft, r.hash, r.history);
      setDone(r.changed ? t("Gespeichert. Der bisherige Text liegt im Verlauf.") : t("Keine Änderung: der Text ist schon so gespeichert."));
    } catch (e) {
      if (e instanceof ApiError && e.code === "soul_changed") {
        setConflict({ current: String(e.data?.current ?? ""), hash: String(e.data?.hash ?? "") });
      } else if (e instanceof ApiError && e.code === "step_up_required") setStepUp(true);
      else setError((e as Error).message);
    } finally { setBusy(false); }
  };

  const reauth = () => { stashDraft(agent, { content: draft, base }); toLogin(true); };

  const restore = async (id: string) => {
    const r = await api.restoreSoul(agent, id).catch((e: unknown) => {
      if (e instanceof ApiError && e.code === "step_up_required") { setStepUp(true); throw new Error(t("Zum Wiederherstellen bitte erneut anmelden.")); }
      throw e;
    });
    adopt(r.content, r.hash, r.history);
    setDone(t("Wiederhergestellt. Die vorherige Fassung liegt im Verlauf."));
  };

  return (
    <div className="col soul-col">
      <section className="card soul-ed" aria-label="SOUL.md">
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <span className="lbl grow">{t("SOUL.md von {label}", { label })}</span>
          <span className={`mono small ${tooLong ? "error" : "t3"}`}>{t("{toLocaleString} / {toLocaleString2} Zeichen", { toLocaleString: draft.length.toLocaleString("de-DE"), toLocaleString2: saved.max_chars.toLocaleString("de-DE") })}</span>
        </div>
        {!saved.exists && <p className="hint">{t("Dieses Profil hat noch keine SOUL.md. Mit dem ersten Speichern wird sie angelegt.")}</p>}
        <textarea className="soul-ta" value={draft} spellCheck={false} aria-label={t("Inhalt von SOUL.md")} rows={18}
          onChange={(e) => { setDraft(e.target.value); setDone(undefined); }} />
        <p className="hint" style={{ margin: 0 }}>{t("Die SOUL beschreibt Persönlichkeit und Auftreten des Agents. Neue Sessions verwenden den neuen Text, laufende Chats behalten ggf. ihren bisherigen Stand.")}</p>

        {stepUp && (
          <p className="banner" role="alert">
            <Icon name="lock" />
            <span>{t("Eine Änderung der SOUL verlangt eine frische Anmeldung. Dein Entwurf bleibt erhalten.")}
              {" "}<button type="button" className="linkish" onClick={reauth}>{t("Erneut anmelden")}</button></span>
          </p>
        )}
        {conflict && (
          <div className="banner col" role="alert" style={{ alignItems: "stretch", gap: 8 }}>
            <span className="row" style={{ gap: 8 }}><Icon name="alert" /><b>{t("SOUL.md wurde inzwischen geändert")}</b></span>
            <span className="small">{t("Ein anderer Editor oder der Agent selbst hat den Text verändert, seit du ihn geladen hast. Unten steht mit „−“, was nur im neuen Stand steht, und mit „+“, was nur in deinem Entwurf steht.")}</span>
            <DiffView before={conflict.current} after={draft} label={t("Unterschied zwischen dem neuen Stand und deinem Entwurf")} />
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              <button type="button" className="btn btn-s" onClick={() => adopt(conflict.current, conflict.hash)}>{t("Neuen Stand laden, Entwurf verwerfen")}</button>
              <button type="button" className="btn btn-s btn-p" disabled={busy} onClick={() => void save(conflict.hash)}>{t("Trotzdem mit meinem Text überschreiben")}</button>
            </div>
            <span className="hint">{t("Der überschriebene Text bleibt im Verlauf abrufbar.")}</span>
          </div>
        )}
        {error && <p className="banner" role="alert"><Icon name="alert" /><span>{error}</span></p>}
        {done && <p className="hint crimt" role="status" style={{ margin: 0 }}>{done}</p>}

        {showDiff && dirty && <DiffView before={saved.content} after={draft} label={t("Änderungen gegenüber dem gespeicherten Stand")} />}
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <button type="button" className="btn btn-p" disabled={busy || !dirty || tooLong} onClick={() => void save()}>
            <Icon name="check" size={14} />{t("Speichern")}
          </button>
          <button type="button" className="btn" disabled={!dirty} aria-pressed={showDiff} onClick={() => setShowDiff((v) => !v)}>
            <Icon name="diff" size={14} />{showDiff ? t("Vorschau schließen") : t("Änderungen ansehen")}
          </button>
          <button type="button" className="btn btn-g" disabled={!dirty || busy} onClick={() => { setDraft(saved.content); setBase(saved.hash); setDone(undefined); setShowDiff(false); }}>
            {t("Verwerfen")}
          </button>
        </div>
      </section>
      <SoulHistory agent={agent} entries={saved.history} current={saved.content} locked={dirty} onRestore={restore} />
    </div>
  );
}
