import { defineConfig } from "@playwright/test"
import { getSiteBasePath } from "./scripts/site-paths.mjs"

const baseURL = `http://127.0.0.1:4173${getSiteBasePath()}/`

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: "list",
  use: {
    baseURL,
    browserName: "chromium",
    headless: true,
    viewport: { width: 1280, height: 800 },
  },
  webServer: {
    command: "node scripts/serve-built-site.mjs",
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
})
