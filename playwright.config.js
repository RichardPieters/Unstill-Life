import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'tests',
  // Vitest owns tests/unit/*.test.js; Playwright owns *.spec.js.
  testMatch: '**/*.spec.js',
  // The frame-time benchmark runs via playwright.perf.config.js (alone, one
  // worker — it measures the machine, so it cannot be reliable while other
  // specs load the GPU).
  testIgnore: ['tests/performance/**'],
  // Generous on purpose: GPU work slows several-fold when every worker renders
  // at once, and a spec must never fail just because the machine is busy.
  // Timing-sensitive specs run on frame counts or a fake/manual clock instead
  // of wall-clock sleeps, so this only bounds a genuinely hung test.
  timeout: 120_000,
  use: {
    // Production build served locally — matches CI behaviour
    baseURL: 'http://localhost:4173',
    // Enable WebGL in headless Chromium
    launchOptions: {
      args: ['--enable-webgl', '--use-gl=angle', '--no-sandbox'],
    },
  },
  // Start `vite preview` (production build) before the test suite runs
  webServer: {
    command: 'npm run build && npm run preview -- --port 4173',
    port: 4173,
    reuseExistingServer: true,
    timeout: 30_000,
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
  ],
})
