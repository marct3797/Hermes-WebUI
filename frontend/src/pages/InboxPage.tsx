import { useEffect, useMemo, useState } from "react";
import { itemIdOf, secondsLeft, type Need } from "../attention";
import { Detail } from "../components/inbox/Detail";
import { Icon } from "../components/Icon";
import { Sigil } from "../components/Sigil";
import { fmtAgo, fmtClock, fmtTime } from "../format";
import { Link } from "../components/Link";
import { AskCard } from "../components/rooms/Parts";
import { isEditable } from "../keys";
import { useRoomNeeds } from "../roomNeeds";
import { useActivity, useRunSnapshot, useRunStore } from "../runs";
import type { Decision } from "../types";
import { sigilFor, useUi } from "../ui";
import { useNow } from "../useNow";
import { useMedia } from "../useMedia";
import { t as tr } from "../i18n";

type Tab = "all" | "approval" | "clarify" | "failed";
const TABS: Array<{ id: Tab; label: string }> = [
  { id: "all", get label() { return tr("Alle"); } }, { id: "approval", get label() { return tr("Freigaben"); } }, { id: "clarify", get label() { return tr("Rückfragen"); } }, { id: "failed", get label() { return tr("Fehler"); } },
];
const tabOf = (n: Need): Exclude<Tab, "all"> => (n.kind === "approval" || n.kind === "clarify" ? n.kind : "failed");

const GROUPS: Array<{ tab: Tab; label: string; hot?: boolean }> = [
  { tab: "approval", get label() { return tr("Läuft ab"); }, hot: true }, { tab: "clarify", get label() { return tr("Wartet auf dich"); } }, { tab: "failed", get label() { return tr("Fehler"); } },
];

const title = (n: Need) => n.kind === "approval" ? (n.item.smartDenied ? tr("Smart-Deny: Freigabe nötig") : tr("Freigabe nötig"))
  : n.kind === "clarify" ? tr("Rückfrage") : n.kind === "lost" ? tr("Verbindung verloren") : tr("Run fehlgeschlagen");
const sub = (n: Need) => n.kind === "approval" ? n.item.command : n.kind === "clarify" ? n.item.question : n.error;
const TAG: Record<Exclude<Tab, "all">, { text: string; cls: string }> = {
  approval: { get text() { return tr("FREIGABE"); }, cls: "tag-s" }, clarify: { get text() { return tr("RÜCKFRAGE"); }, cls: "" }, failed: { get text() { return tr("FEHLER"); }, cls: "tag-e" },
};

/** Alles, was auf die Person wartet: Liste links, Entscheidung rechts. Zeigt Runs, die diese WebUI gestartet hat. */
export function InboxPage() {
  const store = useRunStore();
  const { needs } = useActivity();
  const { log } = useRunSnapshot();
  const { needs: roomNeeds } = useRoomNeeds();
  const { sigils } = useUi();
  const now = useNow(true);
  const [tab, setTab] = useState<Tab>("all");
  const [sel, setSel] = useState<string>();
  // Untereinander (schmaler Schirm) steht die Meldung über der Liste: nach der Wahl dorthin scrollen.
  const stacked = useMedia("(max-width: 1000px)");
  const reduce = useMedia("(prefers-reduced-motion: reduce)");
  const pick = (id: string) => {
    setSel(id);
    if (stacked) document.querySelector(".detail")?.scrollIntoView?.({ block: "start", behavior: reduce ? "auto" : "smooth" });
  };

  const visible = useMemo(() => needs.filter((n) => tab === "all" || tabOf(n) === tab), [needs, tab]);
  const current = visible.find((n) => n.id === sel) ?? visible[0];
  const expiring = needs.filter((n) => n.kind === "approval").length;
  const today = new Date(now).setHours(0, 0, 0, 0);
  const done = log.filter((l) => l.at >= today).slice(0, 8);

  // J/K wechseln, Enter/S/Umschalt+A/Esc entscheiden die gewählte Freigabe.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isEditable(e.target) || !current) return;
      const i = visible.indexOf(current);
      if (e.key === "j" || e.key === "J") { e.preventDefault(); setSel(visible[Math.min(visible.length - 1, i + 1)].id); return; }
      if (e.key === "k" || e.key === "K") { e.preventDefault(); setSel(visible[Math.max(0, i - 1)].id); return; }
      if (current.kind !== "approval" || (secondsLeft(current, Date.now()) ?? 0) <= 0) return;
      let d: Decision | undefined;
      if (e.key === "Enter" && !e.shiftKey && !(e.target instanceof HTMLButtonElement) && !(e.target instanceof HTMLAnchorElement)) d = "once";
      else if (e.key === "s" && !e.shiftKey) d = "session";
      else if (e.key === "A" && e.shiftKey) d = "always";
      else if (e.key === "Escape") d = "deny";
      if (d && current.item.choices.includes(d)) { e.preventDefault(); void store.decide(current.convKey, itemIdOf(current), d); }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [current, visible, store]);

  return (
    <main className="inbox">
      <div className="page" style={{ flex: "none", paddingBottom: 18 }}>
        <header className="ph">
          <div className="col" style={{ gap: 6 }}><span className="lbl">{tr("Inbox")}</span><h1>{tr("Braucht dich")}</h1></div>
          <span className="ph-sub" style={{ marginBottom: 5 }}>{tr("{v} offen · {expiring} {v2} ab", { v: needs.length + roomNeeds.length, expiring, v2: expiring === 1 ? "läuft" : "laufen" })}</span>
          <span className="hint keys" style={{ marginLeft: "auto" }}>
            <span className="kbd">J</span><span className="kbd">K</span> {tr("wechseln ·")} <span className="kbd">⏎</span> {tr("einmal erlauben ·")} <span className="kbd">{tr("Esc")}</span> {tr("ablehnen")}
          </span>
        </header>
      </div>

      <div className="split">
        <div className="ilist">
          <div className="tabs" role="tablist">
            {TABS.map((t) => (
              <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={`tab${tab === t.id ? " on" : ""}`} onClick={() => setTab(t.id)}>
                {t.label}<span className="n">{t.id === "all" ? needs.length + roomNeeds.length : needs.filter((n) => tabOf(n) === t.id).length}</span>
              </button>
            ))}
          </div>
          {tab === "all" && roomNeeds.length > 0 && (
            <div role="group" aria-label={tr("Räume")}>
              <div className="grp"><span className="lbl">{tr("Räume")}</span><i className="sp grow" /></div>
              {roomNeeds.map((n) => n.ask && n.member ? (
                <AskCard key={n.id} ask={n.ask} member={n.member} room={{ id: n.room.id, name: n.room.name }} />
              ) : n.ask ? null : (
                <Link key={n.id} to={`/rooms/${n.room.id}`} className="irow">
                  <Icon name="orbit" size={18} />
                  <div className="col grow" style={{ gap: 3, minWidth: 0 }}>
                    <span className="tt trunc">{n.room.name}</span>
                    <span className="ss trunc">{tr("Ein Agent hat dich im Raum gerufen.")}</span>
                    <div className="row" style={{ gap: 8, marginTop: 3 }}>
                      <span className="tag tag-s">{tr("RAUM")}</span>
                      <span className="mono t3 trunc" style={{ fontSize: 10.5 }}>{n.room.members.map((m) => m.label).join(", ")}</span>
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          )}
          {GROUPS.map((g) => {
            const items = visible.filter((n) => tabOf(n) === g.tab);
            if (!items.length) return null;
            return (
              <div key={g.tab} role="group" aria-label={g.label}>
                <div className="grp"><span className={`lbl${g.hot ? " crimt" : ""}`}>{g.label}</span><i className="sp grow" /></div>
                {items.map((n) => {
                  const secs = secondsLeft(n, now);
                  const tag = TAG[tabOf(n)];
                  return (
                    <button key={n.id} type="button" className={`irow${current?.id === n.id ? " sel" : ""}`} aria-current={current?.id === n.id} onClick={() => pick(n.id)}>
                      <Sigil name={n.agent.agent} config={sigilFor(sigils, n.agent)} size="m" state={n.kind === "failed" || n.kind === "lost" ? "err" : "wait"} />
                      <div className="col grow" style={{ gap: 3, minWidth: 0 }}>
                        <span className="tt trunc">{title(n)}</span>
                        <span className="ss trunc">{sub(n)}</span>
                        <div className="row" style={{ gap: 8, marginTop: 3 }}>
                          <span className={`tag ${tag.cls}`.trim()}>{tag.text}</span>
                          <span className="mono t3" style={{ fontSize: 10.5 }}>{n.agent.agent} · {fmtAgo(n.since, now)}</span>
                        </div>
                      </div>
                      {n.kind === "approval" && secs !== undefined && (
                        <>
                          <span className={`mono${secs < 60 ? " crimt" : " t2"}`} style={{ fontSize: 12, fontWeight: 600 }}>{secs > 0 ? fmtClock(secs) : tr("abgelaufen")}</span>
                          <span className="bar"><b style={{ width: `${Math.max(0, Math.min(100, (secs / n.item.timeoutS) * 100))}%` }} /></span>
                        </>
                      )}
                    </button>
                  );
                })}
              </div>
            );
          })}
          {visible.length === 0 && !(tab === "all" && roomNeeds.length > 0) && <p className="panel-empty">{needs.length + roomNeeds.length === 0 ? "Nichts offen." : "Nichts in dieser Ansicht."}</p>}

          <div className="grp" style={{ marginTop: "auto", paddingTop: 22 }}>
            <span className="lbl">{tr("Erledigt heute")}</span><span className="mono t3" style={{ fontSize: 10.5 }}>{done.length}</span><i className="sp grow" />
          </div>
          {done.map((d) => (
            <div key={d.id} className="done-row">
              <Sigil name={d.agent.agent} config={sigilFor(sigils, d.agent)} size="xs" />
              <span className="trunc grow" style={{ fontSize: 12 }}>{d.text}</span>
              <span className="mono t3" style={{ fontSize: 10.5 }}>{fmtTime(d.at)}</span>
            </div>
          ))}
          {done.length === 0 && <p className="panel-empty" style={{ paddingTop: 4 }}>{tr("Noch nichts entschieden.")}</p>}
        </div>

        {current ? <Detail key={current.id} need={current} sigils={sigils} now={now} /> : (
          <section className="detail" aria-label={tr("Details")}>
            <div className="nothing">
              <i className="okmark"><Icon name="check" size={20} /></i>
              <span style={{ font: "600 18px var(--sans)", color: "var(--t1)" }}>{tr("Nichts offen")}</span>
              <p>{tr("Freigaben und Rückfragen von Runs, die du in dieser WebUI gestartet hast, erscheinen hier und im Cockpit.")}</p>
            </div>
          </section>
        )}
      </div>
    </main>
  );
}
