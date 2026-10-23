import { useState } from "react";
import { api } from "../../api";
import type { AgentRef, SoulEntry, SoulVersion } from "../../types";
import { fmtAgo } from "../../format";
import { Icon } from "../Icon";
import { DiffView } from "./DiffView";

type Props = {
  agent: AgentRef;
  entries: SoulEntry[];
  current: string;
  /** Wiederherstellen ist gesperrt, solange es ungespeicherte Änderungen gibt (sie gingen sonst verloren). */
  locked: boolean;
  onRestore: (id: string) => Promise<void>;
};

const when = (at: string) => new Date(at).toLocaleString("de-DE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

/** Frühere Fassungen von SOUL.md: ansehen, mit dem aktuellen Stand vergleichen, wiederherstellen. Der aktuelle Stand bleibt dabei im Verlauf. */
export function SoulHistory({ agent, entries, current, locked, onRestore }: Props) {
  const [open, setOpen] = useState<SoulVersion>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const view = async (id: string) => {
    setError(undefined);
    if (open?.id === id) { setOpen(undefined); return; }
    try { setOpen(await api.soulVersion(agent, id)); } catch (e) { setError((e as Error).message); }
  };
  const restore = async (id: string) => {
    setBusy(true); setError(undefined);
    try { await onRestore(id); setOpen(undefined); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <section className="card soul-hist" aria-label="Verlauf">
      <span className="lbl">Verlauf</span>
      {entries.length === 0 && <p className="hint">Noch keine Änderungen. Vor jedem Speichern legt die WebUI den bisherigen Text hier ab.</p>}
      {error && <p className="error small" role="alert">{error}</p>}
      <ul className="hist-list">
        {entries.map((e) => (
          <li key={e.id}>
            <div className="row hist-row">
              <div className="col grow" style={{ gap: 2, minWidth: 0 }}>
                <span className="small">{when(e.at)} <span className="muted">· {fmtAgo(Date.parse(e.at))}</span></span>
                <span className="mono t3 small">{e.reason} · {e.chars} Zeichen</span>
              </div>
              <button type="button" className="btn btn-s" aria-expanded={open?.id === e.id} onClick={() => void view(e.id)}>
                {open?.id === e.id ? "Schließen" : "Ansehen"}
              </button>
            </div>
            {open?.id === e.id && (
              <div className="hist-open">
                <p className="hint">Mit „−“ steht es nur in dieser Fassung, mit „+“ nur im aktuellen Stand.</p>
                <DiffView before={open.content} after={current} label={`Unterschied zwischen ${when(e.at)} und jetzt`} />
                <button type="button" className="btn btn-s btn-p" disabled={locked || busy} title={locked ? "Erst speichern oder verwerfen" : undefined} onClick={() => void restore(e.id)}>
                  <Icon name="refresh" size={14} />Diese Fassung wiederherstellen
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
