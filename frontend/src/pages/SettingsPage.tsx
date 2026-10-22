import { useState } from "react";
import { api } from "../api";
import { Icon } from "../components/Icon";
import { PageHead } from "../components/PageHead";
import { dec } from "../format";
import { useMedia } from "../useMedia";
import { useUi } from "../ui";

/** Darstellung: der Hintergrund-Shader. Die Regler wirken sofort und gelten zuerst nur für dieses Gerät. */
export function SettingsPage() {
  const { shader, serverShader, localShader, writable, writeError, setLocalShader, resetLocalShader, apply } = useUi();
  const narrow = useMedia("(max-width: 800px)");
  const reduce = useMedia("(prefers-reduced-motion: reduce)");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string>();

  const overridden = Object.keys(localShader).length > 0;
  const same = shader.enabled === serverShader.enabled && shader.strength === serverShader.strength && shader.speed === serverShader.speed;

  const saveDefault = async () => {
    setBusy(true); setError(undefined); setSaved(false);
    try {
      apply(await api.saveShader(shader));
      resetLocalShader(); // das Gerät folgt ab jetzt der gespeicherten Vorgabe
      setSaved(true);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <main className="page">
      <PageHead title="Darstellung" sub="Hintergrund-Shader" />

      <section className="pf-s" aria-label="Hintergrund-Shader">
        <p className="muted small" style={{ margin: 0, maxWidth: 640 }}>
          Ein ruhiger Verlauf hinter allen Kacheln. Er läuft auf Cockpit, Inbox, Chat und Profil. Die Kacheln sind deckend,
          der Shader scheint nur in den Zwischenräumen und am Rand durch, so bleibt Text immer lesbar.
        </p>
        <div className="sh-bar">
          <button type="button" className={`btn ${shader.enabled ? "btn-p" : ""}`} aria-pressed={shader.enabled}
            onClick={() => setLocalShader({ enabled: !shader.enabled })}>
            <Icon name={shader.enabled ? "stop" : "play"} size={14} />{shader.enabled ? "Shader an" : "Shader aus"}
          </button>
          <label className="sh-ctl">
            <span className="lbl">Stärke · <b>{dec(shader.strength)}</b></span>
            <input type="range" className="pf-range" min={0} max={3} step={0.1} value={shader.strength} disabled={!shader.enabled}
              aria-label="Stärke" onChange={(e) => setLocalShader({ strength: Number(e.target.value) })} />
          </label>
          <label className="sh-ctl">
            <span className="lbl">Tempo · <b>{dec(shader.speed)}</b></span>
            <input type="range" className="pf-range" min={0} max={3} step={0.1} value={shader.speed} disabled={!shader.enabled}
              aria-label="Tempo" onChange={(e) => setLocalShader({ speed: Number(e.target.value) })} />
          </label>
        </div>

        <p className="hint" style={{ margin: 0 }}>
          Vorgabe der WebUI: {serverShader.enabled ? `Stärke ${dec(serverShader.strength)} · Tempo ${dec(serverShader.speed)}` : "aus"}.
          {overridden ? " Auf diesem Gerät gilt eine eigene Einstellung." : ""}
        </p>
        {reduce && <p className="hint crimt" role="status" style={{ margin: 0 }}>„Bewegung reduzieren“ ist im System an: der Shader steht still.</p>}
        {narrow && <p className="hint" role="status" style={{ margin: 0 }}>Auf schmalen Schirmen ist der Shader aus, um den Akku zu schonen.</p>}

        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <button type="button" className="btn btn-s" disabled={!overridden} onClick={() => { resetLocalShader(); setSaved(false); }}>
            <Icon name="refresh" size={14} />Auf Vorgabe zurücksetzen
          </button>
          <button type="button" className="btn btn-s" disabled={busy || !writable || same} onClick={() => void saveDefault()}
            title={writable ? undefined : (writeError ?? undefined)}>
            <Icon name="check" size={14} />Als Vorgabe für alle Geräte speichern
          </button>
          {saved && <span className="hint crimt" role="status">Gespeichert</span>}
        </div>
        {!writable && <p className="hint" style={{ margin: 0 }}>{writeError ?? "Die Vorgabe lässt sich hier nicht speichern."} Trage sie in der ui.json unter ui.backgroundShader ein.</p>}
        {error && <p className="banner" role="alert"><Icon name="alert" /><span>{error}</span></p>}
      </section>
    </main>
  );
}
