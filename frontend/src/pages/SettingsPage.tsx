import { useEffect, useState } from "react";
import { api } from "../api";
import { Icon } from "../components/Icon";
import { PageHead } from "../components/PageHead";
import { dec } from "../format";
import { useMedia } from "../useMedia";
import { useUi } from "../ui";
import { useRunStore } from "../runs";
import { EFFORTS } from "../composerLogic";
import { composerApi } from "../composerApi";
import { useHosts } from "../hosts";
import { useAsync } from "../useAsync";
import { savePreferences, usePreferences, type HostDefaults, type Preferences } from "../preferences";
import { playNotice } from "../notifications";

function HostSettings({ host, label, value, onChange }: { host: string; label: string; value: HostDefaults; onChange: (v: HostDefaults) => void }) {
  const ws = useAsync(() => composerApi.workspaces(host), [host]);
  return <fieldset className="settings-host">
    <legend>{label}</legend>
    <label>Denkaufwand <select className="field field-line" aria-label={`Denkaufwand für ${host}`} value={value.effort} onChange={(e) => onChange({ ...value, effort: e.target.value as HostDefaults["effort"] })}>
      <option value="agent">Standard des Agents</option><option value="off">Aus</option>
      {EFFORTS.map((e) => <option key={e.value} value={e.value}>{e.label}</option>)}
    </select></label>
    <label>Arbeitsordner <select className="field field-line" aria-label={`Standard-Arbeitsordner für ${host}`} value={value.workspace} disabled={!ws.data} onChange={(e) => onChange({ ...value, workspace: e.target.value })}>
      <option value="">Keine Vorgabe</option>
      {value.workspace && !ws.data?.workspaces.some((w) => w.id === value.workspace) && <option value={value.workspace}>Nicht verfügbar: {value.workspace}</option>}
      {ws.data?.workspaces.map((w) => <option key={w.id} value={w.id}>{w.label}</option>)}
    </select></label>
    {ws.error && <p className="hint" role="status">Arbeitsordner nicht ladbar: {ws.error}</p>}
  </fieldset>;
}

/** Darstellung: der Hintergrund-Shader. Die Regler wirken sofort und gelten zuerst nur für dieses Gerät. */
export function SettingsPage() {
  const { shader, serverShader, localShader, writable, writeError, setLocalShader, resetLocalShader, apply } = useUi();
  const narrow = useMedia("(max-width: 800px)");
  const reduce = useMedia("(prefers-reduced-motion: reduce)");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string>();
  const store = useRunStore();
  const prefs = usePreferences();
  const registry = useHosts();
  const [preferenceError, setPreferenceError] = useState<string>();
  const update = (patch: Partial<Preferences>) => {
    try { savePreferences(patch); setPreferenceError(undefined); }
    catch { setPreferenceError("Der Browser erlaubt das Speichern dieser Einstellungen nicht."); }
  };
  const desktop = async (on: boolean) => {
    if (!on) { update({ approvalDesktop: false }); return; }
    try {
      if (typeof Notification === "undefined") throw new Error("Dieser Browser unterstützt keine Desktop-Mitteilungen.");
      const permission = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
      update({ approvalDesktop: permission === "granted" });
      if (permission !== "granted") setPreferenceError("Desktop-Mitteilungen sind im Browser nicht erlaubt.");
    } catch (e) { setPreferenceError((e as Error).message); }
  };
  const sound = async (on: boolean) => {
    try { if (on) await playNotice(); update({ approvalSound: on }); }
    catch (e) { setPreferenceError((e as Error).message); }
  };
  const [notify, setNotify] = useState(store.notificationsEnabled);
  useEffect(() => { setNotify(store.notificationsEnabled); }, [store]);

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
      <PageHead title="Darstellung" sub="Einstellungen für dieses Gerät" />
      <p className="hint">Änderungen gelten sofort in diesem Browser. Host-Vorgaben gelten für neue Chats und die Terminal-Auswahl; eine eigene Auswahl im Chat bleibt vorrangig.</p>
      {preferenceError && <p className="banner" role="alert">{preferenceError}</p>}
      <div className="settings-options">
        <section className="pf-s" aria-label="Chat-Verhalten">
          <h2>Chat-Verhalten</h2>
          <label><input type="checkbox" checked={prefs.enterSends} onChange={(e) => update({ enterSends: e.target.checked })} />Enter sendet Nachrichten</label>
          <p className="hint">Wenn aus: Strg+Enter oder Cmd+Enter sendet. Umschalt+Enter erzeugt immer einen Zeilenumbruch.</p>
          <label><input type="checkbox" checked={prefs.autoScroll} onChange={(e) => update({ autoScroll: e.target.checked })} />Verlauf automatisch am Ende halten</label>
          <p className="hint">Nach manuellem Hochscrollen bleibt die Leseposition erhalten. Sessions lassen sich über ihr Menü anpinnen.</p>
          <label><input type="checkbox" checked={prefs.confirmApprovals} onChange={(e) => update({ confirmApprovals: e.target.checked })} />Freigaben vor dem Erlauben bestätigen</label>
          <p className="hint">Gilt auch in Inbox, Cockpit und Räumen. Abschalten erteilt keine automatische Freigabe.</p>
        </section>
        <section className="pf-s" aria-label="Anzeige">
          <h2>Anzeige</h2>
          <label><input type="checkbox" checked={prefs.compact} onChange={(e) => update({ compact: e.target.checked })} />Kompakte Listen</label>
          <label>Zeitformat <select className="field field-line" aria-label="Zeitformat" value={prefs.timeFormat} onChange={(e) => update({ timeFormat: e.target.value as Preferences["timeFormat"] })}><option value="24h">24 Stunden</option><option value="12h">12 Stunden</option></select></label>
          <label><input type="checkbox" checked={prefs.reducedMotion} onChange={(e) => update({ reducedMotion: e.target.checked })} />Bewegung reduzieren</label>
          <p className="hint">Animationen und Shader-Bewegung stoppen. Die Systemvorgabe hat immer Vorrang.</p>
        </section>
        <section className="pf-s" aria-label="Sitzungsvorgaben">
          <h2>Sitzungen</h2>
          <p className="hint">Denkaufwand und Arbeitsordner je Host. Profil-Konfigurationen auf dem Server werden nicht verändert.</p>
          {registry.error && <p role="alert">{registry.error}</p>}
          {registry.hosts?.map((h) => <HostSettings key={h.id} host={h.id} label={h.label} value={prefs.hosts[h.id] ?? { effort: "agent", workspace: "" }} onChange={(value) => update({ hosts: { ...prefs.hosts, [h.id]: value } })} />)}
        </section>
        <section className="pf-s" aria-label="Wartende Freigaben">
          <h2>Benachrichtigungen</h2>
          <label><input type="checkbox" checked={prefs.approvalDesktop} onChange={(e) => void desktop(e.target.checked)} />Desktop-Hinweis bei wartenden Freigaben</label>
          <label><input type="checkbox" checked={prefs.approvalSound} onChange={(e) => void sound(e.target.checked)} />Ton bei wartenden Freigaben</label>
          <button type="button" className="btn btn-s" onClick={() => void playNotice().catch((e: Error) => setPreferenceError(e.message))}>Testton abspielen</button>
          <p className="hint">Nur für Freigaben, die diese geöffnete WebUI erkennt. Desktop-Hinweise brauchen deine Browser-Erlaubnis; Ton kann nach einem Neuladen bis zum ersten Klick blockiert sein.</p>
        </section>
      </div>

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

      <section className="pf-s" aria-label="Mitteilungen">
        <h2 className="lbl">Mitteilungen</h2>
        <label className="row" style={{ gap: 8 }}>
          <input type="checkbox" checked={notify} onChange={(e) => { const next = e.target.checked; void store.setNotifications(next).then((granted) => setNotify(granted)); if (!next) setNotify(false); }} />
          <span>Bei Abschluss oder Fehler eines Runs melden (nur dieses Gerät, Opt-in)</span>
        </label>
        <p className="hint" style={{ margin: "8px 0 0" }}>Der Browser fragt einmal um Erlaubnis. Ohne Zustimmung bleibt die Meldung aus.</p>
      </section>
    </main>
  );
}
