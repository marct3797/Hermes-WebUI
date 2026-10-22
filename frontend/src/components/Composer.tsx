import { useRef, useState } from "react";
import { fileToDataUrl } from "../images";

type Props = { busy: boolean; disabled: boolean; name: string; onSend: (text: string, images: string[]) => void; onStop: () => void };

export function Composer({ busy, disabled, name, onSend, onStop }: Props) {
  const [text, setText] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const [error, setError] = useState<string>();
  const fileInput = useRef<HTMLInputElement>(null);

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
    if (!text.trim() || busy || disabled) return;
    onSend(text.trim(), images);
    setText("");
    setImages([]);
  };

  return (
    <form className="composer" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      {images.length > 0 && (
        <div className="thumbs">
          {images.map((src, i) => (
            <span key={i} className="thumb">
              <img src={src} alt={`Anhang ${i + 1}`} />
              <button type="button" aria-label={`Anhang ${i + 1} entfernen`} onClick={() => setImages(images.filter((_, j) => j !== i))}>×</button>
            </span>
          ))}
        </div>
      )}
      {error && <p className="error small" role="alert">{error}</p>}
      <div className="composer-row">
        <button type="button" className="ghost icon" aria-label="Bild anhängen" onClick={() => fileInput.current?.click()} disabled={images.length >= 4}>＋</button>
        <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden
          onChange={(e) => { void addFiles([...(e.target.files ?? [])]); e.target.value = ""; }} />
        <textarea
          value={text}
          rows={1}
          placeholder={disabled ? `${name} ist nicht erreichbar` : `Nachricht an ${name}…`}
          aria-label="Nachricht"
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            const files = [...e.clipboardData.files].filter((f) => f.type.startsWith("image/"));
            if (files.length) { e.preventDefault(); void addFiles(files); }
          }}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); } }}
        />
        {busy ? (
          <button type="button" className="danger" onClick={onStop}>Stopp</button>
        ) : (
          <button type="submit" className="primary" disabled={!text.trim() || disabled}>Senden</button>
        )}
      </div>
    </form>
  );
}
