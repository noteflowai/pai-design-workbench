import { defineConfig } from "@playwright/test";
const remote = process.env.PAI_REMOTE_URL;
if (remote && remote !== "https://pai.oneai.host") throw new Error("Remote workflow verification is restricted to the authorized deployment");
export default defineConfig({
  testDir: "./tests/browser", workers: 1, timeout: 120_000,
  use: { baseURL: remote ?? "http://127.0.0.1:4318", browserName: "chromium",
    storageState: remote ? process.env.PAI_AUTH_STATE : undefined,
    launchOptions: process.env.PAI_BROWSER ? { executablePath: process.env.PAI_BROWSER } : {}, trace: "retain-on-failure" },
  webServer: remote ? undefined : { command: "PORT=4318 PAI_STATE=.state/browser npm run start", url: "http://127.0.0.1:4318/api/state", timeout: 30_000, reuseExistingServer: false },
});
