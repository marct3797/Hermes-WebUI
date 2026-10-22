import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { sessionList } from "./chatReducer";
import { ApprovalCard, ClarifyCard, MessageView, ToolCard } from "./components/Items";
import { Composer } from "./components/Composer";
import { Sidebar } from "./components/Sidebar";
import { parseHash, toHash, type Route } from "./route";
import type { Profile, SessionSummary } from "./types";
import { useChat } from "./useChat";

const safeGet = (k: string) => { try { return localStorage.getItem(k) ?? undefined; } catch { return undefined; } };
const safeSet = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* privater Modus */ } };

function modelIds(payload: unknown): string[] {
  const list = (payload as { models?: unknown[] } | null)?.models ?? (Array.isArray(payload) ? payload : []);
  return list.map((m) => (typeof m === "string" ? m : String((m as { id?: unknown }).id ?? ""))).filter(Boolean);
}

export function App() {
  const [route, setRoute] = useState<Route>(() => parseHash(location.hash));
  const [profiles, setProfiles] = useState<Profile[]>();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [online, setOnline] = useState<{ ok: boolean; version?: string; error?: string }>({ ok: true });
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState<string>();
  const [menu, setMenu] = useState(false);
  const [loadError, setLoadError] = useState<string>();

  const navigate = useCallback((r: Route) => { location.hash = toHash(r); }, []);
  useEffect(() => {
    const on = () => setRoute(parseHash(location.hash));
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);

  useEffect(() => {
    api.profiles().then((r) => setProfiles(r.profiles)).catch((e: Error) => setLoadError(e.message));
  }, []);

  // Profil bestimmen: URL > zuletzt benutzt > erstes vorhandenes. Gelöschte Profile fallen so weg.
  const profile = profiles && (profiles.find((p) => p.name === route.profile)?.name
    ?? profiles.find((p) => p.name === safeGet("profile"))?.name ?? profiles[0]?.name);
  useEffect(() => {
    if (profile && profile !== route.profile) navigate({ profile, sessionId: route.sessionId });
    if (profile) safeSet("profile", profile);
  }, [profile, route.profile, route.sessionId, navigate]);

  const refreshSessions = useCallback(() => {
    if (!profile) return;
    api.sessions(profile).then((r) => setSessions(sessionList(r))).catch(() => setSessions([])).finally(() => setSessionsLoading(false));
  }, [profile]);

  useEffect(() => {
    if (!profile) return;
    setSessionsLoading(true);
    setSessions([]);
    setModel(undefined);
    setModels([]);
    refreshSessions();
    api.status(profile)
      .then((s) => setOnline({ ok: s.online, version: s.capabilities && typeof s.capabilities.version === "string" ? s.capabilities.version : undefined, error: s.error }))
      .catch((e: Error) => setOnline({ ok: false, error: e.message }));
    api.models(profile).then((m) => { const ids = modelIds(m); setModels(ids); }).catch(() => undefined);
  }, [profile, refreshSessions]);

  const chat = useChat({
    profile: profile ?? "", sessionId: route.sessionId, model,
    onSession: (id) => navigate({ profile, sessionId: id }),
    onRunEnd: refreshSessions,
  });
  const { state } = chat;
  const busy = state.runStatus === "starting" || state.runStatus === "running";

  // Automatisch mitscrollen, solange die Person nicht selbst nach oben gescrollt hat.
  const log = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const el = log.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [state.items, state.runStatus]);

  if (loadError) return <main className="center"><p className="error" role="alert">Profile konnten nicht geladen werden: {loadError}</p></main>;
  if (!profiles) return <main className="center"><p className="muted">Lade…</p></main>;
  if (!profile) return <main className="center"><p>Keine Profile konfiguriert. Lege <code className="mono">profiles.json</code> im Backend an.</p></main>;

  const title = sessions.find((s) => s.id === route.sessionId)?.title ?? "Neuer Chat";
  const tokens = state.usage ? (state.usage.input_tokens ?? 0) + (state.usage.output_tokens ?? 0) : undefined;

  return (
    <div className="app">
      <Sidebar
        profiles={profiles} profile={profile} sessions={sessions} activeId={route.sessionId} loading={sessionsLoading}
        onProfile={(name) => navigate({ profile: name })} onSelect={(id) => navigate({ profile, sessionId: id })}
        onNew={() => navigate({ profile })} open={menu} onClose={() => setMenu(false)}
      />
      <main className="chat">
        <header className="chat-head">
          <button type="button" className="ghost icon menu-btn" aria-label="Menü" onClick={() => setMenu(true)}>☰</button>
          <h1>{title}</h1>
          {models.length > 0 && (
            <select value={model ?? ""} onChange={(e) => setModel(e.target.value || undefined)} aria-label="Modell">
              <option value="">Standardmodell</option>
              {models.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          )}
          <span className={`pill ${online.ok ? "ok" : "bad"}`} role="status">
            <span className="dot" aria-hidden />{online.ok ? (online.version ? `Hermes ${online.version}` : "verbunden") : "offline"}
          </span>
        </header>

        {!online.ok && <p className="banner error" role="alert">Hermes ({profile}) ist nicht erreichbar{online.error ? `: ${online.error}` : ""}.</p>}

        <div className="log" role="log" aria-live="polite" ref={log}
          onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
          <div className="thread">
            {state.items.length === 0 && state.runStatus === "idle" && (
              <div className="empty"><h2>Wie kann Hermes helfen?</h2><p className="muted">Profil: {profiles.find((p) => p.name === profile)?.label}</p></div>
            )}
            {state.items.map((i) => {
              switch (i.kind) {
                case "message": return <MessageView key={i.id} m={i} />;
                case "tool": return <ToolCard key={i.id} t={i} />;
                case "approval": return <ApprovalCard key={i.id} a={i} disabled={!busy} onDecide={(d) => chat.decide(i.id, d, i.approvalId)} />;
                case "clarify": return <ClarifyCard key={i.id} c={i} onAnswer={(a) => chat.answer(i.id, a, i.clarifyId)} />;
              }
            })}
            {state.error && (
              <p className="banner error" role="alert">
                {state.error}
                {state.runStatus === "lost" && state.runId && <button type="button" className="ghost small" onClick={chat.reconnect}>Erneut verbinden</button>}
              </p>
            )}
          </div>
        </div>

        <footer className="dock">
          <Composer busy={busy} disabled={!online.ok} onSend={chat.send} onStop={chat.stop} />
          <div className="rail mono" aria-label="Status">
            <span>{{ idle: "bereit", starting: "startet…", running: "arbeitet…", done: "fertig", failed: "fehlgeschlagen", stopped: "gestoppt", lost: "getrennt" }[state.runStatus]}</span>
            {tokens != null && <span>{tokens.toLocaleString("de-DE")} Tokens</span>}
            <span>{profile}</span>
          </div>
        </footer>
      </main>
    </div>
  );
}
