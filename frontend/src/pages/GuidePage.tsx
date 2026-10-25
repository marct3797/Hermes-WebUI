import { useEffect, useState } from "react";
import { ApiError } from "../api";
import { GUIDE, type GuideEntry } from "../guide";
import { PageHead } from "../components/PageHead";
import { Link } from "../components/Link";
import { StepUpNote } from "../components/providers/StepUpNote";
import { useHosts } from "../hosts";
import { agentPath } from "../router";
import type { AgentRef } from "../types";
import { t } from "../i18n";

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Rückfall ohne Zwischenablage-Rechte: Text in ein verstecktes Feld legen und kopieren.
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
      return true;
    } catch {
      return false;
    }
  }
}

function Entry({ entry, agent }: { entry: GuideEntry; agent: AgentRef | null }) {
  const [copied, setCopied] = useState(false);
  const [result, setResult] = useState<string>();
  const [failed, setFailed] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string>();
  const [statusOk, setStatusOk] = useState<boolean>();
  const [stepUp, setStepUp] = useState(false);

  // Status-Kopf je Eintrag: bereit/offen aus der Prüf-Route (run), einmal beim Öffnen.
  useEffect(() => {
    let live = true;
    setStatus(undefined);
    setStatusOk(undefined);
    if (!entry.run || !agent) return;
    entry.run(agent).then(
      (r) => { if (live) { setStatus(r.text); setStatusOk(r.ok); } },
      () => { if (live) { setStatus(undefined); setStatusOk(undefined); } },
    );
    return () => { live = false; };
  }, [entry, agent?.host, agent?.runtime, agent?.agent]); // eslint-disable-line react-hooks/exhaustive-deps

  const check = async () => {
    if (!entry.run || !agent) return;
    setBusy(true);
    setResult(undefined);
    setFailed(undefined);
    try {
      const r = await entry.run(agent);
      if (r.ok) setResult(r.text);
      else setFailed(r.text);
    } catch (e) {
      setFailed((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const execute = async () => {
    if (!entry.execute || !agent) return;
    if (entry.execute.confirm && !window.confirm(t(entry.execute.confirm))) return;
    setBusy(true);
    setResult(undefined);
    setFailed(undefined);
    setStepUp(false);
    try {
      const r = await entry.execute.call(agent);
      if (r.ok) setResult(r.text);
      else setFailed(r.text);
      // Nachher-Zustand neu lesen, damit der Kopf stimmt.
      try {
        if (entry.run) {
          const s = await entry.run(agent);
          setStatus(s.text);
          setStatusOk(s.ok);
        }
      } catch { /* Kopf bleibt stehen */ }
    } catch (e) {
      if (e instanceof ApiError && e.code === "step_up_required") setStepUp(true);
      else setFailed((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const configureTo = agent ? agentPath(agent, entry.configurePath) : `/${entry.configurePath}`;

  return (
    <section className="card" aria-label={t(entry.title)}>
      <h2>{t(entry.title)}</h2>
      {status !== undefined && (
        <p role="status" className="muted">{statusOk ? t("Bereit: {s}", { s: status }) : t("Offen: {s}", { s: status })}</p>
      )}
      <p>{t(entry.purpose)}</p>
      {entry.execute ? (
        <div className="row">
          <button type="button" disabled={!agent || busy} onClick={execute}>
            {busy ? t("Führe aus …") : t(entry.execute.label)}
          </button>
          <Link to={configureTo}>{t(entry.configureLabel)}</Link>
        </div>
      ) : (
        <>
          <p className="muted">{entry.noExecute && t(entry.noExecute.whyNot)}</p>
          <div className="row">
            <Link to={configureTo}>{t(entry.configureLabel)}</Link>
            {entry.run && (
              <button type="button" disabled={!agent || busy} onClick={check}>
                {busy ? t("Prüfe …") : t("Ergebnis prüfen")}
              </button>
            )}
          </div>
        </>
      )}
      {stepUp && <StepUpNote what={t(entry.execute?.label ?? entry.title)} />}
      {entry.noExecute && (
        <details>
          <summary>{t("Befehl für den Rechner")}</summary>
          <pre><code>{entry.noExecute.command}</code></pre>
          <div className="row">
            <button type="button" onClick={() => copyText(entry.noExecute!.command).then(setCopied)}>
              {copied ? t("Kopiert") : t("Befehl kopieren")}
            </button>
          </div>
          <p className="muted">{t(entry.noExecute.caution)}</p>
        </details>
      )}
      {result && <p role="status">{result}</p>}
      {failed && <p role="alert" className="error">{failed}</p>}
    </section>
  );
}

/**
 * Anleitungen für Funktionen, die bewusst nicht alle in der WebUI laufen:
 * erklären, zur Einstellungsseite verlinken, ausführen nur über bestehende BFF-Endpunkte. Keine Shell-Befehle aus dem Browser.
 */
export function GuidePage({ agent }: { agent?: AgentRef | null }) {
  const { hosts } = useHosts();
  const fallback: AgentRef | null = agent ?? (() => {
    const h = hosts?.[0];
    const r = h?.runtimes.find((x) => x.id === "hermes") ?? h?.runtimes[0];
    const a = r?.agents[0];
    return h && r && a ? { host: h.id, runtime: r.id, agent: a.id } : null;
  })();
  return (
    <main className="page">
      <PageHead title={t("Anleitungen")} sub={t("Einrichten und weiterleiten")} />
      {!fallback && <p className="muted" role="status">{t("Kein Agent verbunden. Befehle stehen trotzdem bereit.")}</p>}
      {GUIDE.map((entry) => <Entry key={entry.id} entry={entry} agent={fallback} />)}
    </main>
  );
}
