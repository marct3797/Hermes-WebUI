import "@testing-library/dom";
import "@testing-library/jest-dom/vitest";

// jsdom kennt kein WebGL und meldet getContext als „nicht implementiert“; der Shader fällt dann still weg, wie ohne WebGL im Browser.
HTMLCanvasElement.prototype.getContext = (() => null) as unknown as typeof HTMLCanvasElement.prototype.getContext;
