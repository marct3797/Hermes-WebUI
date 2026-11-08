import { api } from "../api";
import { Icon } from "../components/Icon";
import { PageHead } from "../components/PageHead";
import { ProfileSettings } from "../components/soul/ProfileSettings";
import { SoulEditor } from "../components/soul/SoulEditor";
import type { AgentRef } from "../types";
import { useAsync } from "../useAsync";
import { t } from "../i18n";

const SNIPPET = `"runtimes": [{ "id": "hermes", …,
  "dashboard": { "base_url": "http://127.0.0.1:9122" } }]`;

/** SOUL.md und Profil-Einstellungen eines Hermes-Agents. Beides liegt im Dashboard der Maschine, nicht in der Agent-API. */
export function SoulPage({ agent, label }: { agent: AgentRef; label: string }) {
  const status = useAsync(() => api.dashboard(agent), [agent.host, agent.runtime, agent.agent]);
  const info = status.data;
  return (
    <main className="page">
      <PageHead title={t("SOUL & Profil")} sub={label} />
      {status.loading && <p className="muted">{t("Lade…")}</p>}
      {status.error && <p className="banner" role="alert"><Icon name="alert" /><span>{t("Status nicht ladbar: {error}", { error: status.error })}</span></p>}
      {info && !info.available && (
        <section className="card soul-off" aria-label={t("Dashboard nicht angebunden")}>
          <h2>{t("Dashboard nicht angebunden")}</h2>
          <p className="muted">{info.reason}</p>
          <p>{t("Die SOUL liegt im Profilordner des Agents. Die Agent-API kommt dort nicht heran, das Dashboard von Hermes schon. Starte es auf dem Rechner des Agents und trage es in der Host-Config ein:")}</p>
          <pre className="soul-code">{SNIPPET}</pre>
          <p className="hint">{t("Genaue Schritte stehen in der README unter „Dashboard“.")}</p>
        </section>
      )}
      {info?.available && !info.profile && (
        <p className="banner" role="alert"><Icon name="alert" /><span>{t("{reason} Prüfe, ob der Ordnername „{agent}“ dort existiert.", { reason: info.reason ?? t("Das Dashboard kennt dieses Profil nicht."), agent: agent.agent })}</span></p>
      )}
      {info?.available && info.profile && (
        <div className="soul-grid">
          <SoulLoader agent={agent} label={label} />
          <ProfileSettings agent={agent} profile={info.profile} />
        </div>
      )}
    </main>
  );
}

function SoulLoader({ agent, label }: { agent: AgentRef; label: string }) {
  const soul = useAsync(() => api.soul(agent), [agent.host, agent.runtime, agent.agent]);
  if (soul.loading) return <p className="muted">{t("Lade SOUL…")}</p>;
  if (soul.error || !soul.data) return <p className="banner" role="alert"><Icon name="alert" /><span>{t("SOUL.md nicht ladbar: {error}", { error: soul.error })}</span></p>;
  return <SoulEditor agent={agent} label={label} initial={soul.data} />;
}
