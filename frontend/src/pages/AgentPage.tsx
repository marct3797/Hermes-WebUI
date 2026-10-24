import { agentKey, type Page } from "../router";
import { useAgentRef, useResolvedAgent } from "../hosts";
import { ChatPage } from "./ChatPage";
import { CapabilitiesPage } from "./CapabilitiesPage";
import { ConfigPage } from "./ConfigPage";
import { ProfilePage } from "./ProfilePage";
import { ProvidersPage } from "./ProvidersPage";
import { SoulPage } from "./SoulPage";
import { ModulePage, NotFoundPage } from "./Placeholders";

/** Seite eines Agents: löst Host/Runtime/Agent in der Registry auf und zeigt das gewählte Modul. */
export function AgentPage({ page }: { page: Extract<Page, { name: "agent" }> }) {
  const resolved = useResolvedAgent(page.ref);
  const agent = useAgentRef(page.ref);
  if (resolved === undefined || !agent) return <main className="page"><p className="muted">Lade…</p></main>;
  if (resolved === null) {
    // Profile kommen und gehen: ein gelöschtes Profil zeigt einen klaren Hinweis statt Fehlern.
    return <NotFoundPage what={`Der Agent „${page.ref.agent}“ auf ${page.ref.host}`} />;
  }
  if (page.module === "profil") return <ProfilePage key={agentKey(page.ref)} agent={agent} label={resolved.label} hostLabel={resolved.host.label} runtimeLabel={resolved.runtimeLabel} />;
  if (page.module === "providers") return <ProvidersPage key={agentKey(page.ref)} agent={agent} label={resolved.label} />;
  if (page.module === "config") return <ConfigPage key={agentKey(page.ref)} agent={agent} label={resolved.label} />;
  if (page.module === "soul") return <SoulPage key={agentKey(page.ref)} agent={agent} label={resolved.label} />;
  if (page.module === "skills" || page.module === "tools") return <CapabilitiesPage key={`${agentKey(page.ref)}/${page.module}`} agent={agent} label={resolved.label} module={page.module} />;
  if (page.module !== "chat") return <ModulePage module={page.module} />;
  return <ChatPage key={agentKey(page.ref)} agent={agent} label={resolved.label} runtimeLabel={resolved.runtimeLabel} sessionId={page.sessionId} />;
}
