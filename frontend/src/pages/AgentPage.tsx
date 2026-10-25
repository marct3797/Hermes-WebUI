import { agentKey, type Page } from "../router";
import { useAgentRef, useResolvedAgent } from "../hosts";
import { ChatPage } from "./ChatPage";
import { CapabilitiesPage } from "./CapabilitiesPage";
import { ConfigPage } from "./ConfigPage";
import { MessagingPage } from "./MessagingPage";
import { HermesMemoryPage } from "./HermesMemoryPage";
import { LifecyclePage } from "./LifecyclePage";
import ModelsPage from "./ModelsPage";
import EndpointsPage from "./EndpointsPage";
import SessionsAdminPage from "./SessionsAdminPage";
import AccessPage from "./AccessPage";
import VoicePage from "./VoicePage";
import LearningPage from "./LearningPage";
import InsightsPage from "./InsightsPage";
import { ProfilePage } from "./ProfilePage";
import { ProvidersPage } from "./ProvidersPage";
import { SoulPage } from "./SoulPage";
import { ModulePage, NotFoundPage } from "./Placeholders";
import { t } from "../i18n";

/** Seite eines Agents: löst Host/Runtime/Agent in der Registry auf und zeigt das gewählte Modul. */
export function AgentPage({ page }: { page: Extract<Page, { name: "agent" }> }) {
  const resolved = useResolvedAgent(page.ref);
  const agent = useAgentRef(page.ref);
  if (resolved === undefined || !agent) return <main className="page"><p className="muted">{t("Lade…")}</p></main>;
  if (resolved === null) {
    // Profile kommen und gehen: ein gelöschtes Profil zeigt einen klaren Hinweis statt Fehlern.
    return <NotFoundPage what={t("Der Agent „{agent}“ auf {host}", { agent: page.ref.agent, host: page.ref.host })} />;
  }
  if (page.module === "profil") return <ProfilePage key={agentKey(page.ref)} agent={agent} label={resolved.label} hostLabel={resolved.host.label} runtimeLabel={resolved.runtimeLabel} />;
  if (page.module === "modelle") return <ModelsPage key={agentKey(page.ref)} agent={agent} />;
  if (page.module === "endpunkte") return <EndpointsPage key={agentKey(page.ref)} agent={agent} />;
  if (page.module === "zugang") return <AccessPage key={agentKey(page.ref)} agent={agent} />;
  if (page.module === "sprache") return <VoicePage key={agentKey(page.ref)} agent={agent} />;
  if (page.module === "lerngraph") return <LearningPage key={agentKey(page.ref)} agent={agent} />;
  if (page.module === "einblicke") return <InsightsPage key={agentKey(page.ref)} agent={agent} />;
  if (page.module === "sitzungen-verwalten") return <SessionsAdminPage key={agentKey(page.ref)} agent={agent} />;
  if (page.module === "lebenszyklus") return <LifecyclePage key={agentKey(page.ref)} agent={agent} label={resolved.label} />;
  if (page.module === "providers") return <ProvidersPage key={agentKey(page.ref)} agent={agent} label={resolved.label} />;
  if (page.module === "config") return <ConfigPage key={agentKey(page.ref)} agent={agent} label={resolved.label} />;
  if (page.module === "hermes-memory") return <HermesMemoryPage key={agentKey(page.ref)} agent={agent} label={resolved.label} />;
  if (page.module === "messaging") return <MessagingPage key={agentKey(page.ref)} agent={agent} label={resolved.label} />;
  if (page.module === "soul") return <SoulPage key={agentKey(page.ref)} agent={agent} label={resolved.label} />;
  if (page.module === "skills" || page.module === "tools") return <CapabilitiesPage key={`${agentKey(page.ref)}/${page.module}`} agent={agent} label={resolved.label} module={page.module} />;
  if (page.module !== "chat") return <ModulePage module={page.module} />;
  return <ChatPage key={agentKey(page.ref)} agent={agent} label={resolved.label} runtimeLabel={resolved.runtimeLabel} sessionId={page.sessionId} />;
}
