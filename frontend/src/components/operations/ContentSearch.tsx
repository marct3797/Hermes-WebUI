import { useState } from "react";
import { useAsync } from "../../useAsync";
import { agentPath } from "../../router";
import { enc, operationsHttp, type Availability } from "./http";
import { t } from "../../i18n";

type Results = Omit<Availability, "warnings"> & { warnings?: (string | { host: string; reason: string })[]; results: { host: string; profile: string; session_id: string; title: string; snippet: string }[] };
export function ContentSearch() {
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const [revision, setRevision] = useState(0);
  const result = useAsync(() => query ? operationsHttp<Results>(`/bff/search?q=${enc(query)}`) : Promise.resolve(undefined), [query, revision]);
  const valid = result.data && Array.isArray(result.data.results);
  return <>
    <form role="search" className="ops-toolbar" onSubmit={e => { e.preventDefault(); if (input.trim()) { setQuery(input.trim()); setRevision(v => v + 1); } }}>
      <label className="ops-grow">{t("Sitzungsinhalte durchsuchen")}<input className="field" type="search" aria-label={t("Sitzungsinhalte durchsuchen")} value={input} maxLength={200} onChange={e => setInput(e.target.value)} /></label>
      <button className="btn" disabled={!input.trim() || result.loading}>{t("Suchen")}</button>
    </form>
    {!query && <p className="muted">{t("Durchsucht echte Sitzungsinhalte auf den konfigurierten Hosts.")}</p>}
    {query && result.loading && <p role="status">{t("Suche läuft…")}</p>}
    {result.error && <p className="banner" role="alert">{result.error}</p>}
    {result.data && !valid && <p role="alert">{t("Antwortformat nicht unterstützt.")}</p>}
    {result.data?.warnings?.map((warning, i) => <p className="banner" key={i}>{typeof warning === "string" ? warning : <><strong>{warning.host}: </strong><span>{warning.reason}</span></>}</p>)}
    {result.data?.truncated && <p role="status">{t("Ergebnisse gekürzt. Bitte Suche eingrenzen.")}</p>}
    {valid && result.data!.results.length === 0 && <p className="empty">{t("Keine Sitzungen gefunden.")}</p>}
    {valid && <ul className="ops-list">{result.data!.results.map((item, i) => <li className="card ops-card" key={`${item.host}/${item.profile}/${item.session_id}/${i}`}>
      <a href={agentPath({ host: item.host, runtime: "hermes", agent: item.profile }, "chat", item.session_id)}>{item.title || item.session_id}</a>
      <p className="muted small">{item.host} · {item.profile}</p><p className="ops-text">{item.snippet}</p>
    </li>)}</ul>}
  </>;
}
