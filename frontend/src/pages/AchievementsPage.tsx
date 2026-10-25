import { useCallback, useEffect, useState } from "react";
import { hostApi, type Achievements } from "../p3Api";
import { useHosts } from "../hosts";
import { PageHead } from "../components/PageHead";
import { useAction } from "../components/useAction";

export function AchievementsPage({ host }: { host?: string }) {
  const { hosts } = useHosts();
  const [chosen, setChosen] = useState<string>();
  const selected = chosen ?? host ?? hosts?.[0]?.id;
  return (
    <main className="page">
      <PageHead title="Erfolge" sub="Hermes-Achievements dieses Hosts">
        {hosts && hosts.length > 1 && <label>Host <select aria-label="Host" value={selected} onChange={(e) => setChosen(e.target.value)}>{hosts.map((h) => <option key={h.id} value={h.id}>{h.label}</option>)}</select></label>}
      </PageHead>
      {hosts && hosts.length === 0 && <p>Keine Hosts konfiguriert.</p>}
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
        <p>{a.unlocked} von {a.total} freigeschaltet, {a.discovered} entdeckt, {a.secret} geheim{a.is_stale ? ". Die Werte sind veraltet, neu scannen aktualisiert sie." : "."}</p>
        <ul aria-label="Erfolge">{a.items.map((i) => (
          <li key={i.id}><strong>{i.name}</strong> {i.tier ? `(${i.tier}) ` : ""}{i.unlocked ? "freigeschaltet" : i.state === "secret" ? "geheim" : `${i.progress_pct} %`}<br />{i.description}</li>))}</ul>
        <button type="button" disabled={busy} onClick={() => void run(async () => setA(await hostApi.achRescan(host)))}>Neu scannen</button>
        <label>Zum Zurücksetzen „reset“ eintippen <input aria-label="Zurücksetzen bestätigen" value={typed} onChange={(e) => setTyped(e.target.value)} /></label>
        <button type="button" disabled={busy || typed !== "reset"} onClick={() => void run(async () => { await hostApi.achReset(host); setTyped(""); await load(); })}>Alle Freischaltungen zurücksetzen</button>
      </>}
    </>
  );
}
