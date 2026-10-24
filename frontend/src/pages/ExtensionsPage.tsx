import { useState, type ReactNode } from "react";
import { PageHead } from "../components/PageHead";
import { Loading, Problem, ScopeBar, Tabs, useScope, type Scope } from "../components/extensions/common";
import { McpPanel } from "../components/extensions/McpPanel";
import { PluginsPanel } from "../components/extensions/PluginsPanel";
import { SkillsPanel } from "../components/extensions/SkillsPanel";

type Tab = "skills" | "mcp" | "plugins";

/** Rahmen für beide Seiten: Ladezustand und der ehrliche Hinweis, wenn der Host keine Profile liefert. */
export function ScopedBody({ s, children }: { s: ReturnType<typeof useScope>; children: (scope: Scope) => ReactNode }) {
  if (s.error) return <Problem error={new Error(s.error)} />;
  if (!s.host) return <div className="empty"><h2>Kein Host eingerichtet</h2><p className="muted">Trage einen Host in der hosts.json ein.</p></div>;
  if (s.loading) return <Loading what="Profile" />;
  if (!s.profile) return <div className="empty"><h2>Keine Profile</h2><p className="muted">Dieser Host meldet keine Hermes-Profile. Prüfe, ob das Dashboard erreichbar ist.</p></div>;
  return <>{children({ host: s.host, profile: s.profile })}</>;
}

export function ExtensionsPage({ host }: { host?: string }) {
  const s = useScope(host);
  const [tab, setTab] = useState<Tab>("skills");
  return (
    <main className="page ext-page">
      <PageHead title="Erweiterungen" sub="Skills, MCP-Server und Plugins verwalten"><ScopeBar s={s} profile={tab !== "plugins"} /></PageHead>
      <Tabs label="Bereich" value={tab} onChange={setTab} tabs={[["skills", "Skills"], ["mcp", "MCP"], ["plugins", "Plugins"]]} />
      <ScopedBody s={s}>
        {(scope) => tab === "skills" ? <SkillsPanel scope={scope} /> : tab === "mcp" ? <McpPanel scope={scope} /> : <PluginsPanel scope={scope} />}
      </ScopedBody>
    </main>
  );
}
