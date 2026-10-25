import { useState, type FormEvent } from "react";
import { ApiError, api, toLogin } from "../../api";
import { estimateChunks, INGEST_MAX } from "../../opsApi";
import { Icon } from "../Icon";
import { FileLoad } from "./TextSource";
import { t as tr } from "../../i18n";

const de = (n: number) => n.toLocaleString("de-DE");
const NEW = "\u0000neu";

export function ChunkEstimate({ chars, size, overlap }: { chars: number; size?: number | null; overlap?: number | null }) {
  return <span className="hint">{tr("Etwa {v} Chunks (Schätzung, der Dienst teilt nach Token)", { v: de(estimateChunks(chars, size ?? 512, overlap ?? 50)) })}</span>;
}

/** Text einspeisen: einfügen oder Textdatei laden, Quelle wählen oder neu benennen, Chunk-Vorschau. */
export function IngestForm({ provider, sources, chunkSize, overlap, onDone }: { provider: string; sources?: string[]; chunkSize?: number | null; overlap?: number | null; onDone: () => void }) {
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [source, setSource] = useState("manual");
  const [fresh, setFresh] = useState("");
  const [state, setState] = useState<{ busy?: boolean; error?: string; stepUp?: boolean; done?: string }>({});
  const options = [...new Set(["manual", ...(sources ?? [])])];
  const effective = source === NEW ? fresh.trim() : source;
  const tooLong = text.length > INGEST_MAX;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setState({ busy: true });
    try {
      const r = await api.knowledgeIngest(provider, { title: title.trim(), text, ...(effective !== "manual" ? { source: effective } : {}) });
      setState({ done: `Eingespeist als ${r.sync_id}.` }); setTitle(""); setText(""); onDone();
    } catch (err) {
      setState(err instanceof ApiError && err.code === "step_up_required" ? { stepUp: true } : { error: (err as Error).message });
    }
  };
  return (
    <details className="kn-sec">
      <summary>{tr("Text einspeisen")}</summary>
      <form className="col" style={{ gap: 8, marginTop: 8 }} onSubmit={(e) => void submit(e)}>
        <input className="field field-line" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} placeholder={tr("Titel")} aria-label={tr("Titel")} />
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <label className="col"><span className="lbl">{tr("Quelle zum Einspeisen")}</span>
            <select className="field field-line" value={source} onChange={(e) => setSource(e.target.value)}>
              {options.map((s) => <option key={s} value={s}>{s}</option>)}<option value={NEW}>{tr("Neue Quelle…")}</option></select></label>
          {source === NEW && <label className="col"><span className="lbl">{tr("Name der neuen Quelle")}</span>
            <input className="field field-line" value={fresh} maxLength={100} onChange={(e) => setFresh(e.target.value)} /></label>}
        </div>
        <FileLoad onText={(t, name) => { setText(t); setTitle((cur) => cur || name.replace(/\.(md|txt)$/i, "")); }} />
        <textarea className="field" rows={8} value={text} onChange={(e) => setText(e.target.value)} placeholder={tr("Text")} aria-label={tr("Text")} />
        <span className={`mono small ${tooLong ? "error" : "t3"}`}>{tr("{v} / {INGEST_MAX} Zeichen", { v: de(text.length), INGEST_MAX: de(INGEST_MAX) })}</span>
        {text.trim() && <ChunkEstimate chars={text.length} size={chunkSize} overlap={overlap} />}
        {state.stepUp && <p className="banner" role="alert"><Icon name="lock" /><span>{tr("Das Einspeisen verlangt eine frische Anmeldung.")} <button type="button" className="linkish" onClick={() => toLogin(true)}>{tr("Erneut anmelden")}</button></span></p>}
        {state.error && <p className="banner" role="alert"><Icon name="alert" /><span>{state.error}</span></p>}
        {state.done && <p className="hint crimt" role="status" style={{ margin: 0 }}>{state.done}</p>}
        <div><button type="submit" className="btn btn-s btn-p" disabled={!title.trim() || !text.trim() || tooLong || (source === NEW && !fresh.trim()) || state.busy}>{state.busy ? tr("Speichere…") : tr("Einspeisen")}</button></div>
      </form>
    </details>
  );
}
