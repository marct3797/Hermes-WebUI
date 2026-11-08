import { useEffect, useState } from "react";
import { kbSettingsApi, type KbOrch, type KbSettings } from "../kanbanSettingsApi";
import { useAction } from "./useAction";
import { t } from "../i18n";

/** Orchestrierung, Profil-Beschreibungen, Spalten und Anzeige-Einstellungen des Kanban-Plugins. Läuft unter dem Board und ändert nur über das Dashboard. */
export function KanbanSettingsPanel({ host }: { host: string }) {
  const [open, setOpen] = useState(false);
  const [s, setS] = useState<KbSettings>();
  const [orch, setOrch] = useState<KbOrch | null>(null);
  const [desc, setDesc] = useState<Record<string, string>>({});
  const [autoFor, setAutoFor] = useState<string>();
  const [note, setNote] = useState<string>();
  const { run, notes, busy } = useAction();

  useEffect(() => {
    if (!open || s) return;
    void run(async () => { const r = await kbSettingsApi.settings(host); setS(r); setOrch(r.orchestration); setDesc(Object.fromEntries((r.profiles ?? []).map((p) => [p.name, p.description]))); });
  }, [open, s, host]); // eslint-disable-line react-hooks/exhaustive-deps

  const names = (s?.profiles ?? []).map((p) => p.name);
  const saveOrch = (patch: Parameters<typeof kbSettingsApi.setOrch>[1]) => void run(async () => { setOrch(await kbSettingsApi.setOrch(host, patch)); setNote(t("Orchestrierung gespeichert.")); });

  return (
    <details className="kb-admin" onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>{t("Kanban-Einstellungen")}</summary>
      {notes}
      {note && <p className="hint" role="status">{note}</p>}
      {open && !s && !notes && <p role="status">{t("Wird geladen…")}</p>}
      {s && (<>
        <section aria-label={t("Orchestrierung")}>
          <b>{t("Orchestrierung")}</b>
          {!orch ? <p className="hint">{s.notes.orchestration ?? t("Diese Hermes-Version kennt die Orchestrierung nicht.")}</p> : (<>
            <label>{t("Orchestrator-Profil")}
              <select className="field field-line" disabled={busy} value={orch.orchestrator_profile} onChange={(e) => saveOrch({ orchestrator_profile: e.target.value })}>
                <option value="">{t("Aktives Profil ({name})", { name: orch.resolved_orchestrator_profile })}</option>
                {names.map((n) => <option key={n} value={n}>{n}</option>)}
              </select></label>
            <label>{t("Standard-Zuweisung")}
              <select className="field field-line" disabled={busy} value={orch.default_assignee} onChange={(e) => saveOrch({ default_assignee: e.target.value })}>
                <option value="">{t("Aktives Profil ({name})", { name: orch.resolved_default_assignee })}</option>
                {names.map((n) => <option key={n} value={n}>{n}</option>)}
              </select></label>
            <label className="check"><input type="checkbox" disabled={busy} checked={orch.auto_decompose} onChange={(e) => saveOrch({ auto_decompose: e.target.checked })} /> {t("Aufgaben automatisch zerlegen")}</label>
            <label className="check"><input type="checkbox" disabled={busy} checked={orch.auto_promote_children} onChange={(e) => saveOrch({ auto_promote_children: e.target.checked })} /> {t("Kindaufgaben automatisch freigeben")}</label>
          </>)}
        </section>
        <section aria-label={t("Profil-Beschreibungen")}>
          <b>{t("Profil-Beschreibungen")}</b>
          <p className="hint" style={{ margin: 0 }}>{t("Der Orchestrator wählt anhand dieser Texte das passende Profil für eine Aufgabe.")}</p>
          {!s.profiles ? <p className="hint">{s.notes.profiles ?? t("Diese Hermes-Version kennt die Profilliste nicht.")}</p> : (
            <ul className="plain">{s.profiles.map((p) => (
              <li key={p.name}>
                <label>{p.name}{p.description_auto && <span className="muted small"> {t("· automatisch")}</span>}
                  <input className="field field-line" maxLength={300} value={desc[p.name] ?? ""} onChange={(e) => setDesc({ ...desc, [p.name]: e.target.value })} /></label>
                <div className="row">
                  <button type="button" className="btn btn-s" disabled={busy || (desc[p.name] ?? "") === p.description}
                    onClick={() => void run(async () => { const r = await kbSettingsApi.setDescription(host, p.name, desc[p.name] ?? ""); setDesc({ ...desc, [p.name]: r.description }); setS({ ...s, profiles: s.profiles!.map((x) => x.name === p.name ? { ...x, description: r.description, description_auto: false } : x) }); setNote(t("Beschreibung von {name} gespeichert.", { name: p.name })); })}>{t("Speichern")}</button>
                  <button type="button" className="btn btn-s" disabled={busy} aria-expanded={autoFor === p.name} onClick={() => setAutoFor(autoFor === p.name ? undefined : p.name)}>{t("Automatisch beschreiben …")}</button>
                </div>
                {autoFor === p.name && (
                  <div className="banner" role="note">
                    <span>{t("Das Hilfsmodell schreibt die Beschreibung und verbraucht dabei Tokens.")}</span>
                    <button type="button" className="btn btn-s" disabled={busy} onClick={() => void run(async () => {
                      const r = await kbSettingsApi.describeAuto(host, p.name, !!p.description);
                      setAutoFor(undefined);
                      if (r.ok) { setDesc({ ...desc, [p.name]: r.description }); setS({ ...s, profiles: s.profiles!.map((x) => x.name === p.name ? { ...x, description: r.description, description_auto: true } : x) }); setNote(t("Beschreibung von {name} erzeugt.", { name: p.name })); }
                      else setNote(r.reason ?? t("Hermes hat nichts erzeugt."));
                    })}>{t("Jetzt beschreiben")}</button>
                  </div>)}
              </li>))}
            </ul>)}
        </section>
        <section aria-label={t("Anzeige und Spalten")}>
          <b>{t("Anzeige und Spalten")}</b>
          {s.config ? <ul className="plain small">
            <li>{t("Spur je Profil")}: {s.config.lane_by_profile ? t("an") : t("aus")}</li>
            <li>{t("Archivierte standardmäßig zeigen")}: {s.config.include_archived_by_default ? t("an") : t("aus")}</li>
            <li>{t("Markdown darstellen")}: {s.config.render_markdown ? t("an") : t("aus")}</li>
          </ul> : <p className="hint">{s.notes.config ?? t("Diese Hermes-Version kennt die Anzeige-Einstellungen nicht.")}</p>}
          {s.columns && <p className="small">{t("Spalten")}: {s.columns.map((c) => c.label).join(" → ")}</p>}
          <p className="hint" style={{ margin: 0 }}>{t("Diese Werte stehen in config.yaml unter dashboard.kanban und lassen sich auf der Einstellungsseite ändern.")}</p>
        </section>
      </>)}
    </details>
  );
}
