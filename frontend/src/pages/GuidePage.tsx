import { useEffect, useMemo, useState, type JSX, type ReactNode } from "react";
import QRCode from "qrcode";
import { ApiError, api } from "../api";
import { GUIDE, type GuideEntry, type GuidePanel } from "../guide";
import { PageHead } from "../components/PageHead";
import { StepUpNote } from "../components/providers/StepUpNote";
import { Link } from "../components/Link";
import { useHosts } from "../hosts";
import { agentPath } from "../router";
import type { AgentRef } from "../types";
import { extApi } from "../extApi";
import { t } from "../i18n";

function useOp() {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string>();
  const [failed, setFailed] = useState<string>();
  const [stepUp, setStepUp] = useState(false);
  const run = async (fn: () => Promise<string | null | undefined>) => {
    setBusy(true); setDone(undefined); setFailed(undefined); setStepUp(false);
    try {
      const d = await fn();
      setDone(d ?? undefined);
    } catch (e) {
      if (e instanceof ApiError && e.code === "step_up_required") setStepUp(true);
      else setFailed((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const notes = <>{stepUp && <StepUpNote what={t("Diese Änderung")} />}{failed && <p className="banner" role="alert">{failed}</p>}{done && <p role="status">{done}</p>}</>;
  return { busy, run, notes };
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return <label className="pf-fld"><span>{label}</span><div className="row" style={{ gap: 8 }}>{children}</div></label>;
}

function WhatsAppPanel({ agent }: { agent: AgentRef | null }) {
  const op = useOp();
  const [mode, setMode] = useState("bot");
  const [pairing, setPairing] = useState<{ pairing_id: string; status: string; qr_payload?: string | null; account?: { account_name?: string | null } | null; error?: string | null } | null>(null);
  const [qrSvg, setQrSvg] = useState<string | null>(null);
  useEffect(() => {
    if (pairing?.qr_payload) QRCode.toString(pairing.qr_payload, { type: "svg", margin: 1, width: 256 }).then(setQrSvg, () => setQrSvg(null));
    else setQrSvg(null);
  }, [pairing?.qr_payload]);
  const live = !!pairing && (pairing.status === "waiting" || pairing.status === "qr" || pairing.status === "pairing");
  useEffect(() => {
    if (!live || !agent || !pairing) return;
    const id = window.setInterval(async () => {
      try {
        const p = await api.whatsappPoll(agent, pairing.pairing_id);
        setPairing(p);
        if (p.status !== "waiting" && p.status !== "qr" && p.status !== "pairing") window.clearInterval(id);
      } catch { window.clearInterval(id); }
    }, 3000);
    return () => window.clearInterval(id);
  }, [live, agent, pairing]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="col" style={{ gap: 8 }}>
      {!pairing && (
        <Row label={t("Modus")}>
          <select className="pf-in" value={mode} onChange={(e) => setMode(e.target.value)} disabled={!agent || op.busy}>
            <option value="bot">{t("Bot")}</option>
            <option value="self-chat">{t("Selbst-Chat")}</option>
          </select>
          <button type="button" className="btn btn-s btn-p" disabled={!agent || op.busy} onClick={() => void op.run(async () => {
            const p = await api.whatsappStart(agent!, mode);
            setPairing(p);
            return t("Kopplung läuft — QR-Code mit dem Handy scannen.");
          })}>{t("Kopplung starten")}</button>
        </Row>
      )}
      {pairing && live && (
        <>
          {qrSvg
            ? <div role="img" aria-label={t("QR-Code zum Scannen")} dangerouslySetInnerHTML={{ __html: qrSvg }} />
            : pairing.qr_payload && <pre className="mono" style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{pairing.qr_payload}</pre>}
          <p className="muted small">{t("Mit dem Handy scannen, Stand wird von selbst neu gelesen …")}</p>
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="btn btn-s btn-g" disabled={!agent || op.busy} onClick={() => void op.run(async () => {
              await api.whatsappCancel(agent!, pairing.pairing_id); setPairing(null); return t("Abgebrochen.");
            })}>{t("Abbrechen")}</button>
          </div>
        </>
      )}
      {pairing && pairing.status === "connected" && (
        <div className="row" style={{ gap: 8 }}>
          <span>{t("Verbunden{phone}", { phone: pairing.account?.account_name ? ` (${pairing.account.account_name})` : "" })}</span>
          <button type="button" className="btn btn-s btn-p" disabled={!agent || op.busy} onClick={() => void op.run(async () => {
            await api.whatsappApply(agent!, pairing.pairing_id); setPairing(null); return t("Übernommen.");
          })}>{t("Übernehmen")}</button>
        </div>
      )}
      {pairing && !live && pairing.status !== "connected" && (
        <p role="alert" className="error">{pairing.error ?? pairing.status}</p>
      )}
      {op.notes}
    </div>
  );
}

function TerminalPanel({ agent }: { agent: AgentRef | null }) {
  const op = useOp();
  const [backends, setBackends] = useState<{ active: string | null; backends: { name: string; label?: string; description?: string; status?: string; detail?: string }[] } | null>(null);
  const [pick, setPick] = useState("");
  useEffect(() => { if (agent) void api.terminalBackends(agent).then((r) => { setBackends(r); setPick(r.active ?? ""); }, () => setBackends(null)); }, [agent]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!backends) return <p className="muted small">{t("Lade…")}</p>;
  return (
    <div className="col" style={{ gap: 8 }}>
      {backends.backends.map((b) => (
        <label key={b.name} className="row" style={{ gap: 8 }}>
          <input type="radio" name="tm-backend" checked={pick === b.name} onChange={() => setPick(b.name)} disabled={!agent || op.busy} />
          <span><b>{b.label ?? b.name}</b> <span className="tag">{b.status ?? ""}</span><br /><span className="muted small">{b.description}{b.detail ? ` — ${b.detail}` : ""}</span></span>
        </label>
      ))}
      <div className="row" style={{ gap: 8 }}>
        <button type="button" className="btn btn-s btn-p" disabled={!agent || op.busy || !pick || pick === backends.active} onClick={() => void op.run(async () => {
          if (!window.confirm(t("Backend wirklich umstellen? Falsche Wahl hebt die Isolation auf."))) return null;
          const r = await api.setTerminalBackend(agent!, pick);
          setBackends({ ...backends, active: r.backend });
          return t("Umgestellt auf {name}.", { name: r.backend });
        })}>{t("Umstellen")}</button>
      </div>
      {op.notes}
    </div>
  );
}

function ToolsPanel({ agent }: { agent: AgentRef | null }) {
  const op = useOp();
  const [rows, setRows] = useState<{ name: string; label?: string; enabled: boolean }[] | null>(null);
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  useEffect(() => { if (agent) void api.tools(agent).then((r) => setRows(r.toolsets.map((x) => ({ name: x.name, label: x.label, enabled: x.enabled }))), () => setRows([])); }, [agent]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!rows) return <p className="muted small">{t("Lade…")}</p>;
  return (
    <div className="col" style={{ gap: 8 }}>
      <Row label={t("Werkzeug")}>
        <select className="pf-in grow" value={name} onChange={(e) => setName(e.target.value)} disabled={!agent || op.busy}>
          <option value="">{t("wählen …")}</option>
          {rows.map((r) => <option key={r.name} value={r.name}>{r.label ?? r.name}{r.enabled ? ` (${t("an")})` : ""}</option>)}
        </select>
      </Row>
      <Row label={t("Schlüssel (post-setup)")}>
        <input className="pf-in mono grow" value={key} onChange={(e) => setKey(e.target.value)} placeholder="cua_driver" autoComplete="off" spellCheck={false} disabled={!agent || op.busy} />
        <button type="button" className="btn btn-s btn-p" disabled={!agent || op.busy || !name || !key.trim()} onClick={() => void op.run(async () => {
          if (!window.confirm(t("Nachinstallation starten? Lädt Programme aus dem Netz."))) return null;
          const r = await api.postSetup(agent!, name, key.trim());
          return t("Gestartet ({action}).", { action: r.name });
        })}>{t("Nachinstallieren")}</button>
      </Row>
      {op.notes}
    </div>
  );
}

function ComputerUsePanel({ agent }: { agent: AgentRef | null }) {
  const op = useOp();
  const [st, setSt] = useState<{ ready?: boolean | null; installed?: boolean | null; can_grant?: boolean | null; platform?: string | null; detail?: string | null } | null>(null);
  useEffect(() => { if (agent) void api.computerUse(agent).then(setSt, () => setSt(null)); }, [agent]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!st) return <p className="muted small">{t("Lade…")}</p>;
  return (
    <div className="col" style={{ gap: 8 }}>
      <p className="muted small">{t("Bereit: {v}", { v: st.ready ? t("ja") : t("nein") })}{st.platform ? ` · ${st.platform}` : ""}{st.detail ? ` · ${st.detail}` : ""}</p>
      <div className="row" style={{ gap: 8 }}>
        <button type="button" className="btn btn-s btn-p" disabled={!agent || op.busy || !st.can_grant} onClick={() => void op.run(async () => {
          const r = await api.grantComputerUse(agent!);
          return t("Angefragt ({action}).", { action: r.name });
        })}>{t("Rechte anfordern")}</button>
      </div>
      {!st.can_grant && <p className="muted small">{t("Auf diesem System vergibt Hermes keine Rechte aus der Ferne.")}</p>}
      {op.notes}
    </div>
  );
}

function UpdatePanel({ agent }: { agent: AgentRef | null }) {
  const op = useOp();
  const [check, setCheck] = useState<{ current: string; available: string | null } | null>(null);
  useEffect(() => { if (agent) void api.updateCheck(agent).then(setCheck, () => setCheck(null)); }, [agent]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="col" style={{ gap: 8 }}>
      <p className="muted small">{check ? (check.available ? t("Neu: {v}", { v: check.available }) : t("Stand: {v}", { v: check.current })) : t("Lade…")}</p>
      <div className="row" style={{ gap: 8 }}>
        <button type="button" className="btn btn-s btn-p" disabled={!agent || op.busy || !check?.available} onClick={() => void op.run(async () => {
          const word = window.prompt(t("Zum Bestätigen „aktualisieren“ eintippen. Das Update ersetzt laufende Dateien."));
          if (word === null) return null;
          if (word !== "aktualisieren") throw new Error(t("Abgebrochen: Bestätigung stimmt nicht."));
          const r = await api.runUpdate(agent!);
          if (!r.ok) return r.message ?? r.error ?? t("Abgelehnt.");
          return t("Update läuft im Hintergrund.");
        })}>{t("Update starten")}</button>
      </div>
      {op.notes}
    </div>
  );
}

function GatewayPanel({ agent }: { agent: AgentRef | null }) {
  const op = useOp();
  type PlanProfile = { profile?: string; pid?: number | null; home?: string | null };
  const [plan, setPlan] = useState<{ blockers?: string[]; profiles?: (string | PlanProfile)[]; notices?: string[]; eligible?: boolean } | null>(null);
  useEffect(() => { if (agent) void api.migratePlan(agent).then((r) => setPlan(r.plan), () => setPlan(null)); }, [agent]); // eslint-disable-line react-hooks/exhaustive-deps
  const nameOf = (p: string | PlanProfile) => (typeof p === "string" ? p : p.profile ?? "?");
  const keyOf = (p: string | PlanProfile, i: number) => `${nameOf(p)}-${i}`;
  return (
    <div className="col" style={{ gap: 8 }}>
      {plan ? (
        <><ul>{(plan.profiles ?? []).map((p, i) => <li key={keyOf(p, i)}>{nameOf(p)}{typeof p !== "string" && p.pid ? ` (PID ${p.pid})` : ""}</li>)}{(plan.blockers ?? []).map((b, i) => <li key={`b-${i}`} role="alert" className="error">{b}</li>)}</ul>
        {(plan.notices ?? []).map((n, i) => <p key={i} className="muted small">{n}</p>)}</>
      ) : <p className="muted small">{t("Kein Plan lesbar.")}</p>}
      <div className="row" style={{ gap: 8 }}>
        <button type="button" className="btn btn-s btn-p" disabled={!agent || op.busy || ((plan?.blockers?.length ?? 0) > 0) || plan?.eligible === false} onClick={() => void op.run(async () => {
          const word = window.prompt(t("Zum Bestätigen „migrieren“ eintippen. Unterbricht laufende Chats."));
          if (word === null) return null;
          if (word !== "migrieren") throw new Error(t("Abgebrochen: Bestätigung stimmt nicht."));
          const r = await api.runMigrate(agent!);
          return t("Umzug läuft ({action}).", { action: String(r.name ?? "?") });
        })}>{t("Umzug starten")}</button>
      </div>
      {op.notes}
    </div>
  );
}

function HooksPanel({ agent }: { agent: AgentRef | null }) {
  const op = useOp();
  const [data, setData] = useState<{ hooks: { event: string; executable: boolean; allowed: boolean; command_preview?: string }[]; valid_events: string[] } | null>(null);
  const [event, setEvent] = useState("");
  const [command, setCommand] = useState("");
  const [approve, setApprove] = useState(false);
  const [ver, setVer] = useState(0);
  const [delConfirm, setDelConfirm] = useState<Record<string, string>>({});
  useEffect(() => { if (agent) void api.shellHooks(agent).then(setData, () => setData(null)); }, [agent, ver]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!data) return <p className="muted small">{t("Lade…")}</p>;
  return (
    <div className="col" style={{ gap: 8 }}>
      <ul>{data.hooks.map((h, i) => {
        const k = `${h.event}-${i}`;
        const typed = delConfirm[k] ?? "";
        return (
          <li key={k}>{h.event} · {h.command_preview ?? ""} · {h.allowed ? t("freigegeben") : t("nicht freigegeben")}{h.executable ? "" : ` · ${t("nicht ausführbar")}`}
            <div className="row" style={{ gap: 8 }}>
              <input className="pf-in mono" aria-label={t("Befehl zur Bestätigung eintippen")} value={typed} onChange={(e) => setDelConfirm({ ...delConfirm, [k]: e.target.value })} placeholder={t("Befehl eintippen …")} autoComplete="off" spellCheck={false} disabled={!agent || op.busy} />
              <button type="button" className="btn btn-s btn-g" disabled={!agent || op.busy || !typed.trim()} onClick={() => void op.run(async () => {
                await api.deleteHook(agent!, { event: h.event, command: typed.trim(), confirm: typed.trim() });
                setDelConfirm({ ...delConfirm, [k]: "" }); setVer((v) => v + 1); return t("Gelöscht.");
              })}>{t("Löschen")}</button>
            </div>
          </li>
        );
      })}</ul>
      <Row label={t("Ereignis")}>
        <select className="pf-in grow" value={event} onChange={(e) => setEvent(e.target.value)} disabled={!agent || op.busy}>
          <option value="">{t("wählen …")}</option>
          {data.valid_events.map((e) => <option key={e} value={e}>{e}</option>)}
        </select>
      </Row>
      <Row label={t("Befehl")}>
        <input className="pf-in mono grow" value={command} onChange={(e) => setCommand(e.target.value)} autoComplete="off" spellCheck={false} disabled={!agent || op.busy} />
      </Row>
      <label className="row" style={{ gap: 8 }}><input type="checkbox" checked={approve} onChange={(e) => setApprove(e.target.checked)} disabled={!agent || op.busy} />{t("Gleich freigeben (läuft sonst nicht)")}</label>
      <div className="row" style={{ gap: 8 }}>
        <button type="button" className="btn btn-s btn-p" disabled={!agent || op.busy || !event || !command.trim()} onClick={() => void op.run(async () => {
          const word = window.prompt(t("Zum Bestätigen den Befehl eintippen. Er läuft mit deinen Rechten."));
          if (word === null) return null;
          if (word !== command.trim()) throw new Error(t("Abgebrochen: Bestätigung stimmt nicht."));
          const r = await api.createHook(agent!, { event, command: command.trim(), approve, confirm: command.trim() });
          setCommand(""); setVer((v) => v + 1);
          return r.approved ? t("Angelegt und freigegeben.") : t("Angelegt, noch nicht freigegeben.");
        })}>{t("Hook anlegen")}</button>
      </div>
      {op.notes}
    </div>
  );
}

function EnvPanel({ agent }: { agent: AgentRef | null }) {
  const op = useOp();
  const [key, setKey] = useState("");
  return (
    <div className="col" style={{ gap: 8 }}>
      <Row label={t("Schlüsselname")}>
        <input className="pf-in mono grow" value={key} onChange={(e) => setKey(e.target.value.toUpperCase())} placeholder="ANTHROPIC_API_KEY" autoComplete="off" spellCheck={false} disabled={!agent || op.busy} />
        <button type="button" className="btn btn-s btn-p" disabled={!agent || op.busy || !key.trim()} onClick={() => void op.run(async () => {
          const word = window.prompt(t("Zum Bestätigen den Schlüsselnamen eintippen. Löschen wirkt sofort."));
          if (word === null) return null;
          if (word !== key.trim()) throw new Error(t("Abgebrochen: Bestätigung stimmt nicht."));
          await api.deleteEnv(agent!, key.trim());
          setKey("");
          return t("Gelöscht.");
        })}>{t("Löschen")}</button>
      </Row>
      {op.notes}
    </div>
  );
}

function McpPanel({ agent }: { agent: AgentRef | null }) {
  const op = useOp();
  const [names, setNames] = useState<string[] | null>(null);
  const [text, setText] = useState('{\n  "beispiel": {"command": "npx", "args": ["-y", "paket"]}\n}');
  useEffect(() => { if (agent) void extApi.mcp(agent.host, agent.agent).then((r) => setNames(r.servers.map((s) => s.name)), () => setNames([])); }, [agent]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="col" style={{ gap: 8 }}>
      <p className="muted small">{names === null ? t("Lade…") : t("{n} Server: {v}", { n: names.length, v: names.join(", ") || "–" })}</p>
      <label className="pf-fld"><span>{t("Ganze Liste als JSON")}</span>
        <textarea className="pf-in mono" rows={6} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} disabled={!agent || op.busy} />
      </label>
      <div className="row" style={{ gap: 8 }}>
        <button type="button" className="btn btn-s btn-p" disabled={!agent || op.busy} onClick={() => void op.run(async () => {
          let servers: Record<string, unknown>;
          try {
            const parsed: unknown = JSON.parse(text);
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("kein Objekt");
            servers = parsed as Record<string, unknown>;
          } catch { throw new Error(t("Kein gültiges JSON-Objekt.")); }
          const word = window.prompt(t("Zum Bestätigen „ERSETZEN“ eintippen. Das löscht alle Server auf einmal."));
          if (word === null) return null;
          if (word !== "ERSETZEN") throw new Error(t("Abgebrochen: Bestätigung stimmt nicht."));
          const r = await extApi.replaceMcp(agent!.host, agent!.agent, servers);
          const after = await extApi.mcp(agent!.host, agent!.agent);
          setNames(after.servers.map((s) => s.name));
          return t("Ersetzt: {v}", { v: r.servers.join(", ") });
        })}>{t("Liste ersetzen")}</button>
      </div>
      {op.notes}
    </div>
  );
}

function MemoryPanel({ agent }: { agent: AgentRef | null }) {
  const op = useOp();
  const [active, setActive] = useState<string | null>(null);
  const [list, setList] = useState<{ name: string; label?: string | null; available: boolean }[]>([]);
  const [pick, setPick] = useState("");
  useEffect(() => { if (agent) void api.hmOverview(agent).then((r) => { setList(r.providers); setActive(r.active); }, () => { setList([]); setActive(null); }); }, [agent]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="col" style={{ gap: 8 }}>
      <p className="muted small">{active === null ? t("Lade…") : t("Aktiv: {name}", { name: active || t("keiner") })}</p>
      <Row label={t("Anbieter")}>
        <select className="pf-in grow" value={pick} onChange={(e) => setPick(e.target.value)} disabled={!agent || op.busy}>
          <option value="">{t("wählen …")}</option>
          {list.filter((p) => p.available).map((p) => <option key={p.name} value={p.name}>{p.label ?? p.name}</option>)}
        </select>
        <button type="button" className="btn btn-s btn-p" disabled={!agent || op.busy || !pick} onClick={() => void op.run(async () => {
          await api.hmSetProvider(agent!, pick);
          return t("Aktiv: {name}", { name: pick });
        })}>{t("Aktivieren")}</button>
      </Row>
      <div className="row" style={{ gap: 8 }}>
        <button type="button" className="btn btn-s btn-g" disabled={!agent || op.busy || !pick} onClick={() => void op.run(async () => {
          if (!window.confirm(t("Anbieter-Installation starten? Lädt Programme aus dem Netz."))) return null;
          await api.hmSetup(agent!, pick);
          return t("Installation läuft.");
        })}>{t("Programm installieren")}</button>
      </div>
      {op.notes}
    </div>
  );
}

const PANELS: Record<GuidePanel, (p: { agent: AgentRef | null }) => JSX.Element> = {
  whatsapp: WhatsAppPanel, terminal: TerminalPanel, tools: ToolsPanel, computeruse: ComputerUsePanel,
  update: UpdatePanel, gateway: GatewayPanel, hooks: HooksPanel, env: EnvPanel, mcp: McpPanel, memory: MemoryPanel,
};

function Entry({ entry, agent }: { entry: GuideEntry; agent: AgentRef | null }) {
  const [status, setStatus] = useState<string>();
  const [statusOk, setStatusOk] = useState(false);
  useEffect(() => {
    let stop = false;
    if (entry.run && agent) entry.run(agent).then((r) => { if (!stop) { setStatus(r.text); setStatusOk(r.ok); } }, () => { if (!stop) setStatus(undefined); });
    else setStatus(undefined);
    return () => { stop = true; };
  }, [entry, agent?.host, agent?.runtime, agent?.agent]); // eslint-disable-line react-hooks/exhaustive-deps
  const Panel = PANELS[entry.panel];
  const configureTo = agent ? agentPath(agent, entry.configurePath) : `/${entry.configurePath}`;
  return (
    <section className="card" aria-label={t(entry.title)}>
      <h2>{t(entry.title)} {status !== undefined && <span className={`tag${statusOk ? " tag-c" : ""}`}>{statusOk ? t("Bereit") : t("Offen")} · {status}</span>}</h2>
      <p>{t(entry.purpose)}</p>
      <Panel agent={agent} />
      <p className="muted small"><Link to={configureTo}>{t(entry.configureLabel)}</Link></p>
    </section>
  );
}

/** Bedienung: jede Karte stellt Hermes direkt — kein Befehl, kein Kopieren. */
export function GuidePage({ agent }: { agent?: AgentRef | null }) {
  const { hosts } = useHosts();
  const fallback: AgentRef | null = useMemo(() => agent ?? (() => {
    const h = hosts?.[0];
    const r = h?.runtimes.find((x) => x.id === "hermes") ?? h?.runtimes[0];
    const a = r?.agents[0];
    return h && r && a ? { host: h.id, runtime: r.id, agent: a.id } : null;
  })(), [agent, hosts]);
  return (
    <main className="page">
      <PageHead title={t("Anleitungen")} sub={t("Hermes hier bedienen")} />
      {!fallback && <p className="muted" role="status">{t("Kein Agent verbunden.")}</p>}
      {GUIDE.map((entry) => <Entry key={entry.id} entry={entry} agent={fallback} />)}
    </main>
  );
}
