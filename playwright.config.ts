import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  webServer: { command: "npm run dev -- --host 127.0.0.1 --port 4179", url: "http://127.0.0.1:4179", reuseExistingServer: false },
  use: { baseURL: "http://127.0.0.1:4179", channel: "chrome", headless: true },
});
