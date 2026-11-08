import { useMemo, useState, type CSSProperties, type DragEvent } from "react";
import { api } from "../api";
import { Icon } from "../components/Icon";
import { Link } from "../components/Link";
import { NEUTRAL_GLYPHS, Sigil, hashHue, sigilColor } from "../components/Sigil";
import { Tag } from "../components/profile/Tag";
import {
  DEFAULT_GLYPH, HUES, baseDraft, checkSvg, hasSvg, inputOf, nameOf, packOf, sigilOf, snippetOf, toDataUrl, type Draft,
} from "../components/profile/draft";
import { agentPath } from "../router";
import type { AgentRef } from "../types";
import { profileKey, sigilFor, useUi } from "../ui";
import { N_, t as tr } from "../i18n";

type Props = { agent: AgentRef; label: string; hostLabel: string; runtimeLabel: string };

const TABS = [["glyph", N_("Symbol")], ["initials", N_("Initialen")], ["svg", N_("Eigenes SVG")]] as const;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function readText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result ?? ""));
    r.onerror = () => reject(r.error);
    r.readAsText(file);
  });
}

function glyphMask(glyph: string): string {
  return packOf(glyph) === "neutral" ? `var(--i-${nameOf(glyph)})` : `url("/bff/ui/glyphs/${packOf(glyph)}/${nameOf(glyph)}.svg")`;
}

/** Profil bearbeiten: Sigil, Anzeigename, Vorschau. Gespeichert wird in der WebUI-Config (ui.json), nie in Hermes. */
export function ProfilePage({ agent, label, hostLabel, runtimeLabel }: Props) {
  const { sigils, labels, packs, writable, writeError, apply } = useUi();
  const key = profileKey(agent);
  const saved = sigilFor(sigils, agent);
  const savedLabel = labels[key] ?? labels[agent.agent];
  const exact = key in sigils || key in labels;
  const inherited = !exact && (agent.agent in sigils || agent.agent in labels);

  // Änderungen liegen über dem gespeicherten Stand; nach dem Speichern oder wenn die Config nachlädt gilt wieder dieser.
  const base = useMemo(() => baseDraft(saved, savedLabel), [saved, savedLabel]);
  const [edits, setEdits] = useState<Partial<Draft>>({});
  const [done, setDone] = useState<string>();
  const d: Draft = { ...base, ...edits };
  const change = (p: Partial<Draft>) => { setEdits((e) => ({ ...e, ...p })); setDone(undefined); };
  const dirty = (Object.keys(edits) as (keyof Draft)[]).some((k) => JSON.stringify(edits[k]) !== JSON.stringify(base[k]));

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [fileError, setFileError] = useState<string>();
  const [over, setOver] = useState(false);

  const name = d.label.trim() || agent.agent;
  const cfg = sigilOf(d);
  const packIds = ["neutral", ...Object.keys(packs)];
  const pack = packOf(d.glyph);
  const glyphs = pack === "neutral" ? [...NEUTRAL_GLYPHS] : packs[pack] ?? [];
  const valid = d.type === "svg" ? hasSvg(d) : d.type !== "glyph" || nameOf(d.glyph) !== "";
  const snippet = snippetOf(key, agent, d);
  const hueNow = typeof d.hue === "number" ? d.hue : hashHue(name);

  const submit = async (body: ReturnType<typeof inputOf> | { label: null; sigil: null }, message: string) => {
    setBusy(true); setError(undefined); setDone(undefined);
    try {
      apply(await api.saveProfile(key, body));
      setEdits({});
      setDone(message);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  const pickFile = async (file: File | undefined) => {
    if (!file) return;
    setFileError(undefined);
    try {
      const text = await readText(file);
      const problem = checkSvg(text, file.size);
      if (problem) { setFileError(problem); return; }
      change({ type: "svg", svg: { name: file.name, text, url: toDataUrl(text) } });
    } catch { setFileError(tr("Die Datei lässt sich nicht lesen.")); }
  };
  const onDrop = (e: DragEvent) => { e.preventDefault(); setOver(false); void pickFile(e.dataTransfer.files[0]); };

  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(snippet); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* keine Zwischenablage */ }
  };

  return (
    <main className="page">
      <header className="pf-head">
        <Link to={agentPath(agent)} className="btn btn-g btn-i" aria-label={tr("Zurück zu {label}", { label })}><Icon name="chevr" className="rot180" /></Link>
        <Sigil name={name} config={cfg} size="l" />
        <div className="col grow" style={{ gap: 4 }}>
          <span className="lbl">{tr("Profil bearbeiten · {hostLabel} / {runtimeLabel}", { hostLabel, runtimeLabel })}</span>
          <h1 className="trunc">{name}</h1>
        </div>
        <span className="hint">{tr("Das Sigil ist eine Einstellung pro Profil, nicht fest im Code.")}</span>
        <button type="button" className="btn btn-p" disabled={busy || !dirty || !valid || !writable}
          title={writable ? undefined : (writeError ?? undefined)}
          onClick={() => void submit(inputOf(agent, d), tr("Gespeichert"))}>
          <Icon name="check" size={14} />{tr("Speichern")}
        </button>
      </header>

      {!writable && (
        <p className="banner" role="status">
          <Icon name="alert" />
          <span>{tr("{writeError} Kopiere den Ausschnitt unten in deine ui.json, dann gilt er nach dem nächsten Laden.", { writeError: writeError ?? tr("Die WebUI darf die Config nicht ändern.") })}</span>
        </p>
      )}
      {error && <p className="banner" role="alert"><Icon name="alert" /><span>{error}</span></p>}
      {done && <p className="hint crimt" role="status" style={{ margin: 0 }}>{done}</p>}

      <div className="pf-grid">
        <section className="pf-s pf-c3" aria-label={tr("Allgemein")}>
          <span className="lbl">{tr("Allgemein")}</span>
          <div className="pf-fld">
            <label htmlFor="pf-label">{tr("Anzeigename")}</label>
            <input id="pf-label" className="pf-in" value={d.label} maxLength={40} placeholder={agent.agent} onChange={(e) => change({ label: e.target.value })} />
          </div>
          <div className="pf-fld">
            <label htmlFor="pf-folder">{tr("Profilordner (aus Hermes)")}</label>
            <input id="pf-folder" className="pf-in" value={agent.agent} readOnly />
          </div>
          {packIds.length > 1 && (
            <>
              <span className="lbl">{tr("Symbol-Pack")}</span>
              {packIds.map((id) => {
                const on = pack === id;
                return (
                  <button key={id} type="button" className={`pf-rd${on ? " on" : ""}`} aria-pressed={on}
                    onClick={() => change({ type: "glyph", glyph: id === "neutral" ? (pack === "neutral" ? d.glyph : DEFAULT_GLYPH) : `${id}/${packs[id][0] ?? ""}` })}>
                    <i className="radio" />
                    <div className="col" style={{ gap: 3 }}>
                      <span style={{ font: "600 13px var(--sans)" }}>{cap(id)} <Tag>{id === "neutral" ? "STANDARD" : "PACK"}</Tag></span>
                      <span className="t2" style={{ font: "400 12px/17px var(--sans)" }}>
                        {id === "neutral" ? `${NEUTRAL_GLYPHS.length} allgemeine Symbole plus Initialen. Passt zu jeder Hermes-Installation.` : `${packs[id].length} Symbole aus deiner Config.`}
                      </span>
                    </div>
                  </button>
                );
              })}
            </>
          )}
          <p className="hint" style={{ margin: 0 }}>{tr("Eigene Packs: eine JSON-Datei mit Name und Symbolen je Eintrag, abgelegt im Config-Ordner der WebUI (packs/<name>.json, in der ui.json unter „packs“ eintragen).")}</p>
          {inherited && <p className="hint" style={{ margin: 0 }}>{tr("Aktuell gilt der allgemeine Eintrag „{agent}“. Speichern legt einen eigenen Eintrag für {hostLabel} an.", { agent: agent.agent, hostLabel })}</p>}
        </section>

        <section className="pf-s pf-c5" aria-label={tr("Sigil")}>
          <span className="lbl">{tr("Sigil")}</span>
          <div className="pf-tabs" role="tablist">
            {TABS.map(([t, text]) => (
              <button key={t} type="button" role="tab" aria-selected={d.type === t} className={d.type === t ? "on" : ""} onClick={() => change({ type: t })}>{tr(text)}</button>
            ))}
          </div>

          {d.type === "glyph" && (
            <div className="pf-gg" role="group" aria-label={tr("Symbol wählen")}>
              {glyphs.map((g) => {
                const full = `${pack}/${g}`;
                return (
                  <button key={g} type="button" className={`pf-gb${full === d.glyph ? " on" : ""}`} aria-label={g} aria-pressed={full === d.glyph} title={g}
                    onClick={() => change({ glyph: full })}>
                    <i style={{ "--gm": glyphMask(full) } as CSSProperties} />
                  </button>
                );
              })}
            </div>
          )}

          {d.type === "initials" && (
            <div className="pf-fld">
              <label htmlFor="pf-text">{tr("Initialen (1 bis 3 Zeichen)")}</label>
              <input id="pf-text" className="pf-in" value={d.text} maxLength={3} placeholder={cfg.text ?? name.replace(/[^\p{L}\p{N}]/gu, "").slice(0, 2).toUpperCase()}
                onChange={(e) => change({ text: e.target.value })} style={{ maxWidth: 120 }} />
              <span className="hint">{tr("Leer: die ersten zwei Buchstaben des Namens.")}</span>
            </div>
          )}

          {d.type === "svg" && (
            <div className="col" style={{ gap: 8 }}>
              <label className={`pf-drop${over ? " over" : ""}`} onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={onDrop}>
                <input type="file" accept=".svg,image/svg+xml" aria-label={tr("SVG-Datei wählen")} onChange={(e) => { void pickFile(e.target.files?.[0]); e.target.value = ""; }} />
                <Icon name="export" size={20} />
                {d.svg ? <span><b>{d.svg.name}</b> {tr("gewählt. Zum Speichern bereinigt der Server die Datei.")}</span>
                  : d.savedSvg ? <span>{tr("Gespeichertes Symbol. Eine andere Datei hierher ziehen oder wählen.")}</span>
                  : <span>{tr("SVG hierher ziehen oder wählen")}</span>}
                <span className="hint">{tr("Einfarbig, höchstens 20 KB, ohne Skripte und externe Verweise.")}</span>
              </label>
              {fileError && <p className="error small" role="alert" style={{ margin: 0 }}>{fileError}</p>}
              {!hasSvg(d) && !fileError && <p className="hint" style={{ margin: 0 }}>{tr("Ohne Datei lässt sich dieses Sigil nicht speichern.")}</p>}
            </div>
          )}

          <span className="lbl">{tr("Farbton")}</span>
          <div className="pf-hues" role="group" aria-label={tr("Farbton")}>
            <button type="button" className={`pf-hb auto${d.hue === "auto" ? " on" : ""}`} aria-label={tr("Automatisch aus dem Namen")} aria-pressed={d.hue === "auto"} title={tr("Automatisch")} onClick={() => change({ hue: "auto" })} />
            {HUES.map((h) => (
              <button key={h} type="button" className={`pf-hb${d.hue === h ? " on" : ""}`} style={{ "--hb": sigilColor(h, name) } as CSSProperties}
                aria-label={`Farbton ${h}°`} aria-pressed={d.hue === h} title={`${h}°`} onClick={() => change({ hue: h })} />
            ))}
            <button type="button" className={`pf-hb neutral${d.hue === null ? " on" : ""}`} aria-label={tr("Neutral (grau)")} aria-pressed={d.hue === null} title={tr("Neutral")} onClick={() => change({ hue: null })} />
          </div>
          <label className="col" style={{ gap: 6 }}>
            <span className="lbl">{tr("Feinjustierung · {hueNow}°{hue}", { hueNow: Math.round(hueNow), hue: d.hue === "auto" ? " (automatisch)" : "" })}</span>
            <input type="range" className="pf-range hue" min={0} max={360} step={1} value={Math.round(hueNow)} aria-label={tr("Farbton fein einstellen")}
              onChange={(e) => change({ hue: Number(e.target.value) })} />
          </label>
          <p className="hint" style={{ margin: 0 }}>{tr("Helligkeit und Sättigung sind fest, nur der Farbton ist frei. Die Farbe hat auf allen dunklen Flächen einen Kontrast von über 8:1.")}</p>
        </section>

        <section className="pf-s pf-c4" aria-label={tr("Vorschau")}>
          <span className="lbl">{tr("Vorschau")}</span>
          <div className="pf-sizes">
            {(["xs", "s", "m", "l", "xl"] as const).map((s) => <Sigil key={s} name={name} config={cfg} size={s} />)}
          </div>
          <div className="pf-ctx">
            <Sigil name={name} config={cfg} size="xs" />
            <span className="grow trunc" style={{ fontWeight: 500 }}>{name}</span>
            <i className="dot dot-run" />
          </div>
          <div className="pf-ctx need">
            <Sigil name={name} config={cfg} size="l" state="wait" />
            <div className="col grow" style={{ gap: 2, minWidth: 0 }}>
              <span className="pf-nm trunc">{name}</span>
              <span className="pf-sub trunc">{agent.host}/{agent.runtime}</span>
            </div>
            <span className="tag tag-s">{tr("WARTET")}</span>
          </div>
          <div className="pf-ctx">
            <Sigil name={name} config={cfg} size="m" />
            <div className="col grow" style={{ gap: 2, minWidth: 0 }}>
              <span className="pf-nm trunc" style={{ fontSize: 13 }}>{name}</span>
              <span className="pf-sub trunc">{tr("Chat-Kopf · {host}", { host: agent.host })}</span>
            </div>
            <span className="tag tag-c"><i className="dot dot-run" />{tr("LÄUFT")}</span>
          </div>

          <span className="lbl">{writable ? tr("Gespeichert als") : tr("Eintrag für die ui.json")}</span>
          <div className="codeb">
            <div className="hd">{tr("ui.json")}<span className="row" style={{ marginLeft: "auto" }}>
              <button type="button" className="btn btn-s btn-g codeb-copy" onClick={() => void copy()}><Icon name="copy" size={12} />{copied ? tr("Kopiert") : tr("Kopieren")}</button>
            </span></div>
            <div className="pre numbered nw" role="region" aria-label={tr("Eintrag")}>
              {snippet.split("\n").map((line, i) => <div className="cl" key={i}><span className="ln">{i + 1}</span>{line}</div>)}
            </div>
          </div>
          <p className="hint" style={{ margin: 0 }}>
            {tr("Liegt in der WebUI-Config, nicht in Hermes. Ohne Eintrag: Initialen und ein Farbton aus dem Namen.{writable}", { writable: d.type === "svg" && !writable ? tr(" Die SVG-Datei legst du selbst unter sigils/ ab.") : "" })}</p>
          {exact && (
            <button type="button" className="btn btn-s" style={{ alignSelf: "flex-start" }} disabled={busy || !writable}
              title={writable ? undefined : (writeError ?? undefined)} onClick={() => void submit({ label: null, sigil: null }, tr("Auf Standard zurückgesetzt"))}>
              <Icon name="refresh" size={14} />{tr("Auf Standard zurücksetzen")}
            </button>
          )}
        </section>
      </div>
    </main>
  );
}
