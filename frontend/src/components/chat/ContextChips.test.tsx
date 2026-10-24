import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { MessageBody } from "./ContextChips";

afterEach(cleanup);

it("zeigt den Originaltext und die Kontexte als einklappbare Chips mit Größe", () => {
  render(<MessageBody text={"Prüfe @file:a.py\n\n--- Context Warnings ---\n- @file:x: Datei nicht gefunden\n\n--- Attached Context ---\n\n📄 @file:a.py (3 tokens)\n```python\nx = 1\n```"} />);
  expect(screen.getByText("Prüfe @file:a.py")).toBeInTheDocument();
  expect(screen.getByText("3 Token")).toBeInTheDocument();
  expect(screen.getByRole("note")).toHaveTextContent("@file:x: Datei nicht gefunden");
  const summary = screen.getByText("@file:a.py").closest("summary")!;
  expect(summary.closest("details")).not.toHaveAttribute("open");
  fireEvent.click(summary);
  expect(screen.getByText(/x = 1/)).toBeInTheDocument();
});

it("rendert normalen Text ohne Chips", () => {
  render(<MessageBody text="Hallo" />);
  expect(screen.getByText("Hallo")).toBeInTheDocument();
  expect(screen.queryByLabelText("Angehängter Kontext")).toBeNull();
});
