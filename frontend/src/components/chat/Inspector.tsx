import { useState } from "react";
import { fmtDuration, fmtTimeSec, toolIcon } from "../../format";
import type { Item } from "../../types";
import { Icon } from "../Icon";
import { SubagentCard } from "./Convo";

type Tool = Extract<Item, { kind: "tool" }>;
type Subagent = Extract<Item, { kind: "subagent" }>;

type Props = { tools: Tool[]; subagents: Subagent[]; selected?: string; onSelect: (id: string) => void };

const TAG: Record<Tool["status"], string> = { running: "LÄUFT", ok: "FERTIG", error: "FEHLER" };

/** Preview als Schlüssel-Wert-Zeilen, wenn sie JSON ist; sonst als Text. */
function previewLines(preview: string): Array<[string, string] | string> {
  try {
    const v: unknown = JSON.parse(preview);
    if (v && typeof v === "object" && !Array.isArray(v)) return Object.entries(v).map(([k, val]) => [k, typeof val === "string" ? val : JSON.stringify(val)]);
  } catch { /* kein JSON */ }
  return preview.split("\n");
}

export function Inspector({ tools, subagents, selected, onSelect }: Props) {
  const [tab, setTab] = useState<"tool" | "worker">("tool");
  const tool = tools.find((t) => t.id === selected) ?? tools[tools.length - 1];
  const [copied, setCopied] = useState(false);
  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* keine Zwischenablage */ }
  };

  return (
    <aside className="insp" aria-label="Inspector">
      <div className="tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === "tool"} className={`tab${tab === "tool" ? " on" : ""}`} onClick={() => setTab("tool")}>Tool<span className="n">{tools.length}</span></button>
        <button type="button" role="tab" aria-selected={tab === "worker"} className={`tab${tab === "worker" ? " on" : ""}`} onClick={() => setTab("worker")}>Worker<span className="n">{subagents.length}</span></button>
      </div>

      {tab === "tool" && (
        <div className="ip" role="tabpanel" aria-label="Tool">
          {!tool && <p className="muted small">Noch keine Tool-Aufrufe in diesem Chat.</p>}
          {tool && (
            <>
              <div className="col" style={{ gap: 6 }}>
                <div className="row" style={{ gap: 8 }}>
                  <Icon name={toolIcon(tool.name)} size={14} className="t2" />
                  <span className="mono" style={{ fontWeight: 600, fontSize: 13 }}>{tool.name}</span>
                  <span className={`tag${tool.status === "error" ? " tag-e" : tool.status === "running" ? " tag-c" : ""}`} style={{ marginLeft: "auto" }}>{TAG[tool.status]}</span>
                </div>
                <span className="mono t3" style={{ fontSize: 10.5 }}>
                  {[tool.at ? fmtTimeSec(tool.at) : "", tool.durationMs != null ? fmtDuration(tool.durationMs) : ""].filter(Boolean).join(" · ")}
                </span>
              </div>
              {tool.preview && (
                <div className="col" style={{ gap: 8 }}>
                  <span className="lbl">Vorschau</span>
                  <div className="codeb"><div className="pre insp-pre">
                    {previewLines(tool.preview).map((l, i) => (
                      <div className="cl" key={i}>{typeof l === "string" ? l : <><span className="t3">{l[0]}</span>: <span className="str">{l[1]}</span></>}</div>
                    ))}
                  </div></div>
                </div>
              )}
              <div className="col" style={{ gap: 8 }}>
                <span className="lbl">Ausgabe</span>
                <div className="codeb">
                  <div className="hd">ausgabe
                    {tool.output && <span className="row" style={{ marginLeft: "auto" }}>
                      <button type="button" className="btn btn-s btn-g codeb-copy" aria-label="Ausgabe kopieren" onClick={() => void copy(tool.output!)}><Icon name="copy" size={12} />{copied ? "Kopiert" : ""}</button>
                    </span>}
                  </div>
                  <div className="pre nw insp-pre">
                    {tool.output
                      ? tool.output.split("\n").map((l, i) => <div className="cl" key={i}>{l || " "}</div>)
                      : <div className="cl t3">{tool.status === "running" ? "läuft …" : "(keine Ausgabe)"}</div>}
                  </div>
                </div>
              </div>
            </>
          )}
          {tools.length > 0 && (
            <div className="col" style={{ gap: 8 }}>
              <div className="row"><span className="lbl">Alle Tool-Aufrufe</span><span className="mono t3" style={{ marginLeft: "auto", fontSize: 10.5 }}>{tools.length}</span></div>
              <div className="tl">
                {tools.map((t) => (
                  <button key={t.id} type="button" className={`st${t.id === tool?.id ? " sel" : ""}`} onClick={() => onSelect(t.id)}>
                    <Icon name={t.status === "error" ? "x" : t.status === "running" ? "clock" : toolIcon(t.name)} size={14} className={t.status === "running" ? "crimt" : "t3"} />
                    <span className="trunc">{t.name}{t.preview ? ` ${t.preview.split("\n")[0]}` : ""}</span>
                    <span className="m">{t.durationMs != null ? fmtDuration(t.durationMs) : ""}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {tab === "worker" && (
        <div className="ip" role="tabpanel" aria-label="Worker">
          <div className="row"><span className="lbl">Subagents</span>
            <span className="mono t3" style={{ marginLeft: "auto", fontSize: 11 }}>
              {subagents.filter((s) => s.status === "running").length} läuft · {subagents.filter((s) => s.status !== "running").length} fertig
            </span>
          </div>
          {subagents.length === 0 && <p className="muted small">In diesem Chat wurden noch keine Subagents gestartet.</p>}
          {subagents.map((s) => <SubagentCard key={s.id} s={s} />)}
        </div>
      )}
    </aside>
  );
}
