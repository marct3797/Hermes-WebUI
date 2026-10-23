import { useRef, useState } from "react";
import { fileToDataUrl } from "../../images";
import type { ModelGroup } from "../../models";
import type { Queued, SendMode } from "../../types";
import { Icon } from "../Icon";

type Props = {
  busy: boolean;
  disabled: boolean;
  name: string;
  models: ModelGroup[];
  model?: string;
  /** Modell, das der Agent ohne Auswahl nutzt (nur für die Beschriftung der Standardwahl). */
  defaultModel?: string;
  onModel: (m?: string) => void;
  /** Der Agent kann Nachrichten in einen laufenden Run einschieben. */
  canSteer: boolean;
  queued: Queued[];
  onSend: (text: string, images: string[], mode?: SendMode) => void;
  onStop: () => void;
  onSendQueued: (id: string) => void;
  onDropQueued: (id: string) => void;
};

const MODE_HINT: Record<SendMode, string> = { steer: "nach dem nächsten Tool-Call einschieben", queue: "als nächsten Turn vormerken" };

export function Dock(p: Props) {
  const [text, setText] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const [error, setError] = useState<string>();
  const [chosen, setChosen] = useState<SendMode>("steer");
  const fileInput = useRef<HTMLInputElement>(null);
  const mode: SendMode = p.canSteer ? chosen : "queue";

  const addFiles = async (files: File[]) => {
    setError(undefined);
    try {
      const urls = await Promise.all(files.slice(0, 4 - images.length).map(fileToDataUrl));
      setImages((cur) => [...cur, ...urls].slice(0, 4));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const submit = () => {
    if (!text.trim() || p.disabled) return;
    if (p.busy && mode === "steer" && images.length) { setError("Bilder lassen sich nur vormerken (Queue), nicht einschieben."); return; }
    setError(undefined);
    p.onSend(text.trim(), images, p.busy ? mode : undefined);
    setText("");
    setImages([]);
  };

  const placeholder = p.disabled ? `${p.name} ist nicht erreichbar` : p.busy ? `Nachricht an ${p.name} … · ${MODE_HINT[mode]}` : `Nachricht an ${p.name}…`;

  return (
    <div className="dockw">
      <form className={`dock${p.busy ? " busy" : ""}`} onSubmit={(e) => { e.preventDefault(); submit(); }}>
        {p.queued.length > 0 && (
          <ul className="queue" aria-label="Vorgemerkte Nachrichten">
            {p.queued.map((q) => (
              <li key={q.id} className="row">
                <span className="tag tag-c">QUEUE</span>
                <span className="trunc grow">{q.text}</span>
                {!p.busy && <button type="button" className="btn btn-s" onClick={() => p.onSendQueued(q.id)}>Jetzt senden</button>}
                <button type="button" className="btn btn-s btn-i btn-g" aria-label="Vorgemerkte Nachricht entfernen" onClick={() => p.onDropQueued(q.id)}><Icon name="x" size={12} /></button>
              </li>
            ))}
          </ul>
        )}
        <div className="chips"><span className="cx on"><Icon name="chat" size={12} />@{p.name}</span></div>
        {images.length > 0 && (
          <div className="thumbs">
            {images.map((src, i) => (
              <span key={i} className="thumb">
                <img src={src} alt={`Anhang ${i + 1}`} />
                <button type="button" className="btn btn-s btn-i" aria-label={`Anhang ${i + 1} entfernen`} onClick={() => setImages(images.filter((_, j) => j !== i))}><Icon name="x" size={12} /></button>
              </span>
            ))}
          </div>
        )}
        {error && <p className="error small" role="alert">{error}</p>}
        <textarea
          value={text}
          rows={1}
          placeholder={placeholder}
          aria-label="Nachricht"
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            const files = [...e.clipboardData.files].filter((f) => f.type.startsWith("image/"));
            if (files.length) { e.preventDefault(); void addFiles(files); }
          }}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); } }}
        />
        <div className="bar">
          <button type="button" className="btn btn-s btn-i btn-g" aria-label="Bild anhängen" onClick={() => fileInput.current?.click()} disabled={images.length >= 4}><Icon name="clip" size={14} /></button>
          <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden
            onChange={(e) => { void addFiles([...(e.target.files ?? [])]); e.target.value = ""; }} />
          {p.busy && (
            <span className="seg" role="group" aria-label="Wirkung der Nachricht">
              {p.canSteer && <button type="button" className={mode === "steer" ? "on" : ""} aria-pressed={mode === "steer"} onClick={() => setChosen("steer")}>Steer</button>}
              <button type="button" className={mode === "queue" ? "on" : ""} aria-pressed={mode === "queue"} onClick={() => setChosen("queue")}>Queue</button>
            </span>
          )}
          {p.models.some((g) => g.models.length > 0) && (
            <span className="tag tag-m tag-act model-sel">
              <select value={p.model ?? ""} onChange={(e) => p.onModel(e.target.value || undefined)} aria-label="Modell">
                <option value="">{p.defaultModel ? `Standard · ${p.defaultModel}` : "Standardmodell"}</option>
                {p.models.length === 1
                  ? p.models[0].models.map((m) => <option key={m} value={m}>{m}</option>)
                  : p.models.map((g) => (
                    <optgroup key={g.provider} label={g.label}>{g.models.map((m) => <option key={`${g.provider}/${m}`} value={m}>{m}</option>)}</optgroup>
                  ))}
              </select>
              <Icon name="chevd" size={12} />
            </span>
          )}
          {p.busy && <button type="button" className="btn btn-s btn-d btn-i" aria-label="Stopp" onClick={p.onStop}><Icon name="stop" size={12} /></button>}
          <button type="submit" className="btn btn-p btn-i" aria-label="Senden" disabled={!text.trim() || p.disabled}><Icon name="send" size={14} /></button>
        </div>
      </form>
    </div>
  );
}
