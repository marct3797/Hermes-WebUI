import { useEffect, useRef, useState, type ReactNode } from "react";
import { ApiError, toLogin } from "../../api";
import { extApi } from "../../extApi";
import { useHosts } from "../../hosts";
import { useAsync } from "../../useAsync";
import { Icon } from "../Icon";

export const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Fehlerzeile; eine zu alte Anmeldung (Step-up) bekommt den Weg zur Neuanmeldung statt eines Rohtexts. */
export function Problem({ error }: { error?: unknown }) {
  if (!error) return null;
  if (error instanceof ApiError && error.code === "step_up_required") {
    return <p className="banner" role="alert"><Icon name="lock" /><span>Diese Änderung verlangt eine frische Anmeldung. <button type="button" className="linkish" onClick={() => toLogin(true)}>Erneut anmelden</button></span></p>;
  }
  return <p className="banner" role="alert"><Icon name="alert" /><span>{msg(error)}</span></p>;
}

export function Loading({ what }: { what: string }) {
  return <p className="muted small" role="status">{what} werden geladen…</p>;
}

export function Switch({ on, label, onChange, disabled }: { on: boolean; label: string; onChange: (next: boolean) => void; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} className={`ext-switch${on ? " on" : ""}`} onClick={() => onChange(!on)}>
      <span />
    </button>
  );
}

/** Nativer `<dialog>`; ohne `showModal` (Testumgebung) wird er nur geöffnet. */
export function Modal({ label, onClose, children, wide }: { label: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current!;
    if (typeof d.showModal === "function") d.showModal(); else d.setAttribute("open", "");
    return () => { if (typeof d.close === "function") d.close(); else d.removeAttribute("open"); };
  }, []);
  return (
    <dialog ref={ref} className={`kn-modal ext-modal${wide ? " wide" : ""}`} aria-label={label} onCancel={(e) => { e.preventDefault(); onClose(); }}>
      <div className="card">{children}</div>
    </dialog>
  );
}

export function Confirm({ title, children, yes, danger, onYes, onClose }: { title: string; children?: ReactNode; yes: string; danger?: boolean; onYes: () => Promise<unknown>; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const go = async () => {
    setBusy(true); setError(undefined);
    try { await onYes(); } catch (e) { setError(e); } finally { setBusy(false); }
  };
  return (
    <Modal label={title} onClose={() => { if (!busy) onClose(); }}>
      <h2>{title}</h2>
      {children}
      <Problem error={error} />
      <div className="row" style={{ gap: 8, justifyContent: "flex-end" }}>
        <button type="button" className="btn btn-s" disabled={busy} onClick={onClose}>Abbrechen</button>
        <button type="button" className={`btn btn-s ${danger ? "btn-d" : "btn-p"}`} disabled={busy} onClick={() => void go()}>{busy ? "Bitte warten…" : yes}</button>
      </div>
    </Modal>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange, label }: { tabs: [T, string][]; value: T; onChange: (t: T) => void; label: string }) {
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {tabs.map(([id, text]) => (
        <button key={id} type="button" role="tab" aria-selected={value === id} className={`tab${value === id ? " on" : ""}`} onClick={() => onChange(id)}>{text}</button>
      ))}
    </div>
  );
}

export type Scope = { host: string; profile: string };

/** Host und Profil für Erweiterungen; die Profile kommen vom Host (Dashboard oder Host-Dienst). */
export function useScope(hostProp?: string) {
  const { hosts } = useHosts();
  const [chosen, setHost] = useState(hostProp);
  const host = chosen ?? hostProp ?? hosts?.[0]?.id ?? "";
  const [picked, setProfile] = useState<string>();
  const list = useAsync(() => (host ? extApi.profiles(host) : Promise.resolve({ profiles: [] })), [host]);
  const profiles = (list.data?.profiles ?? []).map((p) => p.id);
  const profile = picked && profiles.includes(picked) ? picked : profiles.includes("default") ? "default" : profiles[0] ?? "";
  return { hosts: hosts ?? [], host, setHost, profiles, profile, setProfile, loading: list.loading, error: list.error };
}

export function ScopeBar({ s, profile = true }: { s: ReturnType<typeof useScope>; profile?: boolean }) {
  return (
    <div className="ext-scope row" style={{ gap: 12, flexWrap: "wrap" }}>
      <label className="row small" style={{ gap: 6 }}>Host
        <select className="field field-line" style={{ width: "auto", minWidth: 120 }} value={s.host} onChange={(e) => s.setHost(e.target.value)} aria-label="Host">
          {s.hosts.map((h) => <option key={h.id} value={h.id}>{h.label}</option>)}
        </select>
      </label>
      {profile && (
        <label className="row small" style={{ gap: 6 }}>Profil
          <select className="field field-line" style={{ width: "auto", minWidth: 120 }} value={s.profile} onChange={(e) => s.setProfile(e.target.value)} aria-label="Profil" disabled={!s.profiles.length}>
            {s.profiles.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
      )}
    </div>
  );
}

export function SearchBox({ value, onChange, label, placeholder }: { value: string; onChange: (v: string) => void; label: string; placeholder?: string }) {
  return (
    <label className="search" style={{ maxWidth: 420, flex: "1 1 260px", minWidth: 240 }}>
      <Icon name="search" />
      <input type="search" value={value} placeholder={placeholder ?? label} aria-label={label} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

export const TRUST: Record<string, string> = { builtin: "Offiziell", trusted: "Vertrauenswürdig", community: "Community" };
export const Pill = ({ children, tone }: { children: ReactNode; tone?: "ok" | "warn" | "bad" }) => <span className={`ext-pill${tone ? ` ${tone}` : ""}`}>{children}</span>;
