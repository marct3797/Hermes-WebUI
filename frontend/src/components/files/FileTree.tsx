import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "../Icon";
import type { Entry, HostFiles } from "../../filesApi";

type Listing = Entry[] | "loading" | { error: string };

/** Dateibaum: Ordner werden beim Aufklappen geladen; `revision` lädt die offenen Ordner neu. */
export function FileTree({ files, workspace, revision, selected, cwd, onOpenFile, onSelectDir, rootEmpty }: {
  rootEmpty?: ReactNode; files: HostFiles; workspace: string; revision: number; selected?: string; cwd: string;
  onOpenFile: (entry: Entry) => void; onSelectDir: (path: string) => void;
}) {
  const [listing, setListing] = useState<Record<string, Listing>>({});
  const [open, setOpen] = useState<Set<string>>(new Set());
  const openRef = useRef(open);
  openRef.current = open;

  const load = useCallback((path: string, quiet = false) => {
    if (!quiet) setListing((l) => ({ ...l, [path]: "loading" }));
    files.list(workspace, path).then((data) => setListing((l) => ({ ...l, [path]: data.entries ?? [] })))
      .catch((e: Error) => setListing((l) => ({ ...l, [path]: { error: e.message } })));
  }, [files, workspace]);

  useEffect(() => { load("", revision === 0); for (const path of openRef.current) load(path, true); }, [load, revision]);

  const toggle = (entry: Entry) => {
    onSelectDir(entry.path);
    const next = new Set(open);
    if (next.has(entry.path)) next.delete(entry.path); else { next.add(entry.path); load(entry.path); }
    setOpen(next);
  };

  const branch = (path: string, depth: number): ReactNode[] => {
    const state = listing[path];
    if (state === undefined || state === "loading") return [<li key="n" className="muted ft-note" style={{ paddingLeft: depth * 16 + 8 }} role="status">Lade…</li>];
    if (!Array.isArray(state)) return [<li key="n" className="ft-note" style={{ paddingLeft: depth * 16 + 8 }} role="alert">{state.error}</li>];
    if (state.length === 0) return [<li key="n" className="muted ft-note" style={{ paddingLeft: depth * 16 + 8 }}>{path ? "Leerer Ordner" : <>Dieser Arbeitsordner ist leer. {rootEmpty}</>}</li>];
    return state.flatMap((entry) => {
      const isDir = entry.kind === "directory";
      const expanded = open.has(entry.path);
      const row = <li key={entry.path}>
        <button type="button" className={`ft-row${selected === entry.path || (isDir && cwd === entry.path) ? " on" : ""}`} style={{ paddingLeft: depth * 16 + 8 }}
          aria-expanded={isDir ? expanded : undefined} onClick={() => (isDir ? toggle(entry) : onOpenFile(entry))}>
          <Icon name={isDir ? (expanded ? "chevd" : "chevr") : "file"} size={14} />
          <span>{entry.name}{isDir ? "/" : ""}</span>
        </button>
      </li>;
      return isDir && expanded ? [row, ...branch(entry.path, depth + 1)] : [row];
    });
  };

  return <ul className="ft" aria-label="Dateibaum">{branch("", 0)}</ul>;
}
