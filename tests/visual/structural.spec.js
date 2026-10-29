import { test, expect } from '@playwright/test'
import { boot, canvasPixelStats, canvasFingerprint, waitFrames } from './helpers.js'

// ─── Setup ───────────────────────────────────────────────────────────────────

test.beforeEach(async ({ page }) => {
  page._consoleErrors = []
  page.on('console', msg => {
    if (msg.type() === 'error') page._consoleErrors.push(msg.text())
  })
})

// ─── Tests ────────────────────────────────────────────────────────────────────

test('page loads without console errors', async ({ page }) => {
  await page.goto('/')
  await page.waitForFunction(() => !!window.__d)
  await waitFrames(page, 10)
  const relevant = page._consoleErrors.filter(e =>
    /webgl|shader|gl_|three/i.test(e)
  )
  expect(relevant).toHaveLength(0)
})

test('canvas is present and fills the viewport', async ({ page }) => {
  await page.goto('/')
  await page.waitForFunction(() => !!window.__d)
  await waitFrames(page, 10)
  // #scene-canvas, not a bare tag selector — see helpers.js's screenshotPixels
  // for why: the debug panel's mic/cam canvases make 'canvas' match 3 elements.
  const canvas   = page.locator('#scene-canvas')
  await expect(canvas).toBeVisible()
  const box      = await canvas.boundingBox()
  const viewport = page.viewportSize()
  expect(box.width).toBeCloseTo(viewport.width, -1)
  expect(box.height).toBeCloseTo(viewport.height, -1)
})

test('terrain has visible height variation — not a solid colour', async ({ page }) => {
  await page.goto('/')
  await page.waitForFunction(() => !!window.__d)
  await waitFrames(page, 10)
  const { mean, variance } = await canvasPixelStats(page)
  // Solid black  → mean ≈ 0,   variance ≈ 0
  // Solid white  → mean ≈ 255, variance ≈ 0
  // NaN blowout  → mean ≈ 255 (all white) or 0 (all black)
  expect(variance).toBeGreaterThan(300)
  expect(mean).toBeGreaterThan(5)
  expect(mean).toBeLessThan(250)
})

// Ground truth is the slider's own value, not a re-read of the readout's
// source — the bug this guards was the readout reading interaction.js's
// hardcoded 0.5 stub, which agrees with the slider only at its default.
test('the attention readout tracks the slider', async ({ page }) => {
  await page.goto('/')
  await page.waitForFunction(() => !!window.__d)
  await waitFrames(page, 10)
  const shown = await page.evaluate(async () => {
    document.getElementById('debug').classList.add('visible')
    const el = document.getElementById('attention')
    el.value = '0.83'
    el.dispatchEvent(new Event('input', { bubbles: true }))
    for (let i = 0; i < 20; i++) await new Promise(r => requestAnimationFrame(r))   // let a tick repaint the readout
    return document.getElementById('val-attention').textContent
  })
  expect(parseFloat(shown)).toBeCloseTo(0.83, 2)
})

test('scene evolves — canvas changes between frames', async ({ page }) => {
  await boot(page, { pause: false, freezeForm: false })
  const fp1 = await canvasFingerprint(page)
  // Wait for the sim to actually advance rather than a fixed sleep, so a loaded
  // machine that renders few frames still sees the scene move.
  await page.waitForFunction(t => window.__d.dynamics.noiseTime > t,
    await page.evaluate(() => window.__d.dynamics.noiseTime))
  const fp2 = await canvasFingerprint(page)
  expect(fp1).not.toBe(fp2)
})
