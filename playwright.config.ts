import { defineConfig, devices } from "@playwright/test";
import { BASE_URL, TEST_DATA_ROOT, TEST_PORT } from "./e2e/paths";

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  // admin server は単一プロセスで JSON を読み書きするため直列で決定性を優先する
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 30_000,
  reporter: process.env.CI ? [["line"]] : [["line"], ["html", { open: "never" }]],
  use: { baseURL: BASE_URL, trace: "on-first-retry" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "node scripts/admin-server.mjs",
    url: `${BASE_URL}/admin`,
    // 既存の admin(8790) とは別ポートなので普段の作業を止めない
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: "ignore",
    stderr: "pipe",
    env: {
      PORT: String(TEST_PORT),
      APP_LINK_DATA_ROOT: TEST_DATA_ROOT,
    },
  },
});
