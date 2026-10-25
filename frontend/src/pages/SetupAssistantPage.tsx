import { Link } from "../components/Link";
import { PageHead } from "../components/PageHead";
import { useHosts } from "../hosts";
import { t } from "../i18n";

/** Geführte Ersteintrichtung im Browser (nach dem Terminal-Skript): Host prüfen, Anbieter verlinken, ersten Chat öffnen. Schreibt nichts selbst, verlinkt nur. */
export function SetupAssistantPage() {
  const { hosts, error } = useHosts();
  const first = hosts?.[0];
  const runtime = first?.runtimes?.[0];
  const agentId = runtime?.agents?.[0]?.id;
  const chatTo = first && runtime && agentId ? `/h/${first.id}/${runtime.id}/${agentId}` : "/";
  const hasHost = !!hosts && hosts.length > 0;
  const step = (n: number, title: string, text: string, done: boolean, to: string, label: string) => (
    <section className="card" aria-label={t("Schritt {n}", { n })}>
      <h2>{n}. {title} {done ? <span className="tag">{t("Erledigt")}</span> : <span className="tag">{t("Offen")}</span>}</h2>
      <p>{text}</p>
      <Link to={to} className="btn btn-s btn-p">{label}</Link>
    </section>
  );
  return (
    <main className="page">
      <PageHead title={t("Einrichtungsassistent")} sub={t("Schritt für Schritt zur ersten Antwort. Das Nötigste legt das Terminal-Skript an, den Rest führt dieser Assistent.")} />
      {error && <p className="banner" role="alert">{error}</p>}
      <div className="col" style={{ gap: 12 }}>
        {step(1, t("Host eintragen"), t("Die WebUI braucht mindestens einen Host mit Dashboard."), hasHost, "/hosts", t("Zu den Hosts"))}
        {step(2, t("Anbieter und Keys"), t("Hinterlege Anbieter-Schlüssel, damit die Modelle antworten."), false, "/providers", t("Zu den Anbietern"))}
        {step(3, t("Ersten Chat starten"), t("Wähle einen Agent und schreibe los."), false, chatTo, t("Chat starten"))}
      </div>
    </main>
  );
}
