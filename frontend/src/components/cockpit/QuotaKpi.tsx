import { api } from "../../api";
import { useQuota } from "../../useQuota";
import { fmtIn } from "../providers/QuotaBars";

/** Kleine Karte „Kontingent“: das knappste Fenster aller Profile; rot, wenn eines erschöpft oder ein Zugang abgelaufen ist. */
export function QuotaKpi() {
  const { data, error } = useQuota(() => api.quotaSummary(), []);
  if (!data && !error) return null;
  const items = data?.items ?? [];
  const worst = items.filter((i) => i.remaining_percent !== null).sort((a, b) => a.remaining_percent! - b.remaining_percent!)[0];
  const expired = items.filter((i) => i.state === "auth_failed");
  const exhausted = items.filter((i) => i.state === "exhausted").length;
  const problem = data?.runtimes.find((r) => r.state !== "ok");
  const hot = worst?.state === "exhausted" || expired.length > 0;
  const rest = worst?.remaining_percent;
  const parts = error ? [`nicht ladbar: ${error}`]
    : [
      worst && `${worst.label} · ${worst.window} · ${worst.profile}${worst.reset_in_s !== null ? ` · Reset ${fmtIn(worst.reset_in_s)}` : ""}`,
      exhausted > 1 && `${exhausted} erschöpft`,
      expired.length > 0 && `${expired.length} ${expired.length === 1 ? "Zugang" : "Zugänge"} abgelaufen (${expired.map((i) => `${i.label}, ${i.profile}`).join("; ")})`,
      !worst && !expired.length && (problem ? `${problem.host}: ${problem.reason ?? "nicht abfragbar"}` : "keine Anbieter mit Kontingent"),
    ].filter(Boolean);
  return (
    <div className={`kpi${hot ? " hot" : ""}`} aria-label="Kontingent">
      <span className={`lbl${hot ? " crimt" : ""}`}>Kontingent</span>
      <span className="v">{rest == null ? "—" : <>{Number.isInteger(rest) ? rest : rest.toFixed(1).replace(".", ",")}<small>% Rest</small></>}</span>
      <span className="kpi-note">{parts.join(" · ")}</span>
    </div>
  );
}
