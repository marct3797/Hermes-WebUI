import { useEffect, useRef, useState } from "react";
import { ApiError, toLogin } from "../../api";
import { knowledgeDocApi, INGEST_MAX } from "../../opsApi";
import { useAsync } from "../../useAsync";
import { Icon } from "../Icon";
import { ChunkEstimate } from "./IngestForm";
import { FileLoad } from "./TextSource";

const de = (n: number) => n.toLocaleString("de-DE");

/** Fundstelle: der Chunk, dessen Text mit dem Anfang des Treffers übereinstimmt. */
export function focusIndex(parts: { text: string }[], focus?: string): number {
  const probe = focus?.trim().slice(0, 60);
  return probe ? parts.findIndex((p) => p.text.includes(probe)) : -1;
}

/** Dokument ansehen (Metadaten, Volltext, Chunks) und bearbeiten. */
export function DocView({ provider, syncId, focus, chunkSize, overlap, onBack, onChanged }: {
  provider: string; syncId: string; focus?: string; chunkSize?: number | null; overlap?: number | null; onBack: () => void; onChanged: () => void;
}) {
  const [rev, setRev] = useState(0);
  const doc = useAsync(() => knowledgeDocApi.get(provider, syncId), [provider, syncId, rev]);
  const [tab, setTab] = useState<"text" | "parts">(focus ? "parts" : "text");
  const [edit, setEdit] = useState<{ title: string; text: string }>();
  const [state, setState] = useState<{ busy?: boolean; error?: string; stepUp?: boolean; done?: string }>({});
  const mark = useRef<HTMLLIElement>(null);
  const d = doc.data;
  const at = d ? focusIndex(d.parts, focus) : -1;
  useEffect(() => { mark.current?.scrollIntoView?.({ block: "center" }); }, [d, tab]);
  const synced = !!d && !d.sync_id.startsWith("manual:");
  const save = async () => {
    if (!edit) return;
    setState({ busy: true });
    try {
      const r = await knowledgeDocApi.replace(provider, syncId, { text: edit.text, ...(edit.title.trim() && edit.title.trim() !== d?.title ? { title: edit.title.trim() } : {}) });
      setEdit(undefined); setState({ done: `Gespeichert: ${de(r.chunks)} Chunks, ${de(r.removed)} alte entfernt.` }); setRev((n) => n + 1); onChanged();
    } catch (err) {
      setState(err instanceof ApiError && err.code === "step_up_required" ? { stepUp: true } : { error: (err as Error).message });
    }
  };
  const tooLong = (edit?.text.length ?? 0) > INGEST_MAX;
  return (
    <section className="kn-sec" aria-label="Dokument">
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <button type="button" className="btn btn-s" onClick={onBack}>Zurück zur Übersicht</button>
        <h2 className="grow trunc" style={{ margin: 0 }}>{d?.title ?? d?.path ?? syncId}</h2>
        {d && !edit && <button type="button" className="btn btn-s btn-p" disabled={!d.editable} onClick={() => { setEdit({ title: d.title ?? "", text: d.text }); setState({}); }}>Dokument bearbeiten</button>}
      </div>
      {doc.loading && <p className="muted small" role="status">Lade…</p>}
      {doc.error && <p className="banner" role="alert"><Icon name="alert" /><span>Dokument nicht ladbar: {doc.error}</span></p>}
      {d && (
        <>
          <dl className="kn-meta" aria-label="Metadaten">
            {([["Quelle", d.source], ["Kennung", d.sync_id], ["Titel", d.title], ["Repo", d.repo], ["Pfad", d.path], ["Commit", d.commit?.slice(0, 12)], ["Chunks", de(d.chunks)]] as const).filter(([, v]) => v).map(([k, v]) => (
              <div key={k} className="row" style={{ gap: 8 }}><dt className="lbl">{k}</dt><dd className="mono small" style={{ margin: 0 }}>{v}</dd></div>))}
          </dl>
          {d.truncated && <p className="banner" role="status"><Icon name="alert" /><span>Das Dokument hat mindestens {de(d.chunks)} Chunks. Angezeigt werden nur die ersten, Bearbeiten ist deshalb gesperrt.</span></p>}
          {state.done && <p className="hint crimt" role="status" style={{ margin: 0 }}>{state.done}</p>}
          {!edit && (
            <>
              <div className="tabs" role="group" aria-label="Ansicht">
                <button type="button" className={`tab${tab === "text" ? " on" : ""}`} aria-pressed={tab === "text"} onClick={() => setTab("text")}>Volltext</button>
                <button type="button" className={`tab${tab === "parts" ? " on" : ""}`} aria-pressed={tab === "parts"} onClick={() => setTab("parts")}>Chunks ({de(d.chunks)})</button>
              </div>
              {tab === "text" && <>
                <pre className="card kn-doc-text" aria-label="Volltext">{d.text}</pre>
                <p className="hint" style={{ margin: 0 }}>Der Volltext wird aus den Chunks zusammengesetzt; die Überlappung zwischen Chunks erscheint nur einmal.</p></>}
              {tab === "parts" && <ol className="kn-hits" aria-label="Chunks">{d.parts.map((p) => (
                <li key={p.index} ref={p.index === at ? mark : undefined} className={`card kn-part${p.index === at ? " focus" : ""}`} aria-current={p.index === at ? "true" : undefined}>
                  <span className="mono small t3">Chunk {de(p.index + 1)} von {de(d.chunks)}{p.index === at ? " · Fundstelle" : ""}</span><pre>{p.text}</pre></li>))}</ol>}
            </>)}
          {edit && (
            <form className="col" style={{ gap: 8 }} aria-label="Dokument bearbeiten" onSubmit={(e) => { e.preventDefault(); void save(); }}>
              {synced && <p className="banner" role="note"><Icon name="alert" /><span>Dieses Dokument stammt aus einem Repository-Sync. Der nächste Sync kann deine Änderung überschreiben.</span></p>}
              <label className="col"><span className="lbl">Titel</span><input className="field field-line" value={edit.title} maxLength={120} onChange={(e) => setEdit({ ...edit, title: e.target.value })} /></label>
              <FileLoad onText={(t) => setEdit({ ...edit, text: t })} disabled={state.busy} />
              <textarea className="field" rows={16} value={edit.text} aria-label="Inhalt" onChange={(e) => setEdit({ ...edit, text: e.target.value })} />
              <span className={`mono small ${tooLong ? "error" : "t3"}`}>{de(edit.text.length)} / {de(INGEST_MAX)} Zeichen</span>
              <ChunkEstimate chars={edit.text.length} size={chunkSize} overlap={overlap} />
              <p className="hint" style={{ margin: 0 }}>Speichern legt die neue Fassung unter derselben Kennung an und entfernt erst danach die alten Chunks. Schlägt das Einspeisen fehl, bleibt das Alte unverändert.</p>
              {state.stepUp && <p className="banner" role="alert"><Icon name="lock" /><span>Das Speichern verlangt eine frische Anmeldung. <button type="button" className="linkish" onClick={() => toLogin(true)}>Erneut anmelden</button></span></p>}
              {state.error && <p className="banner" role="alert"><Icon name="alert" /><span>{state.error}</span></p>}
              <div className="row" style={{ gap: 8 }}>
                <button type="submit" className="btn btn-s btn-p" disabled={!edit.text.trim() || tooLong || state.busy}>{state.busy ? "Speichere…" : "Speichern"}</button>
                <button type="button" className="btn btn-s" disabled={state.busy} onClick={() => { setEdit(undefined); setState({}); }}>Abbrechen</button>
              </div>
            </form>)}
        </>)}
    </section>
  );
}
