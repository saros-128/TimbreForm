import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
  preview: {
    host: "0.0.0.0",
    port: 4173,
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    // DSP fixtures are CPU-heavy. Keeping a small worker pool avoids starving
    // jsdom tests and makes the Docker suite deterministic on laptop CPUs.
    maxWorkers: 2,
    testTimeout: 15_000,
  },
});
