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
import { t } from "../i18n";
import { LanguageSelect } from "../components/LanguageSelect";

function HostSettings({ host, label, value, onChange }: { host: string; label: string; value: HostDefaults; onChange: (v: HostDefaults) => void }) {
  const ws = useAsync(() => composerApi.workspaces(host), [host]);
  return <fieldset className="settings-host">
    <legend>{label}</legend>
    <label>{t("Denkaufwand")} <select className="field field-line" aria-label={t("Denkaufwand für {host}", { host })} value={value.effort} onChange={(e) => onChange({ ...value, effort: e.target.value as HostDefaults["effort"] })}>
      <option value="agent">{t("Standard des Agents")}</option><option value="off">{t("Aus")}</option>
      {EFFORTS.map((e) => <option key={e.value} value={e.value}>{e.label}</option>)}
    </select></label>
    <label>{t("Arbeitsordner")} <select className="field field-line" aria-label={t("Standard-Arbeitsordner für {host}", { host })} value={value.workspace} disabled={!ws.data} onChange={(e) => onChange({ ...value, workspace: e.target.value })}>
      <option value="">{t("Keine Vorgabe")}</option>
      {value.workspace && !ws.data?.workspaces.some((w) => w.id === value.workspace) && <option value={value.workspace}>{t("Nicht verfügbar: {workspace}", { workspace: value.workspace })}</option>}
      {ws.data?.workspaces.map((w) => <option key={w.id} value={w.id}>{w.label}</option>)}
    </select></label>
    {ws.error && <p className="hint" role="status">{t("Arbeitsordner nicht ladbar: {error}", { error: ws.error })}</p>}
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
    catch { setPreferenceError(t("Der Browser erlaubt das Speichern dieser Einstellungen nicht.")); }
  };
  const desktop = async (on: boolean) => {
    if (!on) { update({ approvalDesktop: false }); return; }
    try {
      if (typeof Notification === "undefined") throw new Error(t("Dieser Browser unterstützt keine Desktop-Mitteilungen."));
      const permission = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
      update({ approvalDesktop: permission === "granted" });
      if (permission !== "granted") setPreferenceError(t("Desktop-Mitteilungen sind im Browser nicht erlaubt."));
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
      <PageHead title={t("Darstellung")} sub={t("Einstellungen für dieses Gerät")} />
      <p className="hint">{t("Änderungen gelten sofort in diesem Browser. Host-Vorgaben gelten für neue Chats und die Terminal-Auswahl; eine eigene Auswahl im Chat bleibt vorrangig.")}</p>
      {preferenceError && <p className="banner" role="alert">{preferenceError}</p>}
      <div className="settings-options">
        <LanguageSelect />
        <section className="pf-s" aria-label={t("Chat-Verhalten")}>
          <h2>{t("Chat-Verhalten")}</h2>
          <label><input type="checkbox" checked={prefs.enterSends} onChange={(e) => update({ enterSends: e.target.checked })} />{t("Enter sendet Nachrichten")}</label>
          <p className="hint">{t("Wenn aus: Strg+Enter oder Cmd+Enter sendet. Umschalt+Enter erzeugt immer einen Zeilenumbruch.")}</p>
          <label><input type="checkbox" checked={prefs.autoScroll} onChange={(e) => update({ autoScroll: e.target.checked })} />{t("Verlauf automatisch am Ende halten")}</label>
          <p className="hint">{t("Nach manuellem Hochscrollen bleibt die Leseposition erhalten. Sessions lassen sich über ihr Menü anpinnen.")}</p>
          <label><input type="checkbox" checked={prefs.confirmApprovals} onChange={(e) => update({ confirmApprovals: e.target.checked })} />{t("Freigaben vor dem Erlauben bestätigen")}</label>
          <p className="hint">{t("Gilt auch in Inbox, Cockpit und Räumen. Abschalten erteilt keine automatische Freigabe.")}</p>
        </section>
        <section className="pf-s" aria-label={t("Anzeige")}>
          <h2>{t("Anzeige")}</h2>
          <label><input type="checkbox" checked={prefs.compact} onChange={(e) => update({ compact: e.target.checked })} />{t("Kompakte Listen")}</label>
          <label>{t("Zeitformat")} <select className="field field-line" aria-label={t("Zeitformat")} value={prefs.timeFormat} onChange={(e) => update({ timeFormat: e.target.value as Preferences["timeFormat"] })}><option value="24h">{t("24 Stunden")}</option><option value="12h">{t("12 Stunden")}</option></select></label>
          <label><input type="checkbox" checked={prefs.reducedMotion} onChange={(e) => update({ reducedMotion: e.target.checked })} />{t("Bewegung reduzieren")}</label>
          <p className="hint">{t("Animationen und Shader-Bewegung stoppen. Die Systemvorgabe hat immer Vorrang.")}</p>
        </section>
        <section className="pf-s" aria-label={t("Sitzungsvorgaben")}>
          <h2>{t("Sitzungen")}</h2>
          <p className="hint">{t("Denkaufwand und Arbeitsordner je Host. Profil-Konfigurationen auf dem Server werden nicht verändert.")}</p>
          {registry.error && <p role="alert">{registry.error}</p>}
          {registry.hosts?.map((h) => <HostSettings key={h.id} host={h.id} label={h.label} value={prefs.hosts[h.id] ?? { effort: "agent", workspace: "" }} onChange={(value) => update({ hosts: { ...prefs.hosts, [h.id]: value } })} />)}
        </section>
        <section className="pf-s" aria-label={t("Wartende Freigaben")}>
          <h2>{t("Benachrichtigungen")}</h2>
          <label><input type="checkbox" checked={prefs.approvalDesktop} onChange={(e) => void desktop(e.target.checked)} />{t("Desktop-Hinweis bei wartenden Freigaben")}</label>
          <label><input type="checkbox" checked={prefs.approvalSound} onChange={(e) => void sound(e.target.checked)} />{t("Ton bei wartenden Freigaben")}</label>
          <button type="button" className="btn btn-s" onClick={() => void playNotice().catch((e: Error) => setPreferenceError(e.message))}>{t("Testton abspielen")}</button>
          <p className="hint">{t("Nur für Freigaben, die diese geöffnete WebUI erkennt. Desktop-Hinweise brauchen deine Browser-Erlaubnis; Ton kann nach einem Neuladen bis zum ersten Klick blockiert sein.")}</p>
        </section>
      </div>

      <section className="pf-s" aria-label={t("Hintergrund-Shader")}>
        <p className="muted small" style={{ margin: 0, maxWidth: 640 }}>
          {t("Ein ruhiger Verlauf hinter allen Kacheln. Er läuft auf Cockpit, Inbox, Chat und Profil. Die Kacheln sind deckend, der Shader scheint nur in den Zwischenräumen und am Rand durch, so bleibt Text immer lesbar.")}
        </p>
        <div className="sh-bar">
          <button type="button" className={`btn ${shader.enabled ? "btn-p" : ""}`} aria-pressed={shader.enabled}
            onClick={() => setLocalShader({ enabled: !shader.enabled })}>
            <Icon name={shader.enabled ? "stop" : "play"} size={14} />{shader.enabled ? t("Shader an") : t("Shader aus")}
          </button>
          <label className="sh-ctl">
            <span className="lbl">{t("Stärke ·")} <b>{dec(shader.strength)}</b></span>
            <input type="range" className="pf-range" min={0} max={3} step={0.1} value={shader.strength} disabled={!shader.enabled}
              aria-label={t("Stärke")} onChange={(e) => setLocalShader({ strength: Number(e.target.value) })} />
          </label>
          <label className="sh-ctl">
            <span className="lbl">{t("Tempo ·")} <b>{dec(shader.speed)}</b></span>
            <input type="range" className="pf-range" min={0} max={3} step={0.1} value={shader.speed} disabled={!shader.enabled}
              aria-label={t("Tempo")} onChange={(e) => setLocalShader({ speed: Number(e.target.value) })} />
          </label>
        </div>

        <p className="hint" style={{ margin: 0 }}>
          {t("Vorgabe der WebUI: {enabled}.{overridden}", { enabled: serverShader.enabled ? t("Stärke {strength} · Tempo {speed}", { strength: dec(serverShader.strength), speed: dec(serverShader.speed) }) : "aus", overridden: overridden ? t(" Auf diesem Gerät gilt eine eigene Einstellung.") : "" })}</p>
        {reduce && <p className="hint crimt" role="status" style={{ margin: 0 }}>{t("„Bewegung reduzieren“ ist im System an: der Shader steht still.")}</p>}
        {narrow && <p className="hint" role="status" style={{ margin: 0 }}>{t("Auf schmalen Schirmen ist der Shader aus, um den Akku zu schonen.")}</p>}

        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <button type="button" className="btn btn-s" disabled={!overridden} onClick={() => { resetLocalShader(); setSaved(false); }}>
            <Icon name="refresh" size={14} />{t("Auf Vorgabe zurücksetzen")}
          </button>
          <button type="button" className="btn btn-s" disabled={busy || !writable || same} onClick={() => void saveDefault()}
            title={writable ? undefined : (writeError ?? undefined)}>
            <Icon name="check" size={14} />{t("Als Vorgabe für alle Geräte speichern")}
          </button>
          {saved && <span className="hint crimt" role="status">{t("Gespeichert")}</span>}
        </div>
        {!writable && <p className="hint" style={{ margin: 0 }}>{t("{writeError} Trage sie in der ui.json unter ui.backgroundShader ein.", { writeError: writeError ?? t("Die Vorgabe lässt sich hier nicht speichern.") })}</p>}
        {error && <p className="banner" role="alert"><Icon name="alert" /><span>{error}</span></p>}
      </section>

      <section className="pf-s" aria-label={t("Mitteilungen")}>
        <h2 className="lbl">{t("Mitteilungen")}</h2>
        <label className="row" style={{ gap: 8 }}>
          <input type="checkbox" checked={notify} onChange={(e) => { const next = e.target.checked; void store.setNotifications(next).then((granted) => setNotify(granted)); if (!next) setNotify(false); }} />
          <span>{t("Bei Abschluss oder Fehler eines Runs melden (nur dieses Gerät, Opt-in)")}</span>
        </label>
        <p className="hint" style={{ margin: "8px 0 0" }}>{t("Der Browser fragt einmal um Erlaubnis. Ohne Zustimmung bleibt die Meldung aus.")}</p>
      </section>
    </main>
  );
}
