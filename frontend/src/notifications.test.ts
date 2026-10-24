import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { api } from "./api";
import { notifyApproval } from "./notifications";

beforeEach(() => { localStorage.clear(); });
afterEach(() => vi.unstubAllGlobals());
it("sendet bei abgebrochener Bestätigung keine Freigabe", async () => {
  localStorage.setItem("hermes.preferences", JSON.stringify({ confirmApprovals: true }));
  vi.stubGlobal("confirm", vi.fn(() => false));
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  await expect(api.approve({ host: "x", runtime: "hermes", agent: "a" }, "run", "once")).rejects.toThrow("abgebrochen");
  expect(fetch).not.toHaveBeenCalled();
});
it("meldet Freigaben nur nach Opt-in und fragt niemals selbst nach Erlaubnis", () => {
  const notice = vi.fn(), ask = vi.fn();
  vi.stubGlobal("Notification", class { static permission = "granted"; static requestPermission = ask; constructor(...a: unknown[]) { notice(...a); } });
  notifyApproval(); expect(notice).not.toHaveBeenCalled();
  localStorage.setItem("hermes.preferences", JSON.stringify({ approvalDesktop: true }));
  notifyApproval(); expect(notice).toHaveBeenCalledOnce(); expect(ask).not.toHaveBeenCalled();
});
