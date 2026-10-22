import type { Profile, SessionSummary } from "../types";

type Props = {
  profiles: Profile[]; profile: string; sessions: SessionSummary[]; activeId?: string; loading: boolean;
  onProfile: (name: string) => void; onSelect: (id: string) => void; onNew: () => void; open: boolean; onClose: () => void;
};

export function Sidebar(p: Props) {
  return (
    <>
      {p.open && <div className="scrim" onClick={p.onClose} aria-hidden />}
      <aside className={`sidebar${p.open ? " open" : ""}`} aria-label="Navigation">
        <div className="brand"><span className="mono">HERMES</span></div>
        <label className="field">
          <span className="muted small">Profil</span>
          <select value={p.profile} onChange={(e) => p.onProfile(e.target.value)} aria-label="Profil wählen">
            {p.profiles.map((x) => <option key={x.name} value={x.name}>{x.label}</option>)}
          </select>
        </label>
        <button type="button" className="primary wide" onClick={() => { p.onNew(); p.onClose(); }}>Neuer Chat</button>
        <nav aria-label="Sessions" className="sessions">
          {p.loading && <p className="muted small">Lade…</p>}
          {!p.loading && p.sessions.length === 0 && <p className="muted small">Noch keine Sessions.</p>}
          {p.sessions.map((s) => (
            <button key={s.id} type="button" className={`session${s.id === p.activeId ? " active" : ""}`} aria-current={s.id === p.activeId ? "page" : undefined}
              onClick={() => { p.onSelect(s.id); p.onClose(); }}>
              <span className="title">{s.title}</span>
              {s.source && s.source !== "chat" && <span className="mono tag">{s.source}</span>}
            </button>
          ))}
        </nav>
      </aside>
    </>
  );
}
