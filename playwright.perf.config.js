import { defineConfig } from '@playwright/test'
import base from './playwright.config.js'

// The frame-time benchmark (`tests/performance/`). It measures how fast THIS
// machine renders, so it runs alone, on one worker, never alongside the gate.
// Run: npm run test:perf
export default defineConfig({
  ...base,
  testIgnore: [],
  testMatch: 'performance/**/*.spec.js',
  workers: 1,
})
