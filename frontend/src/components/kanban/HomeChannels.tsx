import { useEffect, useState } from "react";
import { kbSettingsApi, type KbHome } from "../../kanbanSettingsApi";
import { useAction } from "../useAction";
import { t } from "../../i18n";

/** Heimatkanäle der Messenger: Benachrichtigung zu dieser Aufgabe ein- oder ausschalten. Ohne eingerichteten Heimatkanal bleibt der Block unsichtbar. */
export function HomeChannels({ host, board, id }: { host: string; board?: string; id: string }) {
  const [rows, setRows] = useState<KbHome[]>();
  const { run, notes, busy } = useAction();
  useEffect(() => { kbSettingsApi.homes(host, board, id).then((r) => setRows(r.home_channels)).catch(() => setRows([])); }, [host, board, id]);
  if (!rows?.length) return null;
  return (
    <section className="kb-sec" aria-label={t("Benachrichtigungen")}>
      <b>{t("Benachrichtigungen")}</b>
      {rows.map((h) => (
        <label key={h.platform} className="check">
          <input type="checkbox" disabled={busy} checked={h.subscribed}
            onChange={(e) => { const on = e.target.checked; void run(async () => { await kbSettingsApi.subscribe(host, board, id, h.platform, on); setRows(rows.map((x) => x.platform === h.platform ? { ...x, subscribed: on } : x)); }); }} />
          {" "}{t("Bei Änderungen in {name} ({platform}) melden", { name: h.name, platform: h.platform })}
        </label>))}
      {notes}
    </section>
  );
}
