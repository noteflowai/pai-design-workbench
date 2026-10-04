import { defineConfig } from "@playwright/test";
const remote = process.env.PAI_REMOTE_URL;
if (remote && remote !== "https://pai.oneai.host") throw new Error("Remote workflow verification is restricted to the authorized deployment");
export default defineConfig({
  testDir: "./tests/browser", workers: 1, timeout: 120_000,
  use: { baseURL: remote ?? "http://127.0.0.1:4318", browserName: "chromium",
    storageState: remote ? process.env.PAI_AUTH_STATE : undefined,
    // Software WebGL so the three.js viewport renders in headless CI; production browsers use the GPU.
    launchOptions: { args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader"], ...(process.env.PAI_BROWSER ? { executablePath: process.env.PAI_BROWSER } : {}) },
    trace: "retain-on-failure" },
  // Browser runs never spend real AI attempts: the executor is a contract-checking fake driven by a spec file.
  webServer: remote ? undefined : { command: "mkdir -p .state/browser && rm -f .state/browser/fake-executor.json && touch .state/browser/fake-ledger.sqlite3 && PORT=4318 PAI_STATE=.state/browser npm run start",
    env: { PAI_CONTROLLER_ENTRYPOINT: `${process.cwd()}/tests/fixtures/fake-executor.mjs`, PAI_CONTROLLER_DATABASE: `${process.cwd()}/.state/browser/fake-ledger.sqlite3`,
      PAI_CONTROL_ROOT: process.cwd(), PAI_EXECUTOR_IMAGES: "1", FAKE_EXECUTOR_FILE: `${process.cwd()}/.state/browser/fake-executor.json` },
    url: "http://127.0.0.1:4318/api/state", timeout: 30_000, reuseExistingServer: false },
});
