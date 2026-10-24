import { useState } from "react";
import { PageHead } from "../components/PageHead";
import { ScopeBar, Tabs, useScope } from "../components/extensions/common";
import { McpMarket, PluginMarket, SourcesPanel } from "../components/market/Market";
import { SkillMarket } from "../components/market/SkillMarket";
import { ScopedBody } from "./ExtensionsPage";

type Tab = "skills" | "mcp" | "plugins" | "sources";

export function MarketplacePage({ host }: { host?: string }) {
  const s = useScope(host);
  const [tab, setTab] = useState<Tab>("skills");
  return (
    <main className="page ext-page">
      <PageHead title="Marktplatz" sub="Suchen, prüfen und direkt installieren"><ScopeBar s={s} profile={tab !== "plugins"} /></PageHead>
      <Tabs label="Bereich" value={tab} onChange={setTab} tabs={[["skills", "Skills"], ["mcp", "MCP-Connectoren"], ["plugins", "Plugins"], ["sources", "Quellen"]]} />
      <ScopedBody s={s}>
        {(scope) => tab === "skills" ? <SkillMarket host={scope.host} profile={scope.profile} profiles={s.profiles} />
          : tab === "mcp" ? <McpMarket scope={scope} /> : tab === "plugins" ? <PluginMarket scope={scope} /> : <SourcesPanel scope={scope} />}
      </ScopedBody>
    </main>
  );
}
