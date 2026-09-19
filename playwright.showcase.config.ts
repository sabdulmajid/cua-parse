import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/showcase",
  testMatch: "*.browser.test.ts",
  workers: 1,
  timeout: 30000,
  use: {
    baseURL:
      process.env.SHOWCASE_BASE_URL || "http://127.0.0.1:3310/cua-parse/",
    channel: process.env.CI ? undefined : "chrome",
    headless: true,
    viewport: { width: 1440, height: 1050 },
    screenshot: "only-on-failure",
  },
  webServer: process.env.SHOWCASE_BASE_URL
    ? undefined
    : {
        command: "node scripts/serve-showcase.mjs",
        url: "http://127.0.0.1:3310/cua-parse/",
        reuseExistingServer: false,
        timeout: 15000,
      },
  reporter: "list",
});
