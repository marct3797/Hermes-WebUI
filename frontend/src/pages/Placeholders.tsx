import { Link } from "../components/Link";
import { PageHead } from "../components/PageHead";
import { t } from "../i18n";

export function NotFoundPage({ what = t("Diese Seite") }: { what?: string }) {
  return (
    <main className="page">
      <PageHead title={t("Nicht gefunden")} />
      <div className="empty">
        <h2>{t("{what} gibt es nicht", { what })}</h2>
        <p className="muted"><Link to="/hosts" className="inline-link">{t("Zur Host-Übersicht")}</Link></p>
      </div>
    </main>
  );
}

export function ModulePage({ module }: { module: string }) {
  return (
    <main className="page">
      <PageHead title={module} />
      <div className="empty">
        <h2>{t("Dieses Modul folgt")}</h2>
        <p className="muted">{t("Je nach Runtime kommen weitere Module (Sessions, Memory, Skills …) in späteren Phasen.")}</p>
      </div>
    </main>
  );
}
