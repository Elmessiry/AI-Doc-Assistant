import { defineConfig, devices } from "@playwright/test";
import dotenv from "dotenv";

// Load app vars then test-only vars. dotenv does not override already-set vars,
// so in CI the real environment (GitHub secrets) wins and these files are absent.
dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env.test.local" });

const PORT = 3000;
const baseURL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1,
  // Fail the build if someone commits test.only; retry in CI to absorb the
  // transient flakiness of a test that hits live Supabase + OpenRouter.
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [["github"], ["line"]] : "html",
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  projects: [
    { name: "setup", testMatch: /auth\.setup\.ts/ },
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        storageState: "e2e/.auth/user.json",
      },
      dependencies: ["setup"],
    },
  ],
  // Build and serve the production app, matching how it runs on Vercel.
  webServer: {
    command: "npm run build && npm run start",
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
