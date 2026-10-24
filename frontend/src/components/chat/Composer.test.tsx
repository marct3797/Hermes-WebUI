import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRef } from "../../types";
import { Composer } from "./Composer";

const AGENT: AgentRef = { host: "server", runtime: "hermes", agent: "default" };
const COMMANDS = [
  { name: "new", aliases: ["reset"], description: "Start a new session", category: "Session", args_hint: "[name]", status: "webui", note: "Beginnt einen neuen Chat mit diesem Agent." },
  { name: "stop", aliases: [], description: "Kill running processes", category: "Session", args_hint: "", status: "webui", note: "Stoppt den laufenden Lauf." },
  { name: "reasoning", aliases: [], description: "Manage reasoning effort", category: "Configuration", args_hint: "[level]", status: "webui", note: "Setzt den Denkaufwand." },
  { name: "model", aliases: [], description: "Switch model", category: "Configuration", args_hint: "[model]", status: "webui", note: "Öffnet die Modellwahl." },
  { name: "history", aliases: [], description: "Show conversation history", category: "Session", args_hint: "", status: "terminal", note: "Nur im Hermes-Terminal verfügbar. Die WebUI setzt diesen Befehl nicht um." },
];
const SKILLS = { data: [{ name: "plan", description: "Zerlegt Aufgaben in Schritte." }, { name: "kaputt", description: "aus", enabled: false }] };

type Handler = (url: string, init?: RequestInit) => unknown;
let routes: Record<string, Handler>;
let calls: { url: string; method: string; body?: unknown }[];

function stubFetch() {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) return new Response(JSON.stringify({ detail: "unbekannt" }), { status: 404 });
    const out = routes[key](url, init);
    return out instanceof Response ? out : new Response(JSON.stringify(out), { status: 200 });
  }));
}

beforeEach(() => {
  calls = [];
  routes = {
    "/_workspaces": () => ({ workspaces: [{ id: "alpha", label: "Alpha" }] }),
    "/_commands": () => ({ commands: COMMANDS }),
    "/default/skills": () => SKILLS,
    "/_files": (url) => (url.includes("path=src") ? { entries: [{ name: "app.py", path: "src/app.py", kind: "file", size: 12 }] } : { entries: [{ name: "src", path: "src", kind: "directory", size: 0 }, { name: "README.md", path: "README.md", kind: "file", size: 30 }] }),
    "/_skill": () => ({ text: "[SKILL plan] Zerlege. Anweisung: Ziel" }),
    "/_composer/expand": (_u, init) => { const t = JSON.parse(String(init?.body)).text as string; return { text: `${t}\n\n--- Attached Context ---\n\n📄 @file:README.md (3 tokens)\n\`\`\`\nx\n\`\`\``, refs: [{ raw: "@file:README.md", kind: "file", ok: true, tokens: 3, passthrough: false, error: null }], tokens: 3, blocked: false, warnings: [] }; },
  };
  stubFetch();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function setup(over: Partial<Parameters<typeof Composer>[0]> = {}) {
  const props = {
    agent: AGENT, busy: false, disabled: false, name: "Standard", models: [], onModel: vi.fn(), canSteer: false, queued: [],
    onSend: vi.fn(), onStop: vi.fn(), onNew: vi.fn(), onSendQueued: vi.fn(), onDropQueued: vi.fn(), ...over,
  };
  render(<Composer {...props} />);
  return { props, box: screen.getByLabelText("Nachricht") as HTMLTextAreaElement };
}
const type = (box: HTMLTextAreaElement, value: string) => fireEvent.change(box, { target: { value, selectionStart: value.length, selectionEnd: value.length } });
const enter = (box: HTMLElement) => fireEvent.keyDown(box, { key: "Enter" });
const workspaceReady = async () => { await screen.findByRole("combobox", { name: "Arbeitsordner" }); await waitFor(() => expect(screen.getByRole("option", { name: "Alpha" })).toBeInTheDocument()); };

describe("Gerätevorgaben", () => {
  it("sendet bei ausgeschaltetem Enter-Senden nur mit Strg+Enter und nutzt den Host-Aufwand", async () => {
    localStorage.setItem("hermes.preferences", JSON.stringify({ enterSends: false, hosts: { server: { effort: "high", workspace: "alpha" } } }));
    localStorage.removeItem("hermes-webui-reasoning:server/hermes/default");
    const { box, props } = setup();
    await workspaceReady();
    expect(screen.getByRole("combobox", { name: "Arbeitsordner" })).toHaveValue("alpha");
    type(box, "Hallo"); enter(box);
    expect(props.onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(props.onSend).toHaveBeenCalledWith("Hallo", [], undefined, { thinking: true, effort: "high" }));
    localStorage.removeItem("hermes.preferences");
  });
});

describe("Slash-Menü", () => {
  it("öffnet bei / mit Skills und ehrlich markierten Hermes-Befehlen", async () => {
    const { box } = setup();
    type(box, "/");
    const list = await screen.findByRole("listbox", { name: "Befehle und Skills" });
    await within(list).findByText("/plan");
    expect(within(list).getAllByRole("group").map((g) => g.getAttribute("aria-label"))).toEqual(["Skills", "Hermes-Befehle"]);
    expect(within(list).queryByText("/kaputt")).toBeNull(); // deaktivierte Skills nicht anbieten
    const history = within(list).getByText("/history").closest("[role=option]")!;
    expect(history).toHaveAttribute("aria-disabled", "true");
    expect(history).toHaveTextContent("Nur im Hermes-Terminal verfügbar");
    expect(within(list).getByText("/reasoning [level]").closest("[role=option]")).toHaveTextContent("In der WebUI umgesetzt");
  });

  it("filtert, wählt per Pfeiltasten und Enter und behält den Fokus", async () => {
    const { box, props } = setup();
    type(box, "/pl");
    await screen.findByText("/plan");
    expect(within(screen.getByRole("listbox")).getAllByRole("option")).toHaveLength(1);
    fireEvent.keyDown(box, { key: "ArrowDown" });
    enter(box);
    expect(box).toHaveValue("/plan ");
    expect(props.onSend).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("wählt mit Tab und per Maus; Esc schließt ohne die Eingabe zu ändern", async () => {
    const { box } = setup();
    type(box, "/");
    await screen.findByText("/plan");
    fireEvent.keyDown(box, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(box).toHaveValue("/");
    type(box, "/re");
    fireEvent.mouseDown((await screen.findByText("/reasoning [level]")));
    expect(box).toHaveValue("/reasoning ");
    type(box, "/pl");
    await screen.findByText("/plan");
    fireEvent.keyDown(box, { key: "Tab" });
    expect(box).toHaveValue("/plan ");
  });

  it("überspringt gesperrte Befehle bei der Tastaturwahl", async () => {
    const { box } = setup();
    type(box, "/hist");
    await screen.findByText("/history");
    expect(within(screen.getByRole("listbox")).getByRole("option")).toHaveAttribute("aria-disabled", "true");
    expect(box).not.toHaveAttribute("aria-activedescendant");
  });

  it("expandiert einen Skill-Befehl vor dem Senden", async () => {
    const { box, props } = setup();
    type(box, "/plan Ziel");
    enter(box);
    await waitFor(() => expect(props.onSend).toHaveBeenCalledWith("[SKILL plan] Zerlege. Anweisung: Ziel", [], undefined, undefined));
    expect(calls.find((c) => c.url.endsWith("/_skill"))?.body).toEqual({ name: "plan", instruction: "Ziel" });
    expect(box).toHaveValue("");
  });

  it("sendet gesperrte und unbekannte Befehle nicht, bietet aber Senden als Text an", async () => {
    const { box, props } = setup();
    type(box, "/history");
    enter(box);
    expect(await screen.findByRole("alert")).toHaveTextContent("/history: Nur im Hermes-Terminal");
    expect(props.onSend).not.toHaveBeenCalled();
    expect(box).toHaveValue("/history");
    fireEvent.click(screen.getByRole("button", { name: "Trotzdem als Text senden" }));
    await waitFor(() => expect(props.onSend).toHaveBeenCalledWith("/history", [], undefined, undefined));
    type(box, "/gibtsnicht");
    enter(box);
    expect(await screen.findByRole("alert")).toHaveTextContent("Unbekannter Befehl /gibtsnicht");
  });

  it("führt /new und /stop in der WebUI aus", async () => {
    const { box, props } = setup({ busy: true });
    type(box, "/new");
    enter(box);
    await waitFor(() => expect(props.onNew).toHaveBeenCalled());
    type(box, "/stop");
    enter(box);
    await waitFor(() => expect(props.onStop).toHaveBeenCalled());
    expect(props.onSend).not.toHaveBeenCalled();
  });

  it("meldet /stop ohne laufenden Lauf", async () => {
    const { box, props } = setup();
    type(box, "/stop");
    enter(box);
    expect(await screen.findByRole("alert")).toHaveTextContent("Es läuft gerade nichts");
    expect(props.onStop).not.toHaveBeenCalled();
  });

  it("zeigt Fehler der Befehlsliste statt eines leeren Menüs", async () => {
    routes["/_commands"] = () => new Response(JSON.stringify({ detail: "kaputt" }), { status: 500 });
    const { box } = setup();
    type(box, "/");
    expect(await screen.findByText(/Befehle nicht ladbar: kaputt/)).toBeInTheDocument();
  });
});

describe("Denken und Aufwand", () => {
  it("zeigt den Standard sichtbar und listet alle Stufen mit Haken", async () => {
    setup();
    expect(screen.getByRole("button", { name: /Denken: Standard/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Denken: Standard/ }));
    const dialog = screen.getByRole("dialog", { name: "Optionen" });
    expect(within(dialog).getAllByRole("radio").map((r) => r.textContent)).toEqual(["Standard des Agents", "Minimal", "Niedrig", "Mittel", "Hoch", "Extra hoch", "Max", "Ultra"]);
    expect(within(dialog).getByRole("radio", { name: "Standard des Agents" })).toHaveAttribute("aria-checked", "true");
    expect(within(dialog).getByRole("switch", { name: "Denken" })).toBeChecked();
  });

  it("sendet die gewählte Stufe mit und merkt sie je Agent", async () => {
    const { box, props } = setup();
    fireEvent.click(screen.getByRole("button", { name: /Denken/ }));
    fireEvent.click(screen.getByRole("radio", { name: "Hoch" }));
    expect(screen.getByRole("button", { name: /Denken: Hoch/ })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Hoch" })).toHaveAttribute("aria-checked", "true");
    type(box, "hallo");
    enter(box);
    await waitFor(() => expect(props.onSend).toHaveBeenCalledWith("hallo", [], undefined, { thinking: true, effort: "high" }));
    expect(localStorage.getItem("hermes-webui-reasoning:server/hermes/default")).toContain("high");
    cleanup();
    setup(); // neuer Aufbau: gemerkte Wahl bleibt
    expect(screen.getByRole("button", { name: /Denken: Hoch/ })).toBeInTheDocument();
    cleanup();
    setup({ agent: { ...AGENT, agent: "beta" } });
    expect(screen.getByRole("button", { name: /Denken: Standard/ })).toBeInTheDocument();
  });

  it("schaltet Denken aus und kehrt mit „Standard des Agents“ zurück", async () => {
    const { box, props } = setup();
    fireEvent.click(screen.getByRole("button", { name: /Denken/ }));
    fireEvent.click(screen.getByRole("switch", { name: "Denken" }));
    expect(screen.getByRole("button", { name: /Denken: Aus/ })).toBeInTheDocument();
    type(box, "x"); enter(box);
    await waitFor(() => expect(props.onSend).toHaveBeenLastCalledWith("x", [], undefined, { thinking: false }));
    fireEvent.click(screen.getByRole("radio", { name: "Standard des Agents" }));
    type(box, "y"); enter(box);
    await waitFor(() => expect(props.onSend).toHaveBeenLastCalledWith("y", [], undefined, undefined));
  });

  it("schließt das Menü mit Esc und beim Klick daneben", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: /Denken/ }));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Denken/ }));
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("setzt die Stufe mit /reasoning und meldet Unbekanntes", async () => {
    const { box, props } = setup();
    type(box, "/reasoning ultra");
    enter(box);
    await screen.findByRole("button", { name: /Denken: Ultra/ });
    expect(props.onSend).not.toHaveBeenCalled();
    type(box, "/reasoning show");
    enter(box);
    expect(await screen.findByRole("alert")).toHaveTextContent("Unbekannte Stufe");
    expect(screen.getByRole("button", { name: /Denken: Ultra/ })).toBeInTheDocument();
    type(box, "/reasoning standard");
    enter(box);
    await screen.findByRole("button", { name: /Denken: Standard/ });
  });
});

describe("@-Bezüge", () => {
  it("bietet die Bezüge an, sperrt Dateibezüge ohne Arbeitsordner und lässt @url zu", async () => {
    const { box } = setup();
    await workspaceReady();
    type(box, "@");
    const list = await screen.findByRole("listbox", { name: "Bezüge" });
    expect(within(list).getAllByRole("option").map((o) => o.querySelector(".cmp-label")!.textContent)).toEqual(["@diff", "@staged", "@file:", "@folder:", "@url:", "@git:"]);
    expect(within(list).getByText("@diff").closest("[role=option]")).toHaveAttribute("aria-disabled", "true");
    expect(within(list).getByText("@diff").closest("[role=option]")).toHaveTextContent("Erst einen Arbeitsordner wählen");
    expect(within(list).getByText("@url:").closest("[role=option]")).not.toHaveAttribute("aria-disabled");
  });

  it("vervollständigt Dateipfade aus dem Arbeitsordner", async () => {
    const { box } = setup();
    await workspaceReady();
    fireEvent.change(screen.getByRole("combobox", { name: "Arbeitsordner" }), { target: { value: "alpha" } });
    type(box, "lies @fi");
    fireEvent.keyDown(box, { key: "Tab" });
    expect(box).toHaveValue("lies @file:");
    await screen.findByText("README.md");
    fireEvent.mouseDown(screen.getByText("src/"));
    expect(box).toHaveValue("lies @file:src/");
    fireEvent.mouseDown(await screen.findByText("app.py"));
    expect(box).toHaveValue("lies @file:src/app.py ");
    expect(calls.some((c) => c.url.includes("path=src") && c.url.includes("workspace=alpha"))).toBe(true);
  });

  it("zeigt ohne Host-Dienst, dass Bezüge fehlen", async () => {
    routes["/_workspaces"] = () => new Response(JSON.stringify({ detail: "Kein Host-Dienst konfiguriert" }), { status: 503 });
    const { box } = setup();
    const select = await screen.findByRole("combobox", { name: "Arbeitsordner" });
    expect(select).toBeDisabled();
    type(box, "@d");
    expect(await screen.findByText(/Kein Host-Dienst: Bezüge auf Dateien und Git sind nicht verfügbar/)).toBeInTheDocument();
  });

  it("expandiert beim Senden mit Arbeitsordner und sendet den erweiterten Text", async () => {
    const { box, props } = setup();
    await workspaceReady();
    fireEvent.change(screen.getByRole("combobox", { name: "Arbeitsordner" }), { target: { value: "alpha" } });
    type(box, "prüfe @file:README.md bitte");
    enter(box);
    await waitFor(() => expect(props.onSend).toHaveBeenCalled());
    expect(calls.find((c) => c.url.endsWith("/_composer/expand"))?.body).toEqual({ workspace: "alpha", text: "prüfe @file:README.md bitte" });
    expect(vi.mocked(props.onSend).mock.calls[0][0]).toContain("--- Attached Context ---");
    expect(localStorage.getItem("hermes-webui-workspace:server")).toBe("alpha");
  });

  it("bricht bei fehlerhaften Bezügen ab, zeigt den Grund und behält die Eingabe", async () => {
    routes["/_composer/expand"] = () => ({ text: "x\n\n--- Context Warnings ---\n- w", refs: [{ raw: "@file:fehlt.py", kind: "file", ok: false, tokens: 0, passthrough: false, error: "Datei nicht gefunden" }], tokens: 0, blocked: false, warnings: ["w"] });
    const { box, props } = setup();
    type(box, "lies @file:fehlt.py");
    enter(box);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("@file:fehlt.py: Datei nicht gefunden");
    expect(props.onSend).not.toHaveBeenCalled();
    expect(box).toHaveValue("lies @file:fehlt.py");
    fireEvent.click(screen.getByRole("button", { name: "Trotzdem als Text senden" }));
    await waitFor(() => expect(props.onSend).toHaveBeenCalledWith("x\n\n--- Context Warnings ---\n- w", [], undefined, undefined));
  });

  it("verweigert zu viel Kontext und fängt Netzfehler ab", async () => {
    routes["/_composer/expand"] = () => ({ text: "x", refs: [], tokens: 99999, blocked: true, warnings: ["Kontext abgelehnt: 99999 Tokens überschreiten die Grenze von 50000."] });
    const { box, props } = setup();
    type(box, "@diff");
    enter(box);
    expect(await screen.findByRole("alert")).toHaveTextContent("Zu viel Kontext");
    routes["/_composer/expand"] = () => new Response(JSON.stringify({ detail: "Host-Dienst nicht erreichbar" }), { status: 502 });
    enter(box);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Host-Dienst nicht erreichbar"));
    expect(props.onSend).not.toHaveBeenCalled();
    expect(box).toHaveValue("@diff");
  });

  it("holt @url nie selbst: kein Expand-Aufruf, Text bleibt", async () => {
    const { box, props } = setup();
    type(box, "lies @url:https://example.com/x");
    enter(box);
    await waitFor(() => expect(props.onSend).toHaveBeenCalledWith("lies @url:https://example.com/x", [], undefined, undefined));
    expect(calls.some((c) => c.url.includes("_composer"))).toBe(false);
  });
});

describe("Anhänge und Eingabe", () => {
  const upload = (files: File[]) => fireEvent.change(screen.getByLabelText("Dateien auswählen"), { target: { files } });

  it("nimmt Textdateien als Chip mit Entfernen-Knopf und hängt sie als Codeblock an", async () => {
    const { box, props } = setup();
    upload([new File(["print(1)"], "a.py", { type: "text/x-python" }), new File(["zwei"], "b.txt", { type: "text/plain" })]);
    expect(await screen.findByText(/a\.py · 1 KB/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Anhang b.txt entfernen" }));
    expect(screen.queryByText(/b\.txt/)).toBeNull();
    type(box, "schau");
    enter(box);
    await waitFor(() => expect(props.onSend).toHaveBeenCalled());
    const sent = vi.mocked(props.onSend).mock.calls[0][0] as string;
    expect(sent).toContain("schau\n\n--- Attached Context ---\n\n📎 a.py (2 tokens)\n```python\nprint(1)\n```");
    expect(screen.queryByText(/a\.py · 1 KB/)).toBeNull();
  });

  it("lehnt zu große, binäre und zu viele Dateien mit Grund ab", async () => {
    setup();
    upload([new File(["x".repeat(101 * 1024)], "gross.txt", { type: "text/plain" })]);
    expect(await screen.findByRole("alert")).toHaveTextContent("gross.txt: zu groß (über 100 KB)");
    upload([new File(["a\u0000b"], "bin.dat")]);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("bin.dat: keine Textdatei"));
    upload(Array.from({ length: 6 }, (_, i) => new File(["x"], `f${i}.txt`, { type: "text/plain" })));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Höchstens 5 Dateien"));
    expect(screen.getAllByRole("button", { name: /Anhang f\d\.txt entfernen/ })).toHaveLength(5);
  });

  it("nimmt Dateien per Drag and Drop und Einfügen", async () => {
    const { box } = setup();
    const form = box.closest("form")!;
    fireEvent.drop(form, { dataTransfer: { files: [new File(["a"], "drop.md")], types: ["Files"] } });
    expect(await screen.findByText(/drop\.md/)).toBeInTheDocument();
    fireEvent.paste(box, { clipboardData: { files: [new File(["b"], "paste.txt")] } });
    expect(await screen.findByText(/paste\.txt/)).toBeInTheDocument();
  });

  it("sendet mit Enter, bricht mit Shift+Enter um und sendet nichts Leeres", async () => {
    const { box, props } = setup();
    enter(box);
    expect(props.onSend).not.toHaveBeenCalled();
    type(box, "zeile");
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(props.onSend).not.toHaveBeenCalled();
    enter(box);
    await waitFor(() => expect(props.onSend).toHaveBeenCalledWith("zeile", [], undefined, undefined));
  });

  it("trägt den Modus beim Senden während eines Laufs mit", async () => {
    const { box, props } = setup({ busy: true, canSteer: true });
    type(box, "los");
    enter(box);
    await waitFor(() => expect(props.onSend).toHaveBeenCalledWith("los", [], "steer", undefined));
  });
});
