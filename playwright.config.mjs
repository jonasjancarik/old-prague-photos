import { defineConfig } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const d1StateDir = mkdtempSync(join(tmpdir(), "old-prague-playwright-d1-"));
process.env.PLAYWRIGHT_D1_STATE_DIR = d1StateDir;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: [["line"], ["html", { open: "never" }]],
  globalTeardown: "./e2e/global-teardown.mjs",
  use: {
    baseURL: "http://127.0.0.1:8790",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "sh scripts/e2e-pages-server.sh",
    url: "http://127.0.0.1:8790/api/config",
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      PLAYWRIGHT_D1_STATE_DIR: d1StateDir,
      PLAYWRIGHT_PORT: "8790",
    },
  },
});
