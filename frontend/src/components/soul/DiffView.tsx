import { useMemo } from "react";
import { diffStats, lineDiff, withContext } from "../../diff";
import { t } from "../../i18n";

const MARK = { same: " ", add: "+", del: "−" } as const;

/** Zeilenweiser Vergleich zweier Texte: „+“ nur im zweiten, „−“ nur im ersten Text, lange unveränderte Strecken eingeklappt. */
export function DiffView({ before, after, label }: { before: string; after: string; label: string }) {
  const lines = useMemo(() => lineDiff(before, after), [before, after]);
  if (lines === null) return <p className="hint">{t("Die Texte unterscheiden sich zu stark für eine Vorschau.")}</p>;
  const { added, removed } = diffStats(lines);
  if (added + removed === 0) return <p className="hint">{t("Keine Unterschiede.")}</p>;
  return (
    <div className="diff" role="region" aria-label={label}>
      <div className="diff-stats mono"><span className="diff-add">+{added}</span><span className="diff-del">−{removed}</span></div>
      <div className="diff-body">
        {withContext(lines).map((item, i) => item.kind === "skip"
          ? <div key={i} className="dl dl-skip">{t("… {count} unveränderte {v}", { count: item.count, v: item.count === 1 ? t("Zeile") : t("Zeilen") })}</div>
          : <div key={i} className={`dl dl-${item.kind}`}><span className="dm" aria-hidden>{MARK[item.kind]}</span><span className="dt">{item.text || " "}</span></div>)}
      </div>
    </div>
  );
}
