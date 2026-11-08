import { t } from "./i18n";
/** Modelle und Anbieter aus `GET /api/model/options`. Hermes liefert `{ providers[], model, provider }`; Mock und ältere Formen `{ models[], current }`. */
export type ModelGroup = { provider: string; label: string; models: string[] };
export type ModelOptions = { groups: ModelGroup[]; current?: string; provider?: string };

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

const modelId = (m: unknown): string | undefined => {
  if (typeof m === "string") return m || undefined;
  const o = rec(m);
  return o ? str(o.id) ?? str(o.model) ?? str(o.name) ?? str(o.slug) : undefined;
};

const ids = (list: unknown): string[] => (Array.isArray(list) ? list.map(modelId).filter((x): x is string => !!x) : []);

export function parseModelOptions(payload: unknown): ModelOptions {
  const p = rec(payload);
  const out: ModelOptions = { groups: [], current: str(p?.model) ?? str(p?.current), provider: str(p?.provider) };

  if (Array.isArray(p?.providers)) {
    for (const raw of p.providers as unknown[]) {
      const o = rec(raw);
      if (!o) continue;
      // Anbieter ohne Zugang (kein Key, kein Login) bieten nichts an, was sich wählen ließe.
      if (o.authenticated === false && o.is_current !== true) continue;
      const models = [...new Set([...ids(o.models), ...ids(o.featured_models)])];
      if (models.length === 0) continue;
      const slug = str(o.slug) ?? str(o.name) ?? "?";
      out.groups.push({ provider: slug, label: str(o.name) ?? slug, models });
    }
    return out;
  }

  // Flache Liste (Mock, ältere Hermes-Versionen): nach `provider` gruppieren, falls angegeben.
  const flat = Array.isArray(payload) ? payload : Array.isArray(p?.models) ? (p.models as unknown[]) : [];
  const by = new Map<string, string[]>();
  for (const m of flat) {
    const id = modelId(m);
    if (!id) continue;
    const prov = str(rec(m)?.provider) ?? "";
    by.set(prov, [...(by.get(prov) ?? []), id]);
  }
  for (const [prov, models] of by) out.groups.push({ provider: prov, label: prov || t("Modelle"), models });
  return out;
}
