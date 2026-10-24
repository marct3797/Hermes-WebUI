import { useEffect, useState } from "react";
import { api } from "./api";
import { cached } from "./dataCache";
import type { KnowledgeProvider } from "./types";

/** Eingerichtete Wissens-Anbieter (leer, solange nichts eingerichtet oder die Abfrage fehlschlägt): Seitenleiste und Tab-Leiste zeigen „Wissen“ nur dann. */
export function useKnowledgeProviders(): KnowledgeProvider[] {
  const [list, setList] = useState<KnowledgeProvider[]>([]);
  useEffect(() => {
    let alive = true;
    cached("knowledge", 30_000, () => api.knowledgeProviders()).then((r) => { if (alive) setList(r.providers); }, () => undefined);
    return () => { alive = false; };
  }, []);
  return list;
}
