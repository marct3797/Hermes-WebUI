import { useCallback, useEffect, useState } from "react";
import { hostApi, type Achievements } from "../p3Api";
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
  const load = useCallback(async () => setA(await hostApi.achievements(host)), [host]);
  useEffect(() => { load().catch((e) => setLoadErr((e as Error).message)); }, [load]);
  return (
    <>
      {notes}
      {loadErr && <p className="banner" role="alert">{loadErr}</p>}
      {a && <>
        <p>{t("{unlocked} von {total} freigeschaltet, {discovered} entdeckt, {secret} geheim{is_stale}", { unlocked: a.unlocked, total: a.total, discovered: a.discovered, secret: a.secret, is_stale: a.is_stale ? t(". Die Werte sind veraltet, neu scannen aktualisiert sie.") : "." })}</p>
        <ul aria-label={t("Erfolge")}>{a.items.map((i) => (
          <li key={i.id}><strong>{i.name}</strong> {i.tier ? `(${i.tier}) ` : ""}{i.unlocked ? "freigeschaltet" : i.state === "secret" ? "geheim" : `${i.progress_pct} %`}<br />{i.description}</li>))}</ul>
        <button type="button" disabled={busy} onClick={() => void run(async () => setA(await hostApi.achRescan(host)))}>{t("Neu scannen")}</button>
        <label>{t("Zum Zurücksetzen „reset“ eintippen")} <input aria-label={t("Zurücksetzen bestätigen")} value={typed} onChange={(e) => setTyped(e.target.value)} /></label>
        <button type="button" disabled={busy || typed !== "reset"} onClick={() => void run(async () => { await hostApi.achReset(host); setTyped(""); await load(); })}>{t("Alle Freischaltungen zurücksetzen")}</button>
      </>}
    </>
  );
}
