import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Sigil, hashHue, initialsOf, sigilColor } from "./Sigil";

const sigil = (container: HTMLElement) => container.querySelector(".sg") as HTMLElement;

describe("Sigil", () => {
  it("uses initials and a name-derived hue without config", () => {
    const { container } = render(<Sigil name="omoikane" />);
    const el = sigil(container);
    expect(el).toHaveClass("ini");
    expect(el).toHaveAttribute("data-i", "OM");
    expect(el.style.getPropertyValue("--id")).toBe(`oklch(.82 .12 ${hashHue("omoikane")})`);
  });

  it("keeps the same hue for the same name", () => {
    expect(hashHue("raiden")).toBe(hashHue("raiden"));
    expect(hashHue("raiden")).not.toBe(hashHue("kaze"));
  });

  it("renders neutral glyphs as a mask of the built-in icon", () => {
    const { container } = render(<Sigil name="x" size="l" state="wait" config={{ type: "glyph", glyph: "neutral/terminal", hue: 200 }} />);
    const el = sigil(container);
    expect(el).toHaveClass("sg-l", "wait");
    expect(el).not.toHaveClass("ini");
    expect(el.style.getPropertyValue("--g")).toBe("var(--i-terminal)");
    expect(el.style.getPropertyValue("--id")).toBe("oklch(.82 .12 200)");
  });

  it("falls back to initials for an unknown neutral glyph", () => {
    const { container } = render(<Sigil name="kaze" config={{ type: "glyph", glyph: "neutral/gibtsnicht" }} />);
    expect(sigil(container)).toHaveClass("ini");
  });

  it("loads pack glyphs and custom SVGs only from the BFF sigil paths", () => {
    const ok = render(<Sigil name="a" config={{ type: "glyph", glyph: "japan/raiden", src: "/bff/ui/glyphs/japan/raiden.svg" }} />);
    expect(sigil(ok.container).style.getPropertyValue("--g")).toBe('url("/bff/ui/glyphs/japan/raiden.svg")');
    const own = render(<Sigil name="a" config={{ type: "svg", src: "/bff/ui/sigils/mein-symbol.svg" }} />);
    expect(sigil(own.container).style.getPropertyValue("--g")).toBe('url("/bff/ui/sigils/mein-symbol.svg")');
    // fremde Adresse oder Anführungszeichen: nicht als Maske verwenden
    for (const src of ["https://evil.example/x.svg", '/bff/ui/sigils/a");background:url(x.svg', "//evil/x.svg"]) {
      const bad = render(<Sigil name="ab" config={{ type: "svg", src }} />);
      expect(sigil(bad.container)).toHaveClass("ini");
      expect(sigil(bad.container).style.getPropertyValue("--g")).toBe("");
    }
  });

  it("shows configured initials and a neutral colour for hue null", () => {
    const { container } = render(<Sigil name="default" config={{ type: "initials", text: "DF", hue: null }} />);
    expect(sigil(container)).toHaveAttribute("data-i", "DF");
    expect(sigil(container).style.getPropertyValue("--id")).toBe("oklch(.92 0 0)");
  });

  it("derives initials from letters and digits only", () => {
    expect(initialsOf("--ab-c")).toBe("AB");
    expect(initialsOf("")).toBe("?");
    expect(sigilColor("auto", "a")).toMatch(/^oklch\(\.82 \.12 \d+\)$/);
  });
});
