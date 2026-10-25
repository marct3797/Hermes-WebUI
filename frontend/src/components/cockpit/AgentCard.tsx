import { fmtAgo, fmtClock } from "../../format";
import { agentPath } from "../../router";
import type { AgentActivity } from "../../attention";
import type { LastChat } from "../../useAgentSessions";
import type { AgentRef, HostStatus, RuntimeInfo, SigilConfig } from "../../types";
import { Icon } from "../Icon";
import { Link } from "../Link";
import { Sigil } from "../Sigil";
import { STATUS_LABEL } from "../Status";
import { t } from "../../i18n";

type Props = {
  agent: AgentRef;
  label: string;
  runtime: RuntimeInfo;
  hostStatus: HostStatus;
  sigil?: SigilConfig;
  act?: AgentActivity;
  chat?: LastChat;
  now: number;
  /** Fehlertext des jüngsten gescheiterten Runs, falls vorhanden. */
  error?: string;
};

type Phase = "off" | "wait" | "run" | "err" | "ready";

/** Karte eines Agents: Zustand, Tätigkeit und letzter Chat. Werte, die Hermes nicht liefert, fehlen statt erfunden zu werden. */
export function AgentCard({ agent, label, runtime, hostStatus, sigil, act, chat, now, error }: Props) {
  const online = runtime.status === "online";
  const phase: Phase = !online ? "off" : act?.waiting ? "wait" : act?.running ? "run" : act?.failed ? "err" : "ready";
  const offline = runtime.status !== "online" ? runtime.status : hostStatus;
  const elapsed = act?.startedAt && Number.isFinite(act.startedAt) ? fmtClock((now - act.startedAt) / 1000) : undefined;
  const sessionId = act?.last?.sessionId;

  const tag = {
    off: <span className="tag"><i className="dot dot-off" />{offline === "sleeping" ? t("SCHLÄFT") : t("OFFLINE")}</span>,
    wait: <span className="tag tag-s"><i className="dot dot-wait" />{t("WARTET")}</span>,
    run: <span className="tag tag-c"><i className="dot dot-run" />{t("LÄUFT")}</span>,
    err: <span className="tag tag-e"><i className="dot dot-err" />{t("FEHLER")}</span>,
    ready: <span className="tag"><i className="dot dot-on" />{t("BEREIT")}</span>,
  }[phase];

  const live = phase === "off" ? { icon: "alert", text: runtime.detail ?? t("nicht erreichbar"), cls: " err" }
    : phase === "wait" ? { icon: "bell", text: [act?.activity, elapsed].filter(Boolean).join(" · "), cls: " wait" }
    : phase === "run" ? { icon: "cpu", text: [act?.activity, elapsed].filter(Boolean).join(" · "), cls: " run" }
    : phase === "err" ? { icon: "alert", text: error ?? t("Run fehlgeschlagen"), cls: " err" }
    : { icon: "clock", text: chat?.at ? `idle · letzter Chat ${fmtAgo(chat.at, now)}` : "idle", cls: "" };

  const cardCls = phase === "wait" ? " need" : phase === "run" ? " live" : phase === "err" ? " err" : "";
  const quote = phase === "off" ? undefined : chat?.last?.title ?? (chat?.loaded ? (chat.failed ? t("Chats nicht ladbar") : t("Noch kein Chat")) : t("Lade …"));

  return (
    <Link to={agentPath(agent, "chat", sessionId)} className={`card pcard${cardCls}`} aria-label={`${label}, ${STATUS_LABEL[offline] ?? ""}`.replace(/, $/, "")}>
      <div className="row" style={{ gap: 12, alignItems: "flex-start" }}>
        <Sigil name={label} config={sigil} size="l" state={phase === "wait" ? "wait" : phase === "run" ? "live" : phase === "err" ? "err" : undefined} />
        <div className="col grow" style={{ gap: 3, paddingTop: 2, minWidth: 0 }}>
          <span className="nm trunc">{label}</span>
          <span className="mono t3 trunc" style={{ fontSize: 10.5 }}>{agent.host}/{agent.runtime}</span>
        </div>
        {tag}
      </div>
      {quote && <div className={`quote${chat?.last ? "" : " dim"}`}>{quote}</div>}
      <div className={`livebox${live.cls}`}><Icon name={live.icon} size={14} /><span className="trunc v">{live.text}</span></div>
      <div className="pfoot">
        {chat?.at && <span className="cnt"><Icon name="chat" size={12} />{fmtAgo(chat.at, now)}</span>}
        <span style={{ marginLeft: "auto" }}>{runtime.label}{runtime.version ? ` ${runtime.version}` : ""}</span>
      </div>
    </Link>
  );
}
