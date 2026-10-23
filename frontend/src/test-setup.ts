import "@testing-library/dom";
import "@testing-library/jest-dom/vitest";
import { beforeEach } from "vitest";

// jsdom kennt kein WebGL und meldet getContext als „nicht implementiert“; der Shader fällt dann still weg, wie ohne WebGL im Browser.
HTMLCanvasElement.prototype.getContext = (() => null) as unknown as typeof HTMLCanvasElement.prototype.getContext;

// Persistierte Run-IDs dürfen nicht zwischen unabhängigen Tests überleben:
// Recovery speichert sie absichtlich in sessionStorage, Tests setzen ihre Daten selbst.
beforeEach(() => {
  try { sessionStorage.clear(); } catch { /* ohne Speicher */ }
  try { localStorage.clear(); } catch { /* ohne Speicher */ }
});
