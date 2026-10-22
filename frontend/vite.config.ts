/// <reference types="vitest" />
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/bff": { target: "http://127.0.0.1:8000", changeOrigin: false },
      "/auth": { target: "http://127.0.0.1:8000", changeOrigin: false },
    },
  },
  // Nichts einbetten: kleine Schriften würden sonst als data:-URL inline landen und von der CSP (font-src 'self') blockiert.
  build: { sourcemap: false, assetsInlineLimit: 0 },
  test: { environment: "jsdom", globals: true, setupFiles: ["./src/test-setup.ts"] },
});
