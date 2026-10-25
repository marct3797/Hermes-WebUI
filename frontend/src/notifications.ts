import { getPreferences } from "./preferences";
import { t } from "./i18n";

let audio: AudioContext | undefined;
export async function playNotice() {
  if (typeof AudioContext === "undefined") throw new Error(t("Dieser Browser unterstützt den Hinweiston nicht."));
  audio ??= new AudioContext();
  await audio.resume();
  if (audio.state !== "running") throw new Error(t("Der Browser blockiert Ton. Bitte den Testton hier einmal freigeben."));
  const tone = audio.createOscillator(), gain = audio.createGain();
  tone.frequency.value = 660;
  gain.gain.setValueAtTime(0.08, audio.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.2);
  tone.connect(gain); gain.connect(audio.destination);
  tone.onended = () => { tone.disconnect(); gain.disconnect(); };
  tone.start(); tone.stop(audio.currentTime + 0.2);
}
export function notifyApproval() {
  const prefs = getPreferences();
  if (prefs.approvalDesktop && typeof Notification !== "undefined" && Notification.permission === "granted") {
    try { new Notification("Hermes: Freigabe wartet", { body: t("Eine Aktion benötigt deine Entscheidung. Öffne die Inbox.") }); } catch { /* Plattform unterstützt keine Desktop-Mitteilungen */ }
  }
  if (prefs.approvalSound) void playNotice().catch(() => undefined); // Testton in den Einstellungen zeigt Browser-Sperren.
}
