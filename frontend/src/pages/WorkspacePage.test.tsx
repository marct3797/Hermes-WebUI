import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { WorkspacePage } from "./WorkspacePage";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe("workspace", () => {
  it("uses configured workspace files, bounds text, shows Git and safely downloads PDFs", async () => {
    const fetcher = vi.fn(async (url: string) => ({ ok: true, json: async () => url.includes("_workspaces") ? { workspaces: [{ id: "repo", label: "Repo" }] } : url.includes("_git") ? { branch: "main", status: " M README.md", diff: "diff --git a/README.md b/README.md", remotes: [], truncated: true } : url.includes("path=README.md") ? { content: "x".repeat(70000), truncated: true } : { entries: [{ name: "README.md", path: "README.md", kind: "file" }, { name: "paper.pdf", path: "paper.pdf", kind: "file" }] } }));
    vi.stubGlobal("fetch", fetcher);
    render(<WorkspacePage host="laptop" initialWorkspace="repo" />);
    fireEvent.click(await screen.findByRole("button", { name: "README.md" }));
    expect(await screen.findByLabelText("Textvorschau")).toHaveTextContent("x".repeat(65536));
    expect(screen.getByLabelText("Textvorschau").textContent?.length).toBe(65536);
    fireEvent.click(screen.getByRole("button", { name: "paper.pdf" }));
    const download = await screen.findByRole("link", { name: "Datei herunterladen" });
    expect(download.getAttribute("href")).toBe("/bff/h/laptop/_files/download?workspace=repo&path=paper.pdf");
    expect(download).toHaveAttribute("download");
    expect(document.querySelector("iframe")).toBeNull();
    expect(await screen.findByText("diff --git a/README.md b/README.md")).toBeInTheDocument();
    expect(fetcher.mock.calls.every(([url]) => url.startsWith("/bff/h/laptop/"))).toBe(true);
  });
  it("uploads binary attachments with the write guard and rejects oversized files", async () => {
    const fetcher = vi.fn(async (url: string, _opts?: RequestInit) => ({ ok: true, json: async () => url.includes("_workspaces") ? { workspaces: [{ id: "repo", label: "Repo" }] } : url.includes("upload") ? { ok: true } : url.includes("_git") ? { branch: "main", diff: "", status: "", remotes: [] } : { entries: [] } }));
    vi.stubGlobal("fetch", fetcher); render(<WorkspacePage host="laptop" />);
    const input = await screen.findByLabelText("Datei hochladen");
    await waitFor(() => expect(input).not.toBeDisabled());
    fireEvent.change(input, { target: { files: [new File(["%PDF-safe"], "paper.pdf", { type: "application/pdf" })] } });
    await waitFor(() => expect(fetcher.mock.calls.some(([url]) => url.includes("upload"))).toBe(true));
    const [, options] = fetcher.mock.calls.find(([url]) => url.includes("upload"))!;
    expect(options?.headers).toMatchObject({ "X-Requested-With": "hermes-webui" });
    expect(JSON.parse(String(options?.body))).toEqual({ workspace: "repo", path: "paper.pdf", content_base64: btoa("%PDF-safe") });
    fireEvent.change(input, { target: { files: [new File([new Uint8Array(1048577)], "large.pdf")] } });
    expect(await screen.findByRole("alert")).toHaveTextContent("1 MiB");
  });
});
