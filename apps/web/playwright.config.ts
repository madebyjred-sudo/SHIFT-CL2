/**
 * Playwright config — happy-path smoke for the demo flow.
 *
 * The tests live in `tests/e2e/`. They start the Vite dev server
 * automatically (so the operator only needs to run `npm run test:e2e`
 * after `npm run test:e2e:install` for the first time).
 *
 * No screenshots checked in — Playwright keeps them in test-results/
 * which is gitignored.
 */
import { defineConfig, devices } from '@playwright/test';

const isCI = !!process.env.CI;

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,                         // share dev server cleanly
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  workers: 1,                                   // dev server is single-process
  reporter: isCI ? 'github' : 'list',

  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:5173',
    trace: 'on-first-retry',
    actionTimeout: 8_000,
    navigationTimeout: 12_000,
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  webServer: process.env.E2E_BASE_URL
    ? undefined                                 // operator already has a server up
    : {
        command: 'npm run dev',
        url: 'http://localhost:5173',
        reuseExistingServer: !isCI,
        timeout: 60_000,
      },
});
