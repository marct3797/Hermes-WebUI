import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { Icon } from "../components/Icon";
import { Link } from "../components/Link";
import { Markdown } from "../components/Markdown";
import { AskCard, MemberSigil, MessageRow } from "../components/rooms/Parts";
import { navigate } from "../router";
import { useRoom } from "../useRoom";
import { t as tr } from "../i18n";

/** Ein Raum: Verlauf, wer gerade schreibt, Freigaben der Mitglieder und die Eingabe mit @-Hilfe. */
export function RoomPage({ roomId }: { roomId: string }) {
  const { state, reload, loadOlder } = useRoom(roomId);
  const { room, messages, running, typing, asks, finished } = state;
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const [renaming, setRenaming] = useState<string>();
  const input = useRef<HTMLTextAreaElement>(null);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => { end.current?.scrollIntoView?.({ block: "end" }); }, [messages.length, Object.keys(typing).length, asks.length]);

  const members = room?.members ?? [];
  const asker = useMemo(() => {
    if (!room?.needs_user) return undefined;
    const m = [...messages].reverse().find((x) => x.mentions.includes("user"));
    return m && { member: members.find((x) => x.key === m.author), text: m.text };
  }, [room?.needs_user, messages, members]);

  if (state.error && !room) {
    return <main className="page"><p className="banner" role="alert"><Icon name="alert" />{tr("Raum nicht ladbar: {error}", { error: state.error })}</p><Link to="/rooms" className="inline-link">{tr("Zu den Räumen")}</Link></main>;
  }
  if (!room) return <main className="page"><p className="muted">{tr("Lade…")}</p></main>;

  const send = async () => {
    const body = text.trim();
    if (!body || sending || running) return;
    setSending(true);
    setError(undefined);
    try {
      await api.sendRoomMessage(roomId, body);
      setText("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  const mention = (name: string) => {
    const el = input.current;
    const at = el?.selectionStart ?? text.length;
    const before = text.slice(0, at), after = text.slice(at);
    const gap = before && !/\s$/.test(before) ? " " : "";
    setText(`${before}${gap}@${name} ${after}`);
    el?.focus();
  };

  const finishNote: Record<string, string> = {
    max_rounds: tr("Nach 3 Runden angehalten. Schreib weiter, wenn die Runde noch etwas braucht."),
    max_messages: tr("Nach 10 Beiträgen angehalten. Schreib weiter, wenn die Runde noch etwas braucht."),
    stopped: "Angehalten.",
    error: tr("Der Ablauf ist mit einem Fehler abgebrochen."),
  };

  const rename = async () => {
    const name = (renaming ?? "").trim();
    setRenaming(undefined);
    if (!name || name === room.name) return;
    try { await api.patchRoom(roomId, { name }); await reload(); } catch (e) { setError((e as Error).message); }
  };

  return (
    <main className="page room">
      <header className="room-h">
        <Link to="/rooms" className="btn btn-s btn-i btn-g" aria-label={tr("Zu den Räumen")}><Icon name="chevr" size={14} className="flip" /></Link>
        {renaming === undefined ? (
          <h1 className="room-title">{room.name}</h1>
        ) : (
          <form onSubmit={(e) => { e.preventDefault(); void rename(); }} className="row grow">
            <input className="field field-line" value={renaming} onChange={(e) => setRenaming(e.target.value)} aria-label={tr("Raumname")} maxLength={60} autoFocus />
            <button type="submit" className="btn btn-s">{tr("Speichern")}</button>
          </form>
        )}
        <span className="mstack" role="list" aria-label={tr("Mitglieder")}>{members.map((m) => <span key={m.key} role="listitem" title={m.label}><MemberSigil member={m} size="xs" /></span>)}</span>
        <span className="grow" />
        {renaming === undefined && <button type="button" className="btn btn-s btn-i btn-g" aria-label={tr("Raum umbenennen")} title={tr("Umbenennen")} onClick={() => setRenaming(room.name)}><Icon name="edit" size={14} /></button>}
        <button type="button" className="btn btn-s btn-g" disabled={running} onClick={() => void api.patchRoom(roomId, { archived: !room.archived }).then(() => navigate("/rooms"))}>
          {room.archived ? tr("Wiederherstellen") : tr("Archivieren")}
        </button>
      </header>

      {asker && (
        <p className="banner need-banner" role="status"><Icon name="bell" />
          <span><b>{asker.member?.label ?? tr("Ein Mitglied")}</b> {tr("braucht dich:")} {asker.text.length > 160 ? `${asker.text.slice(0, 160)}…` : asker.text}</span>
        </p>
      )}

      <div className="room-log" role="log" aria-label={tr("Verlauf")} aria-live="polite">
        {state.hasOlder && (
          <button type="button" className="btn btn-s" disabled={state.loadingOlder} onClick={() => void loadOlder()}>
            {state.loadingOlder ? tr("Lade ältere Nachrichten…") : tr("Ältere Nachrichten laden")}
          </button>
        )}
        {messages.length === 0 && <p className="panel-empty">{tr("Noch nichts gesagt. Schreib in den Raum; ohne @ antworten alle, mit @Name nur die Genannten.")}</p>}
        {messages.map((m) => <MessageRow key={m.seq} message={m} members={members} />)}
        {Object.entries(typing).map(([key, t]) => {
          const m = members.find((x) => x.key === key);
          if (!m) return null;
          return (
            <article key={key} className="rmsg live" aria-label={`${m.label} schreibt`}>
              <MemberSigil member={m} />
              <div className="rbody">
                <header><b>{m.label}</b><span className="muted small">{t.tool && !t.text ? `nutzt ${t.tool}…` : "schreibt…"}</span></header>
                {t.text && <Markdown text={t.text} caret />}
              </div>
            </article>
          );
        })}
        {asks.map((a) => { const m = members.find((x) => x.key === a.member); return m ? <AskCard key={a.runId} ask={a} member={m} /> : null; })}
        {!running && finished && finishNote[finished] && <p className="room-sys muted small" role="status">{finishNote[finished]}</p>}
        <div ref={end} />
      </div>

      <form className="room-dock" onSubmit={(e) => { e.preventDefault(); void send(); }}>
        <div className="row mention-row" role="group" aria-label={tr("Erwähnen")}>
          {members.map((m) => <button key={m.key} type="button" className="chip chip-s" onClick={() => mention(m.label)} aria-label={tr("@{label} einfügen", { label: m.label })}>@{m.label}</button>)}
          <button type="button" className="chip chip-s" onClick={() => mention("all")} aria-label={tr("@all einfügen")}>{tr("@all")}</button>
        </div>
        <div className="row" style={{ gap: 8, alignItems: "flex-end" }}>
          <textarea ref={input} className="field" value={text} onChange={(e) => setText(e.target.value)} maxLength={4000} aria-label={tr("Nachricht an den Raum")}
            placeholder={running ? tr("Der Raum arbeitet…") : tr("Nachricht an den Raum")} disabled={room.archived}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }} />
          {running
            ? <button type="button" className="btn btn-d" onClick={() => void api.stopRoom(roomId)}><Icon name="stop" size={14} />{tr("Stopp")}</button>
            : <button type="submit" className="btn btn-p" disabled={!text.trim() || sending || room.archived}><Icon name="send" size={14} />{tr("Senden")}</button>}
        </div>
        {error && <p className="error small" role="alert">{error}</p>}
      </form>
    </main>
  );
}
