import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import views from "../fixtures/ops_cron_views.json";
import type { Job } from "../opsApi";
import { JobsPage } from "./JobsPage";

vi.mock("../hosts", () => ({ useHosts: () => ({ hosts: [{ id: "ct", label: "Server", runtimes: [{ id: "hermes", agents: [{ id: "alpha", label: "Alpha" }, { id: "default", label: "Standard" }] }] }] }) }));

const SYS = "d935fe014c20", AGENT = "dcba8b738849", PAUSED = "0123456789ab";
const BASE = "/bff/h/ct/_cron/alpha";
type Call = { method: string; url: string; body: unknown };
let calls: Call[];
let jobs: Job[];
let fail: { url: RegExp; status: number; body: unknown } | undefined;

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
beforeEach(() => {
  calls = []; fail = undefined;
  jobs = structuredClone(views.jobs) as Job[];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body });
    if (fail && fail.url.test(url) && method !== "GET") return json(fail.body, fail.status);
    if (url === `${BASE}/schedules` && method === "GET") return json({ jobs });
    if (url === `${BASE}/targets`) return json(views.targets.length ? { targets: views.targets } : { targets: [] });
    if (url === `${BASE}/skill-names`) return json({ skills: ["codex", "plan"] });
    if (url === `${BASE}/blueprints` && method === "GET") return json({ blueprints: views.blueprints });
    const m = new RegExp(`^${BASE}/schedules/([a-f0-9]+)(?:/(runs|pause|resume|trigger))?(?:\\?.*)?$`).exec(url);
    if (url === `${BASE}/schedules` && method === "POST") {
      const j = { ...jobs[2], id: "aaaaaaaaaaaa", name: body.name ?? "", state: "paused", enabled: false, prompt: body.prompt };
      jobs = [...jobs, j]; return json(j);
    }
    if (url === `${BASE}/blueprints` && method === "POST") { const j = { ...jobs[2], id: "bbbbbbbbbbbb", name: "Aus Vorlage", state: "paused", enabled: false }; jobs = [...jobs, j]; return json(j); }
    if (m) {
      const job = jobs.find((j) => j.id === m[1])!;
      if (m[2] === "runs") return json({ runs: job.id === SYS ? views.runs : [] });
      if (m[2] === "pause") { job.state = "paused"; job.enabled = false; return json(job); }
      if (m[2] === "resume") { job.state = "scheduled"; job.enabled = true; return json(job); }
      if (m[2] === "trigger") return json({ ...job, last_status: "ok" });
      if (method === "PUT") { Object.assign(job, body.updates ?? body); return json(job); }
      if (method === "DELETE") { jobs = jobs.filter((j) => j.id !== job.id); return json({ ok: true }); }
    }
    return json({ detail: "unbekannt" }, 404);
  }));
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function (this: HTMLDialogElement) { this.setAttribute("open", ""); } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function (this: HTMLDialogElement) { this.removeAttribute("open"); } });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal"); Reflect.deleteProperty(HTMLDialogElement.prototype, "close"); });

const writes = () => calls.filter((c) => c.method !== "GET");
async function open() {
  render(<JobsPage host="ct" />);
  await screen.findByRole("button", { name: /tagescheck/ });
}
const row = (name: RegExp) => screen.getByRole("button", { name });

describe("Zeitpläne", () => {
  it("lists every schedule as a clickable row with status, next and last run", async () => {
    await open();
    expect(within(screen.getByRole("list", { name: "Zeitpläne" })).getAllByRole("button")).toHaveLength(3);
    expect(row(/wochenbericht/)).toHaveTextContent("Pausiert");
    expect(row(/wochenbericht/)).toHaveTextContent("every 30m");
    expect(row(/db-check/)).toHaveTextContent("System-Job");
    expect(row(/tagescheck/)).toHaveTextContent(/Letzter Lauf: .*erfolgreich/);
    expect(calls[0].url).toBe(`${BASE}/schedules`);
  });

  it("filters by status and by text and says so when nothing matches", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Pausiert" }));
    expect(screen.queryByRole("button", { name: /tagescheck/ })).toBeNull();
    expect(row(/wochenbericht/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Alle" }));
    fireEvent.change(screen.getByLabelText("Zeitpläne filtern"), { target: { value: "gibtsnicht" } });
    expect(screen.getByText("Kein Zeitplan passt zu Suche und Filter.")).toBeInTheDocument();
  });

  it("opens the detail panel on click and edits only the changed schedule (with preview of the next runs)", async () => {
    await open();
    fireEvent.click(row(/tagescheck/));
    const panel = await screen.findByRole("region", { name: "Zeitplan tagescheck" });
    const sched = within(panel).getByLabelText("Zeitplan");
    expect(sched).toHaveValue("30 3 * * *");
    const save = within(panel).getByRole("button", { name: "Änderungen speichern" });
    expect(save).toBeDisabled();
    fireEvent.change(sched, { target: { value: "0 9 * * 1-5" } });
    expect(within(panel).getByText(/Nächste Läufe \(Zeitzone dieses Browsers\)/)).toBeInTheDocument();
    fireEvent.click(save);
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toEqual({ method: "PUT", url: `${BASE}/schedules/${AGENT}`, body: { schedule: "0 9 * * 1-5" } });
    expect(await within(panel).findByText("Gespeichert.")).toBeInTheDocument();
  });

  it("edits prompt, skills, delivery and repetitions", async () => {
    await open();
    fireEvent.click(row(/tagescheck/));
    const panel = await screen.findByRole("region", { name: "Zeitplan tagescheck" });
    fireEvent.change(within(panel).getByLabelText("Prompt"), { target: { value: "Neuer Prompt" } });
    fireEvent.click(within(panel).getByRole("checkbox", { name: "plan" }));
    fireEvent.change(within(panel).getByLabelText("Zustellung"), { target: { value: "bot-chat:alpha" } });
    fireEvent.click(within(panel).getByRole("checkbox", { name: "Unbegrenzt wiederholen" }));
    fireEvent.change(within(panel).getByLabelText("Wiederholungen"), { target: { value: "0" } });
    expect(within(panel).getByRole("alert")).toHaveTextContent("ganze Zahl von 1 bis 1.000.000");
    expect(within(panel).getByRole("button", { name: "Änderungen speichern" })).toBeDisabled();
    fireEvent.change(within(panel).getByLabelText("Wiederholungen"), { target: { value: "3" } });
    fireEvent.click(within(panel).getByRole("button", { name: "Änderungen speichern" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0].body).toEqual({ prompt: "Neuer Prompt", deliver: "bot-chat:alpha", skills: ["plan"], repeat: 3 });
  });

  it("pauses and activates", async () => {
    await open();
    fireEvent.click(row(/tagescheck/));
    const panel = await screen.findByRole("region", { name: "Zeitplan tagescheck" });
    fireEvent.click(within(panel).getByRole("button", { name: "Pausieren" }));
    expect(await within(panel).findByRole("button", { name: "Aktivieren" })).toBeInTheDocument();
    expect(writes()[0]).toMatchObject({ method: "POST", url: `${BASE}/schedules/${AGENT}/pause` });
    fireEvent.click(within(panel).getByRole("button", { name: "Aktivieren" }));
    await waitFor(() => expect(writes()[1].url).toBe(`${BASE}/schedules/${AGENT}/resume`));
    expect(await within(panel).findByRole("button", { name: "Pausieren" })).toBeInTheDocument();
  });

  it("shows the run history with duration and result", async () => {
    await open();
    fireEvent.click(row(/db-check/));
    const panel = await screen.findByRole("region", { name: "Zeitplan db-check" });
    const hist = await within(panel).findByRole("region", { name: "Laufverlauf" });
    expect(within(hist).getAllByRole("row")).toHaveLength(4);
    expect(within(hist).getByText("FAILED")).toBeInTheDocument();
    expect(within(hist).getAllByText("COMPLETED").length).toBe(2);
    fireEvent.click(within(panel).getByRole("button", { name: "Jetzt ausführen" })); // nur System-Jobs sind gesperrt: hier erst nach dem Haken
    expect(writes()).toHaveLength(0);
  });

  it("runs an agent schedule now without extra confirmation", async () => {
    await open();
    fireEvent.click(row(/tagescheck/));
    const panel = await screen.findByRole("region", { name: "Zeitplan tagescheck" });
    fireEvent.click(within(panel).getByRole("button", { name: "Jetzt ausführen" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toEqual({ method: "POST", url: `${BASE}/schedules/${AGENT}/trigger`, body: undefined });
    expect(await within(panel).findByText("Lauf gestartet.")).toBeInTheDocument();
  });

  it("guards system jobs: locked until the user opts in, then sends confirm_system", async () => {
    await open();
    fireEvent.click(row(/db-check/));
    const panel = await screen.findByRole("region", { name: "Zeitplan db-check" });
    expect(within(panel).getByText(/läuft als Skript/)).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Jetzt ausführen" })).toBeDisabled();
    expect(within(panel).getByRole("button", { name: "Löschen" })).toBeDisabled();
    expect(within(panel).getByLabelText("Zeitplan")).toBeDisabled();
    fireEvent.click(within(panel).getByLabelText("Ich ändere diesen System-Job bewusst"));
    fireEvent.click(within(panel).getByRole("button", { name: "Jetzt ausführen" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toEqual({ method: "POST", url: `${BASE}/schedules/${SYS}/trigger`, body: { confirm_system: true } });
  });

  it("deletes only after the dialog is confirmed", async () => {
    await open();
    fireEvent.click(row(/wochenbericht/));
    const panel = await screen.findByRole("region", { name: "Zeitplan wochenbericht" });
    fireEvent.click(within(panel).getByRole("button", { name: "Löschen" }));
    const dialog = screen.getByRole("dialog", { name: "Zeitplan löschen?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Abbrechen" }));
    expect(writes()).toHaveLength(0);
    fireEvent.click(within(panel).getByRole("button", { name: "Löschen" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Endgültig löschen" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /wochenbericht/ })).toBeNull());
    expect(writes()[0]).toMatchObject({ method: "DELETE", url: `${BASE}/schedules/${PAUSED}` });
    expect(screen.queryByRole("region", { name: /Zeitplan wochenbericht/ })).toBeNull();
  });

  it("creates a new schedule, which starts paused", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Neuer Zeitplan" }));
    const panel = await screen.findByRole("region", { name: "Neuer Zeitplan" });
    expect(within(panel).getByText(/starten pausiert/)).toBeInTheDocument();
    const make = within(panel).getByRole("button", { name: "Pausiert anlegen" });
    expect(make).toBeDisabled();
    fireEvent.change(within(panel).getByLabelText("Name"), { target: { value: "Neu" } });
    fireEvent.change(within(panel).getByLabelText("Zeitplan"), { target: { value: "every 30m" } });
    expect(within(panel).getByText("Läuft alle 30 Minuten.")).toBeInTheDocument();
    fireEvent.change(within(panel).getByLabelText("Prompt"), { target: { value: "Mach etwas" } });
    fireEvent.click(make);
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toEqual({ method: "POST", url: `${BASE}/schedules`, body: { name: "Neu", schedule: "every 30m", prompt: "Mach etwas", deliver: "local" } });
    const detail = await screen.findByRole("region", { name: "Zeitplan Neu" });
    expect(within(detail).getByText("Pausiert", { selector: "span.tag" })).toBeInTheDocument();
    expect(within(detail).getByRole("button", { name: "Aktivieren" })).toBeInTheDocument();
  });

  it("creates a script job only with the server confirmation", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Neuer Zeitplan" }));
    const panel = await screen.findByRole("region", { name: "Neuer Zeitplan" });
    fireEvent.change(within(panel).getByLabelText("Name"), { target: { value: "Skript" } });
    fireEvent.change(within(panel).getByLabelText("Zeitplan"), { target: { value: "every 30m" } });
    fireEvent.change(within(panel).getByLabelText("Prompt"), { target: { value: "egal" } });
    fireEvent.change(within(panel).getByLabelText("Skript (statt Agent)"), { target: { value: "echo hi" } });
    const make = within(panel).getByRole("button", { name: "Pausiert anlegen" });
    expect(make).toBeDisabled();
    fireEvent.click(within(panel).getByLabelText("Ohne Agent ausführen (nur das Skript läuft)"));
    fireEvent.click(within(panel).getByLabelText("Ich weiß, dass das Skript direkt auf dem Server läuft"));
    fireEvent.click(make);
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toEqual({ method: "POST", url: `${BASE}/schedules`,
      body: { name: "Skript", schedule: "every 30m", prompt: "egal", deliver: "local", script: "echo hi", no_agent: true, confirm_system: true } });
  });

  it("creates from a template, which also starts paused", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Aus Vorlage" }));
    const panel = await screen.findByRole("region", { name: "Zeitplan aus Vorlage" });
    fireEvent.click(await within(panel).findByRole("button", { name: "Morning briefing" }));
    fireEvent.change(within(panel).getByLabelText(/What time\?/), { target: { value: "07:30" } });
    fireEvent.click(within(panel).getByRole("button", { name: "Pausiert anlegen" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toEqual({ method: "POST", url: `${BASE}/blueprints`, body: { blueprint: "morning-brief", values: { time: "07:30", deliver: "origin" } } });
    expect(await screen.findByRole("region", { name: "Zeitplan Aus Vorlage" })).toBeInTheDocument();
  });

  it("shows the reason for a failed write and a login hint for a missing step-up", async () => {
    await open();
    fireEvent.click(row(/tagescheck/));
    const panel = await screen.findByRole("region", { name: "Zeitplan tagescheck" });
    fail = { url: /pause$/, status: 502, body: { detail: "Das Dashboard meldet Fehler 500" } };
    fireEvent.click(within(panel).getByRole("button", { name: "Pausieren" }));
    expect(await within(panel).findByRole("alert")).toHaveTextContent("Das Dashboard meldet Fehler 500");
    fail = { url: /pause$/, status: 401, body: { detail: { code: "step_up_required", message: "Bitte erneut anmelden" } } };
    fireEvent.click(within(panel).getByRole("button", { name: "Pausieren" }));
    expect(await within(panel).findByRole("button", { name: "Erneut anmelden" })).toBeInTheDocument();
  });

  it("says what to do when there are no schedules", async () => {
    jobs = [];
    render(<JobsPage host="ct" />);
    expect(await screen.findByText(/noch keine Zeitpläne/)).toBeInTheDocument();
  });
});
