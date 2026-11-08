import { useEffect, useState } from "react";
import { api } from "../api";
import { useAction } from "./useAction";
import type { AgentRef, DistPreview, DistSource } from "../types";
import { t } from "../i18n";

const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Profil-Distributionen aus freigegebenen Quellen: erst Vorschau (Manifest, Dateien, Prüfsumme), dann Installieren oder Aktualisieren mit dem eingetippten Namen. */
export function DistributionPanel({ agent, onDone }: { agent: AgentRef; onDone: () => void }) {
  const [sources, setSources] = useState<DistSource[] | null>(null);
  const [loadErr, setLoadErr] = useState("");
  const [source, setSource] = useState("");
  const [mode, setMode] = useState<"install" | "update">("install");
  const [name, setName] = useState("");
  const [loaded, setLoaded] = useState<{ key: string; data: DistPreview } | null>(null);
  const [typed, setTyped] = useState("");
  const [force, setForce] = useState(false);
  const [forceConfig, setForceConfig] = useState(false);
  const [result, setResult] = useState("");
  const { run, notes, busy } = useAction();
  useEffect(() => {
    api.distSources(agent).then((r) => { setSources(r.sources); setSource((s) => s || r.sources[0]?.id || ""); }, (e: Error) => setLoadErr(e.message));
  }, [agent.host, agent.runtime, agent.agent]); // eslint-disable-line react-hooks/exhaustive-deps

  const reset = () => { setLoaded(null); setTyped(""); setForce(false); setForceConfig(false); setResult(""); };
  useEffect(() => { reset(); setName(""); }, [agent.host, agent.runtime, agent.agent]); // eslint-disable-line react-hooks/exhaustive-deps
  const subject = name.trim();
  const body = () => ({ source_id: source, ...(mode === "install" ? { name: subject } : { profile: subject }) });
  const key = JSON.stringify([source, mode, subject]);
  const preview = loaded && loaded.key === key ? loaded.data : null;   // eine Vorschau gilt nur für genau diese Eingabe
  const ready = Boolean(source) && NAME.test(subject);
  const apply = () => preview && run(async () => {
    const r = await api.distChange(agent, mode, { ...body(), digest: preview.digest, confirm: typed.trim(), ...(mode === "install" ? { force } : { force_config: forceConfig }) });
    setResult(t("{name} {version} ist {action}.", { name: r.name, version: r.version, action: mode === "install" ? t("installiert") : t("aktualisiert") }));
    setLoaded(null); setTyped(""); setForce(false); setForceConfig(false);
    onDone();
  });

  return (
    <section className="card tool-panel" role="region" aria-label={t("Distributionen")}>
      <b>{t("Distributionen")}</b>
      <p className="muted small" style={{ margin: 0 }}>{t("Eine Distribution bringt SOUL, MCP-Server, Skills und Zeitpläne mit: fremder Code mit den Rechten des Agents. Es gibt nur Quellen, die auf dem Rechner freigegeben sind. Du siehst erst die Vorschau; installiert wird genau das, was die Vorschau zeigt.")}</p>
      {loadErr && <p className="muted small">{loadErr}</p>}
      {sources && sources.length === 0 && <p className="muted small">{t("Keine Quelle freigegeben. Trage sie in der hostd-Konfiguration unter distribution_sources ein.")}</p>}
      {notes}
      {sources && sources.length > 0 && <>
        <label>{t("Quelle")} <select aria-label={t("Quelle")} disabled={busy} value={source} onChange={(e) => { setSource(e.target.value); reset(); }}>
          {sources.map((s) => <option key={s.id} value={s.id}>{s.label} ({s.source})</option>)}</select></label>
        <label>{t("Vorgang")} <select aria-label={t("Vorgang")} disabled={busy} value={mode} onChange={(e) => { setMode(e.target.value as "install" | "update"); reset(); }}>
          <option value="install">{t("Neu installieren")}</option><option value="update">{t("Vorhandenes Profil aktualisieren")}</option></select></label>
        <label>{mode === "install" ? t("Name des neuen Profils") : t("Profil")} <input aria-label={mode === "install" ? t("Name des neuen Profils") : t("Profil der Distribution")} disabled={busy} value={name} onChange={(e) => { setName(e.target.value.toLowerCase()); reset(); }} /></label>
        <div><button type="button" className="btn" disabled={busy || !ready} onClick={() => void run(async () => { setResult(""); const sent = key; setLoaded({ key: sent, data: (await api.distPreview(agent, body())).preview }); })}>{t("Vorschau laden")}</button></div>
        {result && <p role="status">{result}</p>}
        {preview && (
          <div role="group" aria-label={t("Vorschau")}>
            <p><strong>{preview.name}</strong> {preview.version}{preview.author ? ` · ${preview.author}` : ""}{preview.license ? ` · ${preview.license}` : ""}</p>
            {preview.description && <p>{preview.description}</p>}
            {preview.source && <p className="muted small">{t("Quelle: {source}", { source: preview.source })}</p>}
            {preview.has_mcp && <p className="banner">{t("Enthält mcp.json: Befehle, die der Agent startet.")}</p>}
            {preview.has_cron && <p className="banner">{t("Enthält Zeitpläne, die automatisch laufen.")}</p>}
            {(preview.risky_config?.length ?? 0) > 0 && <p className="banner">{t("Die config.yaml setzt: {keys}. Das kann Befehle starten.", { keys: preview.risky_config!.join(", ") })}</p>}
            {(preview.extra_top_level?.length ?? 0) > 0 && <p className="banner">{t("Bringt weitere Ordner mit: {names}", { names: preview.extra_top_level!.join(", ") })}</p>}
            {mode === "install" && preview.existing && preview.existing_is_distribution === false && <p className="banner">{t("Dieses Profil ist keine Distribution. Überschreiben ersetzt SOUL.md, mcp.json, config.yaml und gleichnamige Skills.")}</p>}
            {mode === "install" && preview.existing && preview.existing_is_distribution && <p className="muted small">{t("Überschreibt config.yaml und die Dateien der Distribution.")}</p>}
            {preview.hermes_requires && <p className="muted small">{t("Braucht Hermes {version}", { version: preview.hermes_requires })}</p>}
            {(preview.env_requires?.length ?? 0) > 0 && <p className="muted small">{t("Erwartet Umgebungsvariablen: {names}", { names: preview.env_requires!.map((e) => e.name).join(", ") })}</p>}
            <details><summary>{t("{count} Dateien", { count: preview.file_count })}</summary><ul>{preview.files.map((f) => <li key={f}><code>{f}</code></li>)}</ul></details>
            <p className="muted small">{t("Prüfsumme {digest}", { digest: preview.digest.slice(0, 12) })}</p>
            {mode === "install" && preview.existing && <label><input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} /> {t("Vorhandenes Profil überschreiben (Nutzerdaten bleiben)")}</label>}
            {mode === "update" && <label><input type="checkbox" checked={forceConfig} onChange={(e) => setForceConfig(e.target.checked)} /> {t("Auch config.yaml überschreiben")}</label>}
            <input aria-label={t("Zum Bestätigen den Profilnamen eintippen")} placeholder={subject} value={typed} onChange={(e) => setTyped(e.target.value)} />
            <button type="button" className="btn" disabled={busy || typed.trim() !== subject || (mode === "install" && preview.existing && !force)} onClick={() => void apply()}>
              {mode === "install" ? t("Installieren") : t("Aktualisieren")}</button>
          </div>)}
      </>}
    </section>
  );
}
