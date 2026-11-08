import { useMemo, useState } from "react";
import { api } from "../api";
import { Icon } from "../components/Icon";
import { Link } from "../components/Link";
import { PageHead } from "../components/PageHead";
import { MemberStack } from "../components/rooms/Parts";
import { fmtAgo, plainPreview } from "../format";
import { useHosts } from "../hosts";
import { navigate } from "../router";
import type { AgentRef, Room } from "../types";
import { useAsync } from "../useAsync";
import { t } from "../i18n";

const MAX = 6;
const keyOf = (a: AgentRef) => `${a.host}/${a.runtime}/${a.agent}`;

function NewRoom({ onDone, onCancel }: { onDone: (r: Room) => void; onCancel: () => void }) {
  const { hosts } = useHosts();
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<AgentRef[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const options = useMemo(() => (hosts ?? []).flatMap((h) => h.runtimes.filter((r) => r.status === "online").flatMap((r) =>
    r.agents.map((a) => ({ ref: { host: h.id, runtime: r.id, agent: a.id }, label: a.label, where: `${h.label} · ${r.label}` })))), [hosts]);
  const toggle = (ref: AgentRef) => setPicked((cur) => (cur.some((p) => keyOf(p) === keyOf(ref)) ? cur.filter((p) => keyOf(p) !== keyOf(ref)) : [...cur, ref]));
  const ok = name.trim().length > 0 && picked.length >= 2 && picked.length <= MAX;

  const create = async () => {
    setBusy(true);
    setError(undefined);
    try { onDone(await api.createRoom(name.trim(), picked)); } catch (e) { setError((e as Error).message); setBusy(false); }
  };

  return (
    <form className="card newroom" onSubmit={(e) => { e.preventDefault(); if (ok) void create(); }} aria-label={t("Neuer Raum")}>
      <header className="card-h"><h2>{t("Neuer Raum")}</h2></header>
      <div className="wrow">
        <label className="col" style={{ gap: 4 }}>
          <span className="lbl">{t("Name")}</span>
          <input className="field field-line" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder={t("z. B. Planungsrunde")} />
        </label>
        <fieldset className="pick">
          <legend className="lbl">{t("Mitglieder ({v} von 2 bis {MAX})", { v: picked.length, MAX })}</legend>
          {options.length === 0 && <p className="muted small">{t("Keine erreichbaren Agents.")}</p>}
          {options.map((o) => {
            const on = picked.some((p) => keyOf(p) === keyOf(o.ref));
            return (
              <label key={keyOf(o.ref)} className="row pickrow">
                <input type="checkbox" checked={on} disabled={!on && picked.length >= MAX} onChange={() => toggle(o.ref)} />
                <span>{o.label}</span><span className="muted small">{o.where}</span>
              </label>
            );
          })}
        </fieldset>
        {error && <p className="error small" role="alert">{error}</p>}
        <div className="row" style={{ gap: 8 }}>
          <button type="submit" className="btn btn-p" disabled={!ok || busy}>{busy ? t("Lege an…") : t("Raum anlegen")}</button>
          <button type="button" className="btn btn-g" onClick={onCancel}>{t("Abbrechen")}</button>
        </div>
      </div>
    </form>
  );
}

/** Gruppenchats: mehrere Agents in einem Gespräch. Die Räume liegen im BFF, die Mitglieder laufen als normale Runs. */
export function RoomsPage() {
  const [archived, setArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const list = useAsync(() => api.rooms(archived), [archived]);
  const rooms = list.data?.rooms ?? [];
  const waiting = rooms.filter((r) => r.needs_user).length;

  return (
    <main className="page">
      <PageHead title={t("Räume")} sub={list.data ? `${rooms.length} ${archived ? "archiviert" : t("aktiv")}${waiting ? ` · ${waiting} brauchen dich` : ""}` : undefined}>
        <button type="button" className="btn btn-s btn-g" aria-pressed={archived} onClick={() => setArchived(!archived)}>{archived ? t("Aktive zeigen") : t("Archiv")}</button>
        <button type="button" className="btn btn-s btn-p" onClick={() => setCreating(true)} disabled={creating}><Icon name="plus" size={14} />{t("Neuer Raum")}</button>
      </PageHead>
      {creating && <NewRoom onCancel={() => setCreating(false)} onDone={(r) => navigate(`/rooms/${r.id}`)} />}
      {list.error && <p className="banner" role="alert"><Icon name="alert" />{t("Räume nicht ladbar: {error}", { error: list.error })}</p>}
      {list.loading && <p className="muted">{t("Lade…")}</p>}
      {list.data && rooms.length === 0 && !creating && (
        <div className="empty">
          <h2>{archived ? t("Nichts archiviert") : t("Noch kein Raum")}</h2>
          {!archived && <p className="muted">{t("Ein Raum bringt 2 bis {MAX} Agents in ein Gespräch. Mit @Name sprichst du einen an, @all alle.", { MAX })}</p>}
        </div>
      )}
      <ul className="roomlist">
        {rooms.map((r) => {
          const last = r.last_message;
          const who = last ? (last.author === "user" ? "Du" : r.members.find((m) => m.key === last.author)?.label ?? last.author) : undefined;
          return (
            <li key={r.id}>
              <Link to={`/rooms/${r.id}`} className={`card roomrow${r.needs_user ? " need" : ""}`}>
                <div className="row" style={{ gap: 10 }}>
                  <b className="grow trunc">{r.name}</b>
                  {r.needs_user && <span className="tag tag-s">{t("BRAUCHT DICH")}</span>}
                  {r.running && <span className="tag tag-act">{t("LÄUFT")}</span>}
                </div>
                <MemberStack members={r.members} />
                <p className="muted small trunc">{last ? `${who}: ${plainPreview(last.text)}` : t("Noch keine Nachricht")}</p>
                {last && <span className="mono t3 small">{fmtAgo(last.at * 1000)}</span>}
              </Link>
            </li>
          );
        })}
      </ul>
    </main>
  );
}
