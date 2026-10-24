import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../api";
import { parseSkills } from "../../capabilities";
import { composerApi, type FileEntry, type SlashCommand, type Workspace } from "../../composerApi";
import {
  EFFORTS, attachmentBlock, detectTrigger, formatRefValue, hasContextRefs, joinContext, loadReasoning, parseReasoningArg,
  parseSlashInput, reasoningLabel, saveReasoning, type Reasoning, type Trigger,
} from "../../composerLogic";
import { fileToDataUrl } from "../../images";
import type { ModelGroup } from "../../models";
import { agentKey } from "../../router";
import type { AgentRef, Queued, SkillInfo, SendMode } from "../../types";
import { Icon } from "../Icon";
import { usePreferences } from "../../preferences";

type Props = {
  agent: AgentRef;
  busy: boolean;
  disabled: boolean;
  name: string;
  models: ModelGroup[];
  model?: string;
  /** Modell, das der Agent ohne Auswahl nutzt (nur für die Beschriftung der Standardwahl). */
  defaultModel?: string;
  onModel: (m?: string) => void;
  /** Der Agent kann Nachrichten in einen laufenden Run einschieben. */
  canSteer: boolean;
  queued: Queued[];
  onSend: (text: string, images: string[], mode?: SendMode, reasoning?: Reasoning) => void;
  onStop: () => void;
  onNew: () => void;
  onSendQueued: (id: string) => void;
  onDropQueued: (id: string) => void;
};

type LocalFile = { name: string; content: string; size: number };
type Problem = { message: string; items?: string[]; force?: boolean };
type Item = { id: string; group: string; label: string; detail?: string; note?: string; disabled?: boolean; insert: string; keepOpen?: boolean };

const MODE_HINT: Record<SendMode, string> = { steer: "nach dem nächsten Tool-Call einschieben", queue: "als nächsten Turn vormerken" };
const MAX_TEXT_FILES = 5;
const MAX_TEXT_BYTES = 100 * 1024;
const MAX_IMAGES = 4;
const MAX_ITEMS = 60;

const readText = (f: File) => new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = () => rej(new Error(`${f.name}: nicht lesbar`)); r.readAsText(f); });
const lower = (s: string) => s.toLowerCase();
const wsKey = (host: string) => `hermes-webui-workspace:${host}`;

export function Composer(p: Props) {
  const key = agentKey(p.agent);
  const prefs = usePreferences();
  const hostEffort = prefs.hosts[p.agent.host]?.effort ?? "agent";
  const hostReasoning = (): Reasoning | undefined => hostEffort === "agent" ? undefined : hostEffort === "off" ? { thinking: false } : { thinking: true, effort: hostEffort };
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [images, setImages] = useState<string[]>([]);
  const [files, setFiles] = useState<LocalFile[]>([]);
  const [problem, setProblem] = useState<Problem>();
  const [sending, setSending] = useState(false);
  const [chosen, setChosen] = useState<SendMode>("steer");
  const [reasoning, setReasoning] = useState<Reasoning | undefined>(() => loadReasoning(key) ?? hostReasoning());
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<string>();
  const [dragging, setDragging] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const modelSel = useRef<HTMLSelectElement>(null);
  const optionsBox = useRef<HTMLDivElement>(null);
  const mode: SendMode = p.canSteer ? chosen : "queue";

  // Aufwand je Agent merken und beim Agentwechsel wiederherstellen.
  useEffect(() => { setReasoning(loadReasoning(key) ?? hostReasoning()); }, [key, hostEffort]);
  const pickReasoning = useCallback((r?: Reasoning) => { setReasoning(r); saveReasoning(key, r); }, [key]);

  // --- Arbeitsordner --------------------------------------------------------------------
  const [workspaces, setWorkspaces] = useState<{ state: "loading" | "ready" | "unavailable"; list: Workspace[]; reason?: string }>({ state: "loading", list: [] });
  const [workspace, setWorkspace] = useState<string>("");
  useEffect(() => {
    let stale = false;
    setWorkspaces({ state: "loading", list: [] });
    composerApi.workspaces(p.agent.host)
      .then((r) => {
        if (stale) return;
        setWorkspaces({ state: "ready", list: r.workspaces });
        let saved = ""; try { saved = localStorage.getItem(wsKey(p.agent.host)) ?? ""; } catch { /* privater Modus */ }
        const preferred = prefs.hosts[p.agent.host]?.workspace || saved;
        setWorkspace(r.workspaces.some((w) => w.id === preferred) ? preferred : "");
      })
      .catch((e: Error) => { if (!stale) { setWorkspaces({ state: "unavailable", list: [], reason: e.message }); setWorkspace(""); } });
    return () => { stale = true; };
  }, [p.agent.host]);
  const pickWorkspace = (id: string) => { setWorkspace(id); try { localStorage.setItem(wsKey(p.agent.host), id); } catch { /* privater Modus */ } };
  const refsNote = workspaces.state === "unavailable" ? "Kein Host-Dienst: Bezüge auf Dateien und Git sind nicht verfügbar"
    : workspaces.state === "loading" ? "Arbeitsordner werden geladen" : "Erst einen Arbeitsordner wählen";
  const refsReady = workspaces.state === "ready" && !!workspace;

  // --- Slash-Daten (erst beim ersten `/` laden) -----------------------------------------
  const [slash, setSlash] = useState<{ state: "idle" | "loading" | "ready" | "error"; commands: SlashCommand[]; skills: SkillInfo[]; error?: string }>({ state: "idle", commands: [], skills: [] });
  const slashLoad = useRef<Promise<{ commands: SlashCommand[]; skills: SkillInfo[] }>>();
  useEffect(() => { slashLoad.current = undefined; setSlash({ state: "idle", commands: [], skills: [] }); }, [key]);
  const ensureSlash = useCallback(() => {
    if (!slashLoad.current) {
      setSlash((s) => ({ ...s, state: "loading" }));
      slashLoad.current = Promise.all([
        composerApi.commands(p.agent).then((r) => r.commands),
        api.skills(p.agent).then(parseSkills).catch(() => [] as SkillInfo[]),  // ohne Skill-Liste bleiben die Befehle nutzbar
      ]).then(([commands, skills]) => { setSlash({ state: "ready", commands, skills }); return { commands, skills }; })
        .catch((e: Error) => { slashLoad.current = undefined; setSlash({ state: "error", commands: [], skills: [], error: e.message }); throw e; });
    }
    return slashLoad.current;
  }, [p.agent]);

  // --- Menü ----------------------------------------------------------------------------
  const trigger: Trigger | undefined = useMemo(() => detectTrigger(text, caret), [text, caret]);
  const triggerId = trigger ? `${trigger.kind}:${trigger.start}:${trigger.query}` : undefined;
  useEffect(() => { if (!trigger) setDismissed(undefined); }, [trigger]);
  useEffect(() => { if (trigger?.kind === "slash") void ensureSlash().catch(() => undefined); }, [trigger?.kind, ensureSlash]);
  useEffect(() => { setActive(0); }, [trigger?.query, trigger?.kind]);

  const [listing, setListing] = useState<{ dir: string; entries: FileEntry[] } | { dir: string; error: string }>();
  const pathMode = trigger?.kind === "at" ? /^(file|folder):(.*)$/.exec(trigger.query) : null;
  const pathDir = pathMode ? pathMode[2].replace(/^[`"']/, "").split("/").slice(0, -1).join("/") : undefined;
  useEffect(() => {
    if (!pathMode || !refsReady || pathDir === undefined) { setListing(undefined); return; }
    let stale = false;
    composerApi.files(p.agent.host, workspace, pathDir)
      .then((r) => { if (!stale) setListing({ dir: pathDir, entries: r.entries }); })
      .catch((e: Error) => { if (!stale) setListing({ dir: pathDir, error: e.message }); });
    return () => { stale = true; };
  }, [pathMode?.[1], pathDir, refsReady, workspace, p.agent.host]);  // eslint-disable-line react-hooks/exhaustive-deps

  const items: Item[] = useMemo(() => {
    if (!trigger) return [];
    const q = lower(trigger.query);
    if (trigger.kind === "slash") {
      const out: Item[] = [];
      const skills = slash.skills.filter((s) => s.enabled !== false && lower(s.name).includes(q))
        .sort((a, b) => Number(!lower(a.name).startsWith(q)) - Number(!lower(b.name).startsWith(q)));
      for (const s of skills) out.push({ id: `s:${s.name}`, group: "Skills", label: `/${s.name}`, detail: s.description, insert: `/${s.name} ` });
      for (const c of slash.commands.filter((c) => lower(c.name).includes(q) || c.aliases.some((a) => lower(a).includes(q)))) {
        const ok = c.status === "webui";
        out.push({
          id: `c:${c.name}`, group: "Hermes-Befehle", label: `/${c.name}${c.args_hint ? ` ${c.args_hint}` : ""}`,
          detail: c.description, disabled: !ok,
          note: ok ? `In der WebUI umgesetzt. ${c.note}` : c.note, insert: `/${c.name} `,
        });
      }
      return out.slice(0, MAX_ITEMS);
    }
    // @-Bezüge
    if (pathMode) {
      if (!refsReady) return [{ id: "n", group: "Bezüge", label: `@${pathMode[1]}:`, note: refsNote, disabled: true, insert: "" }];
      const kind = pathMode[1] as "file" | "folder";
      const typed = pathMode[2].replace(/^[`"']/, "");
      const base = typed.includes("/") ? typed.slice(0, typed.lastIndexOf("/") + 1) : "";
      const part = lower(typed.slice(base.length));
      if (!listing || "error" in listing) return [{ id: "e", group: "Bezüge", label: listing ? "Liste nicht ladbar" : "Lade …", note: listing?.error, disabled: true, insert: "" }];
      return listing.entries.filter((e) => lower(e.name).startsWith(part) && (kind === "file" || e.kind === "directory"))
        .slice(0, MAX_ITEMS).map((e): Item => {
          const dir = e.kind === "directory";
          const path = base + e.name;
          return dir && kind === "file"
            ? { id: `p:${path}`, group: "Bezüge", label: `${e.name}/`, detail: "Ordner öffnen", insert: `@file:${formatRefValue(path + "/")}`, keepOpen: true }
            : { id: `p:${path}`, group: "Bezüge", label: dir ? `${e.name}/` : e.name, detail: dir ? "Ordner anhängen" : `${e.size} Bytes`, insert: `@${kind}:${formatRefValue(path)} ` };
        });
    }
    const out: Item[] = [];
    const gitNote = refsReady ? undefined : refsNote;
    const base: [string, string, string, boolean][] = [
      ["@diff", "git diff (offene Änderungen)", "@diff ", true], ["@staged", "git diff --staged (vorgemerkte Änderungen)", "@staged ", true],
      ["@file:", "Datei anhängen", "@file:", true], ["@folder:", "Ordner anhängen (Auflistung)", "@folder:", true],
      ["@url:", "Adresse für den Agent (das BFF holt nie fremde Adressen)", "@url:", false], ["@git:", "git log der letzten n Commits, z. B. @git:3", "@git:", true],
    ];
    for (const [label, detail, insert, needsWs] of base.filter(([l]) => lower(l).slice(1).startsWith(q))) {
      out.push({ id: label, group: "Bezüge", label, detail, insert, keepOpen: insert.endsWith(":"), disabled: needsWs && !refsReady, note: needsWs ? gitNote : undefined });
    }
    return out;
  }, [trigger, slash, pathMode, refsReady, refsNote, listing]);  // eslint-disable-line react-hooks/exhaustive-deps
  // In 1:1-Chats kennt das Backend keine @Profile (expand() nur diff/staged/file/folder/git/url) — keine wirkungslosen Vorschlaege.

  const menuOpen = !!trigger && triggerId !== dismissed && (items.length > 0 || (trigger.kind === "slash" && slash.state !== "ready") || trigger.kind === "at");
  const selectable = items.filter((i) => !i.disabled);
  const activeItem = selectable[Math.min(active, selectable.length - 1)];

  const replaceRange = (insert: string, keepOpen?: boolean) => {
    if (!trigger) return;
    const next = text.slice(0, trigger.start) + insert + text.slice(caret);
    const pos = trigger.start + insert.length;
    setText(next);
    setCaret(pos);
    if (!keepOpen) setDismissed(undefined);
    requestAnimationFrame(() => { area.current?.focus(); area.current?.setSelectionRange(pos, pos); });
  };
  const pick = (item: Item) => { if (!item.disabled) replaceRange(item.insert, item.keepOpen); };

  // Klick außerhalb schließt das Optionen-Menü.
  useEffect(() => {
    if (!optionsOpen) return;
    const close = (e: MouseEvent) => { if (!optionsBox.current?.contains(e.target as Node)) setOptionsOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [optionsOpen]);

  // --- Anhänge ---------------------------------------------------------------------------
  const addFiles = async (list: File[]) => {
    setProblem(undefined);
    const errors: string[] = [];
    const imgs = list.filter((f) => f.type.startsWith("image/"));
    const texts = list.filter((f) => !f.type.startsWith("image/"));
    try {
      const urls = await Promise.all(imgs.slice(0, MAX_IMAGES - images.length).map(fileToDataUrl));
      if (urls.length) setImages((cur) => [...cur, ...urls].slice(0, MAX_IMAGES));
      if (imgs.length > MAX_IMAGES - images.length) errors.push(`Höchstens ${MAX_IMAGES} Bilder je Nachricht.`);
    } catch (e) { errors.push((e as Error).message); }
    const added: LocalFile[] = [];
    for (const f of texts) {
      if (files.length + added.length >= MAX_TEXT_FILES) { errors.push(`Höchstens ${MAX_TEXT_FILES} Dateien je Nachricht.`); break; }
      if (f.size > MAX_TEXT_BYTES) { errors.push(`${f.name}: zu groß (über ${MAX_TEXT_BYTES / 1024} KB).`); continue; }
      const content = await readText(f);
      if (content.includes("\u0000")) { errors.push(`${f.name}: keine Textdatei.`); continue; }
      added.push({ name: f.name, content, size: f.size });
    }
    if (added.length) setFiles((cur) => [...cur, ...added]);
    if (errors.length) setProblem({ message: errors.join(" ") });
  };

  // --- Senden ----------------------------------------------------------------------------
  const runCommand = (cmd: SlashCommand, args: string): boolean => {
    if (cmd.status !== "webui") { setProblem({ message: `/${cmd.name}: ${cmd.note}`, force: true }); return false; }
    switch (cmd.name) {
      case "new": p.onNew(); return true;
      case "stop":
        if (!p.busy) { setProblem({ message: "/stop: Es läuft gerade nichts." }); return false; }
        p.onStop(); return true;
      case "reasoning": {
        const parsed = parseReasoningArg(args);
        if (parsed === undefined) { setOptionsOpen(true); return true; }
        if (parsed === "invalid") { setProblem({ message: `/reasoning: Unbekannte Stufe „${args}“. Erlaubt: ${EFFORTS.map((e) => e.label.toLowerCase()).join(", ")}, aus, an, standard. Anzeige-Optionen (show, hide) gibt es nur im Terminal.` }); return false; }
        pickReasoning(parsed.value); return true;
      }
      case "model":
        if (!modelSel.current) { setProblem({ message: "/model: Für diesen Agent liegt keine Modellliste vor." }); return false; }
        modelSel.current.focus(); return true;
    }
    return false;
  };

  const submit = async (force = false) => {
    const raw = text.trim();
    if (!raw || p.disabled || sending) return;
    if (p.busy && mode === "steer" && (images.length || files.length)) { setProblem({ message: "Anhänge lassen sich nur vormerken (Queue), nicht einschieben." }); return; }
    setProblem(undefined);
    setSending(true);
    try {
      let out = raw;
      const cmd = force ? undefined : parseSlashInput(raw);
      if (cmd) {
        const known = await ensureSlash().catch((e: Error) => { setProblem({ message: `Befehlsliste nicht ladbar: ${e.message}`, force: true }); return undefined; });
        if (!known) return;
        const lc = lower(cmd.name);
        const core = known.commands.find((c) => c.name === lc || c.aliases.includes(lc));
        if (core) {
          if (runCommand(core, cmd.args)) { setText(""); setCaret(0); }
          return;
        }
        const skill = known.skills.find((s) => lower(s.name) === lc || lower(s.name.replace(/_/g, "-")) === lc);
        if (!skill) { setProblem({ message: `Unbekannter Befehl /${cmd.name}. Die Liste zeigt alle Skills und Befehle.`, force: true }); return; }
        try { out = (await composerApi.skill(p.agent, skill.name, cmd.args)).text; }
        catch (e) { setProblem({ message: `Skill /${skill.name} nicht ladbar: ${(e as Error).message}` }); return; }
      }
      if (hasContextRefs(out)) {
        try {
          const r = await composerApi.expand(p.agent.host, workspace, out);
          if (r.blocked) { setProblem({ message: `Zu viel Kontext: ${r.warnings.at(-1) ?? "Grenze überschritten"}. Bezüge verkleinern.` }); return; }
          const bad = r.refs.filter((x) => !x.ok);
          if (bad.length && !force) { setProblem({ message: "Nicht alle Bezüge lassen sich anhängen.", items: bad.map((b) => `${b.raw}: ${b.error}`), force: true }); return; }
          out = r.text;
        } catch (e) { setProblem({ message: `Bezüge nicht expandierbar: ${(e as Error).message}`, force: true }); return; }
      }
      out = joinContext(out, files.map((f) => attachmentBlock(f.name, f.content)));
      p.onSend(out, images, p.busy ? mode : undefined, reasoning);
      setText(""); setCaret(0); setImages([]); setFiles([]);
    } finally { setSending(false); }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (menuOpen && trigger) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        if (selectable.length) { e.preventDefault(); setActive((a) => (a + (e.key === "ArrowDown" ? 1 : selectable.length - 1)) % selectable.length); }
        return;
      }
      if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
        // Steht der Befehl schon vollständig da, sendet Enter ihn, statt nur ein Leerzeichen anzuhängen.
        const complete = e.key === "Enter" && activeItem && activeItem.insert.trim() === text.slice(trigger.start, caret);
        if (activeItem && !complete) { e.preventDefault(); pick(activeItem); return; }
        if (e.key === "Tab") return;
      }
      if (e.key === "Escape") { e.preventDefault(); setDismissed(triggerId); return; }
    } else if (e.key === "Escape" && optionsOpen) { setOptionsOpen(false); return; }
    if (e.key === "Enter" && !e.shiftKey && (prefs.enterSends || e.ctrlKey || e.metaKey)) { e.preventDefault(); void submit(); }
  };

  const placeholder = p.disabled ? `${p.name} ist nicht erreichbar` : p.busy ? `Nachricht an ${p.name} … · ${MODE_HINT[mode]}` : `Nachricht an ${p.name}…`;
  const groups = [...new Set(items.map((i) => i.group))];
  let index = -1;

  return (
    <div className="dockw">
      <form className={`dock composer${p.busy ? " busy" : ""}${dragging ? " drop" : ""}`}
        onSubmit={(e) => { e.preventDefault(); void submit(); }}
        onDragOver={(e) => { if ([...e.dataTransfer.types].includes("Files")) { e.preventDefault(); setDragging(true); } }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { setDragging(false); const dropped = [...e.dataTransfer.files]; if (dropped.length) { e.preventDefault(); void addFiles(dropped); } }}>
        {p.queued.length > 0 && (
          <ul className="queue" aria-label="Vorgemerkte Nachrichten">
            {p.queued.map((q) => (
              <li key={q.id} className="row">
                <span className="tag tag-c">QUEUE</span>
                <span className="trunc grow">{q.text}</span>
                {!p.busy && <button type="button" className="btn btn-s" onClick={() => p.onSendQueued(q.id)}>Jetzt senden</button>}
                <button type="button" className="btn btn-s btn-i btn-g" aria-label="Vorgemerkte Nachricht entfernen" onClick={() => p.onDropQueued(q.id)}><Icon name="x" size={12} /></button>
              </li>
            ))}
          </ul>
        )}
        <div className="chips"><span className="cx on"><Icon name="chat" size={12} />@{p.name}</span>
          <span className="cmp-hint" id="cmp-hint">/ Befehle und Skills · @ Dateien, Git, Adressen</span>
          {files.map((f, i) => (
            <span key={`${f.name}-${i}`} className="cx file-chip"><Icon name="clip" size={12} />{f.name} · {Math.max(1, Math.round(f.size / 1024))} KB
              <button type="button" className="chip-x" aria-label={`Anhang ${f.name} entfernen`} onClick={() => setFiles(files.filter((_, j) => j !== i))}><Icon name="x" size={12} /></button></span>
          ))}
        </div>
        {images.length > 0 && (
          <div className="thumbs">
            {images.map((src, i) => (
              <span key={i} className="thumb">
                <img src={src} alt={`Anhang ${i + 1}`} />
                <button type="button" className="btn btn-s btn-i" aria-label={`Anhang ${i + 1} entfernen`} onClick={() => setImages(images.filter((_, j) => j !== i))}><Icon name="x" size={12} /></button>
              </span>
            ))}
          </div>
        )}
        {problem && (
          <div className="error small cmp-problem" role="alert">
            <p>{problem.message}</p>
            {problem.items && <ul>{problem.items.map((m) => <li key={m}>{m}</li>)}</ul>}
            {problem.force && <button type="button" className="btn btn-s" onClick={() => void submit(true)}>Trotzdem als Text senden</button>}
          </div>
        )}
        {menuOpen && trigger && (
          <div className="cmp-menu" role="listbox" aria-label={trigger.kind === "slash" ? "Befehle und Skills" : "Bezüge"} id="cmp-menu">
            {trigger.kind === "slash" && slash.state === "loading" && <p className="cmp-empty" role="status">Lade Befehle …</p>}
            {trigger.kind === "slash" && slash.state === "error" && <p className="cmp-empty" role="alert">Befehle nicht ladbar: {slash.error}</p>}
            {slash.state === "ready" && trigger.kind === "slash" && items.length === 0 && <p className="cmp-empty">Kein Befehl und kein Skill passt zu „/{trigger.query}“.</p>}
            {groups.map((g) => (
              <div key={g} role="group" aria-label={g}>
                <div className="cmp-group">{g}</div>
                {items.filter((i) => i.group === g).map((i) => {
                  const idx = i.disabled ? -1 : ++index;
                  const on = !i.disabled && activeItem?.id === i.id;
                  return (
                    <div key={i.id} id={`cmp-${i.id}`} role="option" aria-selected={on} aria-disabled={i.disabled || undefined}
                      className={`cmp-item${on ? " on" : ""}${i.disabled ? " off" : ""}`}
                      onMouseDown={(e) => { e.preventDefault(); pick(i); }} onMouseEnter={() => { if (idx >= 0) setActive(idx); }}>
                      <span className="mono cmp-label">{i.label}</span>
                      {i.detail && <span className="cmp-detail trunc">{i.detail}</span>}
                      {i.note && <span className="cmp-note">{i.note}</span>}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={area}
          value={text}
          rows={1}
          placeholder={placeholder}
          aria-label="Nachricht"
          aria-autocomplete="list"
          aria-describedby="cmp-hint"
          aria-controls={menuOpen ? "cmp-menu" : undefined}
          aria-activedescendant={menuOpen && activeItem ? `cmp-${activeItem.id}` : undefined}
          onChange={(e) => { setText(e.target.value); setCaret(e.target.selectionStart); }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          onPaste={(e) => {
            const pasted = [...e.clipboardData.files];
            if (pasted.length) { e.preventDefault(); void addFiles(pasted); }
          }}
          onKeyDown={onKeyDown}
        />
        <div className="bar">
          <button type="button" className="btn btn-s btn-i btn-g" aria-label="Datei hinzufügen" onClick={() => fileInput.current?.click()}><Icon name="plus" size={14} /></button>
          <input ref={fileInput} type="file" multiple hidden aria-label="Dateien auswählen"
            onChange={(e) => { void addFiles([...(e.target.files ?? [])]); e.target.value = ""; }} />
          <div className="opt-wrap" ref={optionsBox}>
            <button type="button" className="btn btn-s opt-btn" aria-haspopup="dialog" aria-expanded={optionsOpen} onClick={() => setOptionsOpen(!optionsOpen)}>
              <Icon name="sliders" size={14} /><span>Denken: {reasoningLabel(reasoning)}</span>
            </button>
            {optionsOpen && (
              <div className="opt-menu" role="dialog" aria-label="Optionen" onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setOptionsOpen(false); } }}>
                <label className="opt-row">
                  <span>Denken</span>
                  <input type="checkbox" role="switch" checked={reasoning ? reasoning.thinking : true} aria-label="Denken"
                    onChange={(e) => pickReasoning({ thinking: e.target.checked, effort: e.target.checked ? reasoning?.effort : undefined })} />
                </label>
                <div className="opt-title" id="opt-effort">Aufwand</div>
                <div role="radiogroup" aria-labelledby="opt-effort">
                  <button type="button" role="radio" aria-checked={reasoning === undefined} className="opt-item" onClick={() => pickReasoning(undefined)}>
                    <span>Standard des Agents</span>{reasoning === undefined && <Icon name="check" size={14} />}
                  </button>
                  {EFFORTS.map((e) => {
                    const on = !!reasoning?.thinking && reasoning.effort === e.value;
                    return (
                      <button key={e.value} type="button" role="radio" aria-checked={on} className="opt-item" onClick={() => pickReasoning({ thinking: true, effort: e.value })}>
                        <span>{e.label}</span>{on && <Icon name="check" size={14} />}
                      </button>
                    );
                  })}
                </div>
                <p className="opt-hint">Gilt für diesen Agent und wird gemerkt. „Standard“ sendet nichts, der Agent nutzt dann seinen eigenen Wert.</p>
              </div>
            )}
          </div>
          {workspaces.state !== "loading" && (
            <span className="tag tag-m tag-act ws-sel" title={workspaces.state === "unavailable" ? `${workspaces.reason ?? "Kein Host-Dienst"}` : "Arbeitsordner für @file, @folder, @diff, @staged und @git"}>
              <Icon name="folder" size={12} />
              <select value={workspace} onChange={(e) => pickWorkspace(e.target.value)} aria-label="Arbeitsordner" disabled={workspaces.state !== "ready" || workspaces.list.length === 0}>
                <option value="">{workspaces.state === "unavailable" ? "Kein Host-Dienst" : workspaces.list.length ? "Kein Arbeitsordner" : "Keine Arbeitsordner"}</option>
                {workspaces.list.map((w) => <option key={w.id} value={w.id}>{w.label}</option>)}
              </select>
            </span>
          )}
          {p.busy && (
            <span className="seg" role="group" aria-label="Wirkung der Nachricht">
              {p.canSteer && <button type="button" className={mode === "steer" ? "on" : ""} aria-pressed={mode === "steer"} onClick={() => setChosen("steer")}>Steer</button>}
              <button type="button" className={mode === "queue" ? "on" : ""} aria-pressed={mode === "queue"} onClick={() => setChosen("queue")}>Queue</button>
            </span>
          )}
          {p.models.some((g) => g.models.length > 0) && (
            <span className="tag tag-m tag-act model-sel">
              <select ref={modelSel} value={p.model ?? ""} onChange={(e) => p.onModel(e.target.value || undefined)} aria-label="Modell">
                <option value="">{p.defaultModel ? `Standard · ${p.defaultModel}` : "Standardmodell"}</option>
                {p.models.length === 1
                  ? p.models[0].models.map((m) => <option key={m} value={m}>{m}</option>)
                  : p.models.map((g) => (
                    <optgroup key={g.provider} label={g.label}>{g.models.map((m) => <option key={`${g.provider}/${m}`} value={m}>{m}</option>)}</optgroup>
                  ))}
              </select>
              <Icon name="chevd" size={12} />
            </span>
          )}
          {p.busy && <button type="button" className="btn btn-s btn-d btn-i" aria-label="Stopp" onClick={p.onStop}><Icon name="stop" size={12} /></button>}
          <button type="submit" className="btn btn-p btn-i" aria-label="Senden" disabled={!text.trim() || p.disabled || sending}><Icon name="send" size={14} /></button>
        </div>
      </form>
    </div>
  );
}
