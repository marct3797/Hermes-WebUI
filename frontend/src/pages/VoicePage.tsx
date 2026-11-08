import { useEffect, useState } from "react";
import { p3, type VoiceStatus } from "../p3Api";
import { PageHead } from "../components/PageHead";
import { useAction } from "../components/useAction";
import type { AgentRef } from "../types";
import { t } from "../i18n";

const MAX_AUDIO = 1_400_000; // globales Body-Limit des BFF (2 MiB) abzüglich Base64-Aufschlag

const readAsDataUrl = (f: File) => new Promise<string>((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result));
  r.onerror = () => reject(new Error(t("Datei nicht lesbar")));
  r.readAsDataURL(f);
});

export default function VoicePage({ agent }: { agent: AgentRef }) {
  const [status, setStatus] = useState<VoiceStatus | null>(null);
  const [loadErr, setLoadErr] = useState("");
  const [text, setText] = useState("");
  const [audio, setAudio] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [transcript, setTranscript] = useState<string | null>(null);
  const { run, notes, busy } = useAction();
  useEffect(() => { p3.voiceStatus(agent).then(setStatus).catch((e) => setLoadErr((e as Error).message)); }, [agent]);

  const tooBig = !!file && file.size > MAX_AUDIO;
  const isAudio = !file || file.type.startsWith("audio/");
  return (
    <article>
      <PageHead title={t("Sprache")} sub={status ? (status.available ? `Live-Sprache: ${status.mode}` : t("Live-Sprache nicht verfügbar{reason}. Vorlesen und Abschrift gehen trotzdem, wenn ein Anbieter eingerichtet ist", { reason: status.reason ? ` (${status.reason})` : "" })) : t("lädt …")} />
      {notes}
      {loadErr && <p className="banner" role="alert">{loadErr}</p>}
      <section aria-label={t("Vorlesen")}>
        <h2>{t("Vorlesen")}</h2>
        <label>{t("Text")} <textarea aria-label={t("Vorlesetext")} maxLength={1000} value={text} onChange={(e) => setText(e.target.value)} /></label>
        <p>{t("{v} von 1000 Zeichen. Der Anbieter steht in der Hermes-Konfiguration und kann Kosten verursachen.", { v: text.length })}</p>
        <button type="button" disabled={busy || !text.trim()} onClick={() => void run(async () => { const r = await p3.speak(agent, text); setAudio(r.data_url); })}>{t("Vorlesen")}</button>
        {audio && <audio controls src={audio} aria-label={t("Wiedergabe")} />}
      </section>
      <section aria-label={t("Abschrift")}>
        <h2>{t("Abschrift")}</h2>
        <label>{t("Aufnahme")} <input aria-label={t("Aufnahme")} type="file" accept="audio/*" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setTranscript(null); }} /></label>
        {tooBig && <p className="banner">{t("Aufnahme zu groß: höchstens 1,4 MB (etwa zwei Minuten).")}</p>}
        {!isAudio && <p className="banner">{t("Nur Audiodateien.")}</p>}
        <button type="button" disabled={busy || !file || tooBig || !isAudio} onClick={() => void run(async () => { const r = await p3.transcribe(agent, await readAsDataUrl(file!), file!.type || undefined); setTranscript(r.transcript); })}>{t("Abschrift erstellen")}</button>
        {transcript !== null && <p role="status">{transcript || t("(nichts erkannt)")}</p>}
      </section>
    </article>
  );
}
