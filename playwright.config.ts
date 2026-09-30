import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/browser", workers: 1, timeout: 120_000,
  use: { baseURL: "http://127.0.0.1:4318", browserName: "chromium",
    launchOptions: process.env.PAI_BROWSER ? { executablePath: process.env.PAI_BROWSER } : {}, trace: "retain-on-failure" },
  webServer: { command: "PORT=4318 PAI_STATE=.state/browser npm run start", url: "http://127.0.0.1:4318/api/state", timeout: 30_000, reuseExistingServer: false },
});
