import { useState } from "react";
import { api } from "../../api";
import { fmtTime } from "../../format";
import type { RoomMember, RoomMessage, Decision } from "../../types";
import { useRoomNeeds } from "../../roomNeeds";
import { sigilFor, useUi } from "../../ui";
import type { MemberAsk } from "../../useRoom";
import { Icon } from "../Icon";
import { Link } from "../Link";
import { Markdown } from "../Markdown";
import { Sigil } from "../Sigil";
import { t } from "../../i18n";

export function MemberSigil({ member, size = "s" }: { member: RoomMember; size?: "xs" | "s" | "m" }) {
  const { sigils } = useUi();
  return <Sigil name={member.label} config={sigilFor(sigils, member)} size={size} />;
}

/** Die Mitglieder eines Raums als überlappende Sigils. */
export function MemberStack({ members }: { members: RoomMember[] }) {
  return <span className="mstack" aria-label={members.map((m) => m.label).join(", ")}>{members.map((m) => <MemberSigil key={m.key} member={m} size="xs" />)}</span>;
}

type RowProps = { message: RoomMessage; members: RoomMember[] };

export function MessageRow({ message, members }: RowProps) {
  const member = members.find((m) => m.key === message.author);
  if (message.kind === "system") return <p className="room-sys muted small" role="status">{message.text}</p>;
  const mine = message.author === "user";
  return (
    <article className={`rmsg${mine ? " mine" : ""}`} aria-label={`${mine ? "Du" : member?.label ?? message.author} um ${fmtTime(message.at * 1000)}`}>
      {member ? <MemberSigil member={member} /> : <span className="avatar" aria-hidden>{t("Du")}</span>}
      <div className="rbody">
        <header><b>{mine ? "Du" : member?.label ?? message.author}</b><span className="mono t3 small">{fmtTime(message.at * 1000)}</span></header>
        {mine ? <p className="rplain">{message.text}</p> : <Markdown text={message.text} />}
      </div>
    </article>
  );
}

const CHOICE: Record<Decision, string> = { once: "Einmal erlauben", get session() { return t("Für Session"); }, always: "Immer erlauben", deny: "Ablehnen" };

/** Freigabe oder Rückfrage eines Mitglieds: wird über den Run dieses Mitglieds beantwortet, nicht über den Raum. */
export function AskCard({ ask, member, room }: { ask: MemberAsk; member: RoomMember; room?: { id: string; name: string } }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [text, setText] = useState("");
  const { refresh } = useRoomNeeds();
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await fn();
      refresh();
      setTimeout(refresh, 2000); // Hermes meldet die Antwort erst einen Moment später als erledigt
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <section className="card need ask" role="group" aria-label={`${member.label} braucht dich`}>
      <header className="card-h"><MemberSigil member={member} size="xs" /><h2>{member.label} {ask.kind === "approval" ? t("braucht eine Freigabe") : t("hat eine Rückfrage")}</h2></header>
      <div className="wrow">
        {room && <p className="small muted">{t("im Raum")} <Link to={`/rooms/${room.id}`} className="inline-link">{room.name}</Link></p>}
        {ask.kind === "approval" ? (
          <>
            <code className="askcmd">{ask.command}</code>
            {ask.reason && <p className="muted small">{ask.reason}</p>}
            <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
              {ask.choices.map((c) => (
                <button key={c} type="button" className={`btn btn-s${c === "once" ? " btn-p" : c === "deny" ? " btn-d" : ""}`} disabled={busy} onClick={() => void run(() => api.approve(member, ask.runId, c))}>{CHOICE[c]}</button>
              ))}
            </div>
          </>
        ) : (
          <>
            <p>{ask.question}</p>
            <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
              {ask.choices.map((c) => <button key={c} type="button" className="btn btn-s" disabled={busy} onClick={() => void run(() => api.clarify(member, ask.runId, c, ask.clarifyId))}>{c}</button>)}
            </div>
            <form className="row" style={{ gap: 6 }} onSubmit={(e) => { e.preventDefault(); if (text.trim()) void run(() => api.clarify(member, ask.runId, text.trim(), ask.clarifyId)); }}>
              <input className="field field-line" value={text} onChange={(e) => setText(e.target.value)} aria-label={t("Antwort")} placeholder={t("Antwort eintippen")} />
              <button type="submit" className="btn btn-s btn-p" disabled={busy || !text.trim()}><Icon name="send" size={14} />{t("Senden")}</button>
            </form>
          </>
        )}
        {error && <p className="error small" role="alert">{error}</p>}
      </div>
    </section>
  );
}
