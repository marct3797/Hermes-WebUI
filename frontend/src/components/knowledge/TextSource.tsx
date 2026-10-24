import { useState } from "react";
import { INGEST_MAX } from "../../opsApi";

const de = (n: number) => n.toLocaleString("de-DE");
export const TEXT_FILE = /\.(md|txt)$/i;

/** Textdatei (.md/.txt, bis 1 MiB) als Text lesen; wirft eine verständliche Meldung. */
export function readTextFile(file: File): Promise<string> {
  if (!TEXT_FILE.test(file.name)) return Promise.reject(new Error("Nur Dateien mit der Endung .md oder .txt sind erlaubt."));
  if (file.size > INGEST_MAX) return Promise.reject(new Error(`Die Datei ist ${de(file.size)} Bytes groß, erlaubt sind höchstens ${de(INGEST_MAX)} (1 MiB).`));
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result ?? ""));
    r.onerror = () => reject(new Error("Die Datei ließ sich nicht lesen."));
    r.readAsText(file, "utf-8");
  });
}

/** Dateiauswahl, die den Text in den Editor lädt. */
export function FileLoad({ onText, disabled }: { onText: (text: string, name: string) => void; disabled?: boolean }) {
  const [err, setErr] = useState<string>();
  return (
    <div className="col" style={{ gap: 4 }}>
      <label className="col"><span className="lbl">Textdatei laden (.md oder .txt, bis 1 MiB)</span>
        <input type="file" accept=".md,.txt,text/plain,text/markdown" aria-label="Textdatei laden" disabled={disabled} onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (!f) return;
          setErr(undefined);
          readTextFile(f).then((t) => onText(t, f.name), (x: Error) => setErr(x.message));
        }} /></label>
      {err && <p className="hint error" role="alert" style={{ margin: 0 }}>{err}</p>}
    </div>
  );
}
