import { splitContext, type ContextChip } from "../../composerLogic";
import { Icon } from "../Icon";
import { t } from "../../i18n";

const ICON: Record<ContextChip["kind"], string> = { file: "file", folder: "folder", diff: "diff", url: "globe", attachment: "clip", skill: "spark", warning: "alert", other: "pin" };

/** Eine gesendete Nachricht: Originaltext, darunter die angehängten Kontexte als einklappbare Chips mit Größe. */
export function MessageBody({ text }: { text: string }) {
  const { body, chips } = splitContext(text);
  return (
    <>
      <p className="plain">{body}</p>
      {chips.length > 0 && (
        <div className="ctx-chips" aria-label={t("Angehängter Kontext")}>
          {chips.map((c, i) => c.code ? (
            <details key={i} className="ctx-chip">
              <summary><Icon name={ICON[c.kind]} size={12} /><span className="trunc">{c.title}</span>{c.tokens !== undefined && <span className="mono t3">{t("{tokens} Token", { tokens: c.tokens })}</span>}</summary>
              <pre className="ctx-code">{c.code}</pre>
            </details>
          ) : (
            <span key={i} className={`ctx-chip ctx-flat${c.kind === "warning" ? " warn" : ""}`} role={c.kind === "warning" ? "note" : undefined}>
              <Icon name={ICON[c.kind]} size={12} /><span className="trunc">{c.title}</span>
            </span>
          ))}
        </div>
      )}
    </>
  );
}
