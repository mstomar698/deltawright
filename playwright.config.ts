import { defineConfig, devices } from '@playwright/test';

// v0.1 runs a single controlled fixture on headless Chromium. Serial + fixed
// viewport keeps geometry assertions deterministic.
export default defineConfig({
  testDir: './test',
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    headless: true,
    viewport: { width: 1280, height: 720 },
  },
});
