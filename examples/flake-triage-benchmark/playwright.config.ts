import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// The DW zero-edit band is a SINGLE conditional reporter line — toggled by env so the experiment can
// measure with/without DW cleanly. `DW=1` turns on the published deltawright reporter (side-cars).
const ROOT = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.EXP_BASE ?? 'http://127.0.0.1:5300';
const DW = process.env.DW === '1';
const RUN = process.env.RUN_ID ?? 'run';

export default defineConfig({
  testDir: 'suite',
  fullyParallel: true,
  workers: process.env.CI ? 2 : 4,
  reporter: [
    ['list'],
    ['json', { outputFile: resolve(ROOT, `results/${RUN}.results.json`) }],
    // ↓↓↓ the entire "zero-edit" adoption cost: this one line (absolute outputDir → predictable location).
    ...(DW ? [['deltawright/reporter', { outputDir: resolve(ROOT, `results/${RUN}-sidecars`) }] as const] : []),
  ],
  use: {
    baseURL: BASE,
    trace: 'retain-on-failure',
    actionTimeout: 4000,
    navigationTimeout: 8000,
  },
  webServer: {
    command: 'node server/server.mjs',
    url: BASE,
    reuseExistingServer: true,
    timeout: 10000,
  },
  projects: [
    { name: 'control', testDir: 'suite/control', use: { ...devices['Desktop Chrome'] } },
    { name: 'greenfield', testDir: 'suite/greenfield', use: { ...devices['Desktop Chrome'] } },
  ],
});
