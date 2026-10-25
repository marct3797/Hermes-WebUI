import { useState } from "react";
import { GUIDE, type GuideEntry } from "../guide";
import { PageHead } from "../components/PageHead";
import { Link } from "../components/Link";
import { useHosts } from "../hosts";
import type { AgentRef } from "../types";
import { t } from "../i18n";

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Rueckfall: Text zum Markieren auswaehlen (z. B. ohne Clipboard-Rechte).
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

  return (
    <section className="card" aria-label={entry.title}>
      <h2>{entry.title}</h2>
      <p>{entry.purpose}</p>
      <p className="muted">{entry.whyNot}</p>
      <pre><code>{entry.command}</code></pre>
      <div className="row">
        <button type="button" onClick={() => copyText(entry.command).then(setCopied)}>
          {copied ? t("Kopiert") : t("Befehl kopieren")}
        </button>
        {entry.run && (
          <button type="button" disabled={!agent || busy} onClick={check}>
            {busy ? t("Pruefe…") : t("Ergebnis pruefen")}
          </button>
        )}
      </div>
      <p className="muted">{entry.caution}</p>
      {!entry.run && entry.linkHref && (
        <p className="muted">{entry.linkLabel} <Link to={entry.linkHref}>{entry.linkHref}</Link></p>
      )}
      {result && <p role="status">{result}</p>}
      {failed && <p role="alert" className="error">{failed}</p>}
    </section>
  );
}

/**
 * Anleitungen fuer Funktionen, die bewusst nicht in der WebUI laufen:
 * erklaeren, exakten Befehl zeigen, Ergebnis ueber Lese-Routen pruefen. Kein POST/PUT/DELETE.
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
      <PageHead title={t("Anleitungen")} sub={t("Auf dem Rechner ausfuehren")} />
      {!fallback && <p className="muted" role="status">{t("Kein Agent verbunden. Befehle stehen trotzdem bereit.")}</p>}
      {GUIDE.map((entry) => <Entry key={entry.id} entry={entry} agent={fallback} />)}
    </main>
  );
}
