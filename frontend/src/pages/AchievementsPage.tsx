import { useCallback, useEffect, useRef, useState } from "react";
import { hostApi, type AchScan, type Achievements } from "../p3Api";
import { useHosts } from "../hosts";
import { PageHead } from "../components/PageHead";
import { useAction } from "../components/useAction";
import { t } from "../i18n";

export function AchievementsPage({ host }: { host?: string }) {
  const { hosts } = useHosts();
  const [chosen, setChosen] = useState<string>();
  const selected = chosen ?? host ?? hosts?.[0]?.id;
  return (
    <main className="page">
      <PageHead title={t("Erfolge")} sub={t("Hermes-Achievements dieses Hosts")}>
        {hosts && hosts.length > 1 && <label>{t("Host")} <select aria-label={t("Host")} value={selected} onChange={(e) => setChosen(e.target.value)}>{hosts.map((h) => <option key={h.id} value={h.id}>{h.label}</option>)}</select></label>}
      </PageHead>
      {hosts && hosts.length === 0 && <p>{t("Keine Hosts konfiguriert.")}</p>}
      {selected && <Body key={selected} host={selected} />}
    </main>
  );
}

function Body({ host }: { host: string }) {
  const [a, setA] = useState<Achievements | null>(null);
  const [loadErr, setLoadErr] = useState("");
  const [typed, setTyped] = useState("");
  const { run, notes, busy } = useAction();
  const [scan, setScan] = useState<AchScan | null>(null);
  const [recent, setRecent] = useState<Achievements["items"]>([]);
  const [sid, setSid] = useState("");
  const sidRef = useRef("");
  sidRef.current = sid;
  const [badges, setBadges] = useState<Achievements["items"] | null>(null);
  const load = useCallback(async () => {
    setA(await hostApi.achievements(host));
    hostApi.achRecent(host).then((r) => setRecent(r.items), () => setRecent([]));
  }, [host]);
  useEffect(() => { load().catch((e) => setLoadErr((e as Error).message)); }, [load]);
  // Der erste Lauf über den ganzen Verlauf dauert: solange er läuft, nachfragen; beim Übergang laufend → fertig immer neu laden.
  const wasRunning = useRef(false);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true; let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = () => hostApi.achScan(host).then((s) => {
      if (!live) return;
      setScan(s);
      if (s.state === "running") { wasRunning.current = true; timer = setTimeout(poll, 3000); return; }
      if (wasRunning.current) { wasRunning.current = false; void load().catch(() => undefined); }
    }, () => undefined);
    void poll();
    return () => { live = false; if (timer) clearTimeout(timer); };
  }, [host, tick]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      {notes}
      {loadErr && <p className="banner" role="alert">{loadErr}</p>}
      {a && <>
        <p>{t("{unlocked} von {total} freigeschaltet, {discovered} entdeckt, {secret} geheim{is_stale}", { unlocked: a.unlocked, total: a.total, discovered: a.discovered, secret: a.secret, is_stale: a.is_stale ? t(". Die Werte sind veraltet, neu scannen aktualisiert sie.") : "." })}</p>
        {scan && <p className="muted" role="status">{scan.state === "running" ? t("Die Prüfung läuft gerade …") : scan.state === "failed" ? t("Die letzte Prüfung ist fehlgeschlagen: {why}", { why: scan.error ?? "" }) : t("Letzte Prüfung abgeschlossen ({n} Läufe).", { n: scan.runs })}</p>}
        {recent.length > 0 && <section aria-label={t("Zuletzt freigeschaltet")}><h2>{t("Zuletzt freigeschaltet")}</h2><ul>{recent.map((i) => <li key={i.id}><strong>{i.name}</strong>{i.tier ? ` (${i.tier})` : ""}</li>)}</ul></section>}
        <ul aria-label={t("Erfolge")}>{a.items.map((i) => (
          <li key={i.id}><strong>{i.name}</strong> {i.tier ? `(${i.tier}) ` : ""}{i.unlocked ? "freigeschaltet" : i.state === "secret" ? "geheim" : `${i.progress_pct} %`}<br />{i.description}</li>))}</ul>
        <button type="button" disabled={busy} onClick={() => void run(async () => { setA(await hostApi.achRescan(host)); setTick((n) => n + 1); })}>{t("Neu scannen")}</button>
        <section aria-label={t("Erfolge einer Sitzung")}>
          <h2>{t("Erfolge einer Sitzung")}</h2>
          <label>{t("Sitzungs-ID")} <input aria-label={t("Sitzungs-ID")} value={sid} onChange={(e) => { setSid(e.target.value); setBadges(null); }} /></label>
          <button type="button" disabled={busy || !/^[A-Za-z0-9_.:-]{1,128}$/.test(sid.trim())} onClick={() => void run(async () => { const asked = sid.trim(); const r = await hostApi.achBadges(host, asked); if (asked === sidRef.current.trim()) setBadges(r.items); })}>{t("Erfolge prüfen")}</button>
          {badges && (badges.length ? <ul aria-label={t("Erfolge dieser Sitzung")}>{badges.map((i) => <li key={i.id}>{i.name}</li>)}</ul> : <p role="status">{t("Diese Sitzung schaltet nichts frei.")}</p>)}
        </section>
        <label>{t("Zum Zurücksetzen „reset“ eintippen")} <input aria-label={t("Zurücksetzen bestätigen")} value={typed} onChange={(e) => setTyped(e.target.value)} /></label>
        <button type="button" disabled={busy || typed !== "reset"} onClick={() => void run(async () => { await hostApi.achReset(host); setTyped(""); await load(); })}>{t("Alle Freischaltungen zurücksetzen")}</button>
      </>}
    </>
  );
}
