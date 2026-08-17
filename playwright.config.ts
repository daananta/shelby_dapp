import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  // The live 30-question benchmark uses provider quota and writes a report.
  // Keep it opt-in instead of treating it as a deterministic release gate.
  testIgnore: "**/eval-30-questions.spec.ts",
  fullyParallel: false,
  workers: 1,
  webServer: { command: "npm run dev -- --host 127.0.0.1 --port 4179", url: "http://127.0.0.1:4179", reuseExistingServer: false },
  use: { baseURL: "http://127.0.0.1:4179", channel: "chrome", headless: true },
});
