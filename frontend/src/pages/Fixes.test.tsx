import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OperationsPage } from "./OperationsPage";
import { WorkspacePage } from "./WorkspacePage";
import { editableSchedule, scheduleText, text } from "../components/operations/http";
import jobs from "../fixtures/real/real_jobs_list.json";

const PROFILES = ["default", "benzai", "inari", "raiden", "kaito", "mira", "sora", "tenjin", "yuki"];
vi.mock("../hosts", () => ({ useHosts: () => ({ hosts: [{ id: "laptop", label: "Laptop", runtimes: [{ id: "hermes", agents: PROFILES.map((id) => ({ id, label: id })) }] }] }) }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

// Die aufgenommene Liste enthält nur cron-Jobs; die Intervallform stammt aus der Spec (Hermes: {kind, minutes, display}).
const interval = { ...jobs.jobs[0], id: "aaaaaaaaaaaa", name: "Intervall-Job", schedule: { kind: "interval", minutes: 30, display: "every 30m" } };
const all = { jobs: [...jobs.jobs, interval] };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("F1 Zeitpläne in echter Form", () => {
  it("echte Fixture hat schedule als Objekt", () => {
    expect(jobs.jobs.every((j) => typeof j.schedule === "object" && j.schedule.kind === "cron")).toBe(true);
  });
  it("scheduleText/editableSchedule/text", () => {
    expect(scheduleText({ kind: "interval", minutes: 30 })).toBe("alle 30 Minuten");
    expect(scheduleText({ kind: "cron", expr: "0 5 * * 1" })).toBe("0 5 * * 1");
    expect(scheduleText(undefined)).toBe("Kein Zeitplan gemeldet");
    expect(editableSchedule({ kind: "interval", minutes: 30, display: "every 30m" })).toBeUndefined();
    expect(editableSchedule({ kind: "cron", expr: "0 5 * * 1" })).toBe("0 5 * * 1");
    expect(text({ a: 1 })).toBe("");
  });
  it("rendert die Jobs-Seite für alle neun Profile ohne Absturz, zeigt display, Bearbeiten nur für cron", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => json(url.endsWith("/status") ? { features: ["jobs"] } : all)));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(<OperationsPage section="jobs" host="laptop" />);
    const select = await screen.findByLabelText(/Profil/);
    for (const profile of PROFILES) {
      fireEvent.change(select, { target: { value: profile } });
      await screen.findByText(jobs.jobs[0].name);
      expect(screen.getByText("every 30m")).toBeInTheDocument();
      for (const job of jobs.jobs) expect(screen.getByLabelText(`Zeitplan für ${job.name}`)).toHaveValue(job.schedule.expr);
    }
    const cron = jobs.jobs.length;
    expect(screen.getAllByRole("button", { name: "Zeitplan speichern" })).toHaveLength(cron);
    expect(screen.queryByText("Die Ansicht konnte nicht geladen werden")).toBeNull();
    expect(error.mock.calls.some((c) => String(c[0]).includes("Objects are not valid"))).toBe(false);
  });
  it("sendet beim Bearbeiten den Ausdruck als String", async () => {
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => json(init?.method === "PATCH" ? {} : url.endsWith("/status") ? { features: ["jobs"] } : all));
    vi.stubGlobal("fetch", fetcher);
    render(<OperationsPage section="jobs" host="laptop" />);
    const cronJob = jobs.jobs.find((j) => j.schedule.kind === "cron")!;
    const input = await screen.findByLabelText(`Zeitplan für ${cronJob.name}`);
    fireEvent.change(input, { target: { value: "0 6 * * 1" } });
    fireEvent.submit(input.closest("form")!);
    fireEvent.click(await screen.findByRole("button", { name: "Bestätigen" }));
    await waitFor(() => expect(fetcher.mock.calls.some(([, i]) => i?.method === "PATCH")).toBe(true));
    const [, init] = fetcher.mock.calls.find(([, i]) => i?.method === "PATCH")!;
    expect(JSON.parse(String(init?.body))).toEqual({ schedule: "0 6 * * 1" });
  });
});

describe("F2 Workspace ohne Git", () => {
  const setup = (gitStatus: number, entries: unknown[] = []) => vi.stubGlobal("fetch", vi.fn(async (url: string) => json(
    url.includes("_workspaces") ? { workspaces: [{ id: "hikari", label: "Hikari" }] }
      : url.includes("_git") ? (gitStatus === 200 ? { repository: false, reason: "Kein Git-Repository in diesem Arbeitsordner" } : { detail: "x" })
        : { entries }, url.includes("_git") ? gitStatus : 200)));
  it("zeigt neutralen Hinweis und leeren Ordner ohne Anmelde-Rat", async () => {
    setup(200);
    render(<WorkspacePage host="hikari" />);
    expect(await screen.findByText("Kein Git-Repository in diesem Arbeitsordner")).toBeInTheDocument();
    expect(await screen.findByText("Dieser Arbeitsordner ist leer.")).toBeInTheDocument();
    expect(screen.queryByText(/frisch anmelden/)).toBeNull();
  });
  it("Anmelde-Rat nur bei 401/403", async () => {
    setup(409); render(<WorkspacePage host="hikari" />);
    expect(await screen.findByText("Anfrage fehlgeschlagen (409).")).toBeInTheDocument();
    cleanup(); setup(403); render(<WorkspacePage host="hikari" />);
    expect(await screen.findByText(/403\); ggf. frisch anmelden/)).toBeInTheDocument();
  });
});
