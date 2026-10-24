import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { resetRedirect } from "../api";
import { installBackend, roomOf } from "../test-backend";

let env: ReturnType<typeof installBackend>;

async function open(agents = ["gamma", "eta", "epsilon"]) {
  env = installBackend(agents);
  history.pushState(null, "", "/rooms");
  render(<App />);
  await screen.findByRole("heading", { name: "Räume", level: 1 });
}

beforeEach(() => resetRedirect());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("Räume", () => {
  it("explains the empty state", async () => {
    await open();
    expect(await screen.findByText("Noch kein Raum")).toBeInTheDocument();
  });

  it("lists rooms with last message and flags the ones that wait or work", async () => {
    env = installBackend(["gamma", "eta"]);
    env.rooms.push(
      roomOf("111111111111", "Planung", ["gamma", "eta"], { needs_user: true, last_message: { seq: 3, author: "server/hermes/eta", kind: "message", text: "Darf ich löschen?", mentions: ["user"], at: 1_792_000_000 } }),
      roomOf("222222222222", "Ruhig", ["gamma", "eta"], { running: true }),
    );
    history.pushState(null, "", "/rooms");
    render(<App />);
    const card = await screen.findByRole("link", { name: /Planung/ });
    expect(within(card).getByText("BRAUCHT DICH")).toBeInTheDocument();
    expect(within(card).getByText("eta: Darf ich löschen?")).toBeInTheDocument();
    expect(within(screen.getByRole("link", { name: /Ruhig/ })).getByText("LÄUFT")).toBeInTheDocument();
    expect(screen.getByText("2 aktiv · 1 brauchen dich")).toBeInTheDocument();
  });

  it("asks for the archive only when told to", async () => {
    await open(["gamma"]);
    fireEvent.click(screen.getByRole("button", { name: "Archiv" }));
    await screen.findByText("Nichts archiviert");
    expect(env.calls.some((c) => c.url === "/bff/rooms?archived=true")).toBe(true);
  });

  it("needs a name and two reachable agents before it creates a room, then opens it", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: /Neuer Raum/ }));
    const form = await screen.findByRole("form", { name: "Neuer Raum" });
    const create = within(form).getByRole("button", { name: "Raum anlegen" });
    expect(within(form).queryByText("default")).not.toBeInTheDocument(); // der Laptop ist nicht erreichbar
    expect(create).toBeDisabled();
    fireEvent.change(within(form).getByPlaceholderText(/Planungsrunde/), { target: { value: "Runde" } });
    fireEvent.click(within(form).getByRole("checkbox", { name: /gamma/ }));
    expect(create).toBeDisabled();
    fireEvent.click(within(form).getByRole("checkbox", { name: /eta/ }));
    expect(create).toBeEnabled();
    fireEvent.click(create);
    await waitFor(() => expect(location.pathname).toBe("/rooms/abcabcabcabc"));
    const post = env.calls.find((c) => c.method === "POST" && c.url === "/bff/rooms");
    expect(post?.body).toEqual({ name: "Runde", members: [{ host: "server", runtime: "hermes", agent: "gamma" }, { host: "server", runtime: "hermes", agent: "eta" }] });
  });

  it("is reachable from the sidebar", async () => {
    env = installBackend();
    history.pushState(null, "", "/");
    render(<App />);
    fireEvent.click(await screen.findByRole("link", { name: /Räume/ }));
    await screen.findByRole("heading", { name: "Räume", level: 1 });
  });
});
