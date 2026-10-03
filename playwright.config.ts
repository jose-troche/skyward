import { defineConfig, devices } from '@playwright/test';

// Runs against a local `wrangler dev` by default; set BASE_URL to test a deployed instance.
const external = process.env.BASE_URL;
const port = 8788;

export default defineConfig({
  testDir: 'e2e',
  timeout: 180_000,
  expect: { timeout: 20_000 },
  fullyParallel: true,
  workers: process.env.CI ? 2 : 4,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: external ?? `http://localhost:${port}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    viewport: { width: 1440, height: 900 },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
  webServer: external
    ? undefined
    : {
        command: `npm run build && npx wrangler dev --port ${port} --persist-to .wrangler/e2e-state`,
        url: `http://localhost:${port}/api/health`,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
});
