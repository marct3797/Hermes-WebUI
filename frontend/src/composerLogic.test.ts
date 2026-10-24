import { beforeEach, describe, expect, it } from "vitest";
import {
  attachmentBlock, detectTrigger, formatRefValue, hasContextRefs, joinContext, loadReasoning, modelOptions, parseReasoningArg,
  parseSlashInput, reasoningLabel, saveReasoning, splitContext,
} from "./composerLogic";

describe("Aufwand", () => {
  it("bildet Auswahl auf model_options ab; Standard sendet nichts", () => {
    expect(modelOptions(undefined)).toBeUndefined();
    expect(modelOptions({ thinking: false })).toEqual({ reasoning: { enabled: false } });
    expect(modelOptions({ thinking: true })).toEqual({ reasoning: { enabled: true } });
    expect(modelOptions({ thinking: true, effort: "xhigh" })).toEqual({ reasoning: { enabled: true, effort: "xhigh" } });
  });
  it("beschriftet jede Stufe auf Deutsch", () => {
    expect([undefined, { thinking: false }, { thinking: true }, { thinking: true, effort: "high" }, { thinking: true, effort: "xhigh" }].map((r) => reasoningLabel(r as never)))
      .toEqual(["Standard", "Aus", "An", "Hoch", "Extra hoch"]);
  });
  it("merkt je Agent und verwirft Kaputtes", () => {
    saveReasoning("h/r/a", { thinking: true, effort: "low" });
    expect(loadReasoning("h/r/a")).toEqual({ thinking: true, effort: "low" });
    expect(loadReasoning("h/r/b")).toBeUndefined();
    localStorage.setItem("hermes-webui-reasoning:h/r/c", '{"thinking":true,"effort":"wahnsinn"}');
    expect(loadReasoning("h/r/c")).toBeUndefined();
    saveReasoning("h/r/a", undefined);
    expect(loadReasoning("h/r/a")).toBeUndefined();
  });
  it("liest /reasoning-Argumente", () => {
    expect(parseReasoningArg("")).toBeUndefined();
    expect(parseReasoningArg("Hoch")).toEqual({ value: { thinking: true, effort: "high" } });
    expect(parseReasoningArg("extra")).toEqual({ value: { thinking: true, effort: "xhigh" } });
    expect(parseReasoningArg("aus")).toEqual({ value: { thinking: false } });
    expect(parseReasoningArg("standard")).toEqual({ value: undefined });
    expect(parseReasoningArg("show")).toBe("invalid");
  });
});

describe("Auslöser", () => {
  beforeEach(() => undefined);
  it("erkennt / am Zeilenanfang und @ am Wortanfang", () => {
    expect(detectTrigger("/pl", 3)).toEqual({ kind: "slash", query: "pl", start: 0 });
    expect(detectTrigger("a\n/x", 4)).toEqual({ kind: "slash", query: "x", start: 2 });
    expect(detectTrigger("lies @fi", 8)).toEqual({ kind: "at", query: "fi", start: 5 });
    expect(detectTrigger("(@diff", 6)).toEqual({ kind: "at", query: "diff", start: 1 });
    expect(detectTrigger("mail a@b", 8)).toBeUndefined();
    expect(detectTrigger("/usr/bin", 8)).toBeUndefined();
    expect(detectTrigger("/plan ziel", 10)).toBeUndefined();
  });
  it("trennt Befehl und Argumente", () => {
    expect(parseSlashInput("/plan  Ziel: Release\nzweite")).toEqual({ name: "plan", args: "Ziel: Release\nzweite" });
    expect(parseSlashInput("/new")).toEqual({ name: "new", args: "" });
    expect(parseSlashInput("/usr/bin/x")).toBeUndefined();
    expect(parseSlashInput("kein /befehl")).toBeUndefined();
  });
  it("quotet Pfade wie Hermes und erkennt Bezüge", () => {
    expect(formatRefValue("a/b.py")).toBe("a/b.py");
    expect(formatRefValue("mit leer.txt")).toBe("`mit leer.txt`");
    expect(hasContextRefs("@diff")).toBe(true);
    expect(hasContextRefs("sieh @file:a.py")).toBe(true);
    expect(hasContextRefs("nur @url:https://example.com")).toBe(false);
    expect(hasContextRefs("mail@diff")).toBe(false);
  });
});

describe("Kontext", () => {
  it("zerlegt Originaltext, Bezüge, Warnungen und Anhänge", () => {
    const sent = joinContext(
      "Prüfe @file:a.py\n\n--- Context Warnings ---\n- @file:x: Datei nicht gefunden\n\n--- Attached Context ---\n\n📄 @file:a.py (3 tokens)\n```python\nx = 1\n\n📄 Blockgrenze im Code\n```",
      [attachmentBlock("notiz.md", "Zeile\n```js\nx\n```")],
    );
    const { body, chips } = splitContext(sent);
    expect(body).toBe("Prüfe @file:a.py");
    expect(chips.map((c) => [c.kind, c.title])).toEqual([["warning", "@file:x: Datei nicht gefunden"], ["file", "@file:a.py"], ["attachment", "notiz.md"]]);
    expect(chips[1].code).toContain("Blockgrenze im Code");
    expect(chips[2].code).toContain("````markdown");
  });
  it("lässt normale Nachrichten unverändert", () => {
    expect(splitContext("Hallo\n\n--- Attached Context ---\n\nkein Block")).toEqual({ body: "Hallo\n\n--- Attached Context ---\n\nkein Block", chips: [] });
    expect(splitContext("Hallo")).toEqual({ body: "Hallo", chips: [] });
  });
  it("zeigt Skill-Anweisungen als /skill mit Chip", () => {
    const text = '[IMPORTANT: The user has invoked the "plan" skill, indicating they want you to follow its instructions. The full skill content is loaded below.]\n\n# Plan\nSchritte.\n\nThe user has provided the following instruction alongside the skill invocation: Ziel: Release';
    const { body, chips } = splitContext(text);
    expect(body).toBe("/plan Ziel: Release");
    expect(chips).toMatchObject([{ kind: "skill", title: "Skill plan", code: "# Plan\nSchritte." }]);
  });
});
