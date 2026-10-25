import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { resetRedirect } from "../api";
import { installBackend } from "../test-backend";

let backend: ReturnType<typeof installBackend>;

async function memText(name: string) {
  const ta = (await screen.findByLabelText(`Inhalt von ${name}`)) as HTMLTextAreaElement;
  await waitFor(() => expect(ta.value).not.toBe(""), { timeout: 3000 });
  return ta;
}

async function openMem() {
  backend = installBackend(["gamma"]);
  history.pushState(null, "", "/h/server/hermes/gamma/hermes-memory");
  render(<App />);
  await screen.findByRole("heading", { name: "Hermes-Gedächtnis", level: 1 });
  await memText("MEMORY.md");
}

beforeEach(() => { resetRedirect(); sessionStorage.clear(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("Hermes-Dateien", () => {
  it("lädt beide Dateien, zählt Zeichen und speichert nur bei Änderung mit Hash", async () => {
    await openMem();
    const ta = (await memText("MEMORY.md"));
    expect(ta.value).toContain("Eintrag eins");
    expect(screen.getByText("28 / 262.144 Zeichen")).toBeInTheDocument();
    const save = screen.getAllByRole("button", { name: "Speichern" })[0];
    expect(save).toBeDisabled();
    fireEvent.change(ta, { target: { value: `${ta.value}Neu\n` } });
    expect(save).toBeEnabled();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(save);
    await screen.findByText(/Gespeichert/);
    const puts = backend.calls.filter((c) => c.method === "PUT" && c.url.endsWith("/hermes-memory/files/MEMORY.md"));
    expect(puts).toHaveLength(1);
    expect(puts[0].body).toMatchObject({ content: expect.stringContaining("Neu"), expected_sha256: expect.any(String) });
    confirm.mockRestore();
  });

  it("zeigt bei 409 Konflikt mit Neu laden und lädt die Datei neu", async () => {
    await openMem();
    backend.dash.hm.memfiles.conflict = true;
    const ta = screen.getByLabelText("Inhalt von USER.md") as HTMLTextAreaElement;
    // USER.md startet leer (kein Wait moeglich)
    fireEvent.change(ta, { target: { value: "neu\n" } });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(screen.getAllByRole("button", { name: "Speichern" })[1]);
    await screen.findByText("SOUL.md wurde inzwischen geändert");
    backend.dash.hm.memfiles.conflict = false;
    fireEvent.click(screen.getByRole("button", { name: "Neu laden" }));
    await waitFor(() => expect(screen.queryByText("SOUL.md wurde inzwischen geändert")).toBeNull());
    (window.confirm as unknown as { mockRestore: () => void }).mockRestore?.();
  });

  it("zeigt ruhige Hinweiskarte wenn hostd zu alt ist", async () => {
    backend = installBackend(["gamma"]);
    backend.dash.hm.memfiles.oldHostd = true;
    history.pushState(null, "", "/h/server/hermes/gamma/hermes-memory");
    render(<App />);
    await screen.findByRole("heading", { name: "Hermes-Gedächtnis", level: 1 });
    expect(await screen.findByText(/vermutlich veraltet/)).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "MEMORY.md" })).toBeNull();
  });

  it("warnt vor ungespeicherten Änderungen beim Verlassen", async () => {
    await openMem();
    const ta = screen.getByLabelText("Inhalt von MEMORY.md") as HTMLTextAreaElement;
    expect(ta.value).toContain("Eintrag eins");
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    fireEvent.change(ta, { target: { value: `${ta.value}x` } });
    expect(add).toHaveBeenCalledWith("beforeunload", expect.any(Function));
    const handler = add.mock.calls.find((c) => c[0] === "beforeunload")![1] as (e: Event) => void;
    const ev = new Event("beforeunload", { cancelable: true });
    handler(ev);
    expect(ev.defaultPrevented).toBe(true);
    fireEvent.change(ta, { target: { value: "Eintrag eins\n§\nEintrag zwei\n" } });
    await waitFor(() => expect(remove).toHaveBeenCalledWith("beforeunload", expect.any(Function)));
  });
});
