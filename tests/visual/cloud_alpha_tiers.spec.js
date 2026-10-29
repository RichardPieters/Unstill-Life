/**
 * Opacity tiers are N flat levels spread evenly over 0..1, and the top one is
 * fully opaque.
 *
 * Two defects this guards:
 *  - A thick cloud must not top out at (N-1)/N (0.8 of 5 tiers), which would
 *    let a fifth of the scene behind it show through. The densest tier must reach 255.
 *  - `floor(a*N)/N` would return N, a bucket of its own, for a == 1.0
 *    exactly, and the 8-bit cloud target rounds anything above ~254.5/255 to
 *    255, so one LSB of input became a full 1/N jump (pale flecks in a flat
 *    deck). No byte may land between two tier levels.
 *
 * ASSERTED AS AN EXACT INVARIANT on the cloud render target the march writes
 * the quantized value into, not a screenshot: every alpha byte is one of the N
 * levels k/(N-1), within one LSB, at any N, at settings dense enough that some
 * rays saturate.
 */
import { test, expect } from '@playwright/test'
import { boot, waitFrames } from './helpers.js'

/** Dense enough that some rays actually saturate — checked below, not assumed. */
async function setupDenseDeck(page) {
  await page.evaluate(() => {
    const d = window.__d
    const p = d.clouds.params
    p.set('enabled', true)
    // Pushed well past the dense settings (absorption 0.075,
    // densityScale 4.5): those alone are not guaranteed to saturate a ray
    // under every camera pose, and the invariant below needs some pixels
    // that actually do, checked explicitly rather than assumed.
    p.set('absorption', 0.5)
    p.set('densityScale', 40)
    p.set('coverage', 0.02)   // runs backwards: lower = more cloud
    d.clouds.snapEases()
    p.set('colorSteps', 9)
  })
  await waitFrames(page, 40)
}

/** The distinct alpha bytes (0-255) in the cloud RT, at a given tier count. */
async function alphaLevels(page, tiers) {
  return page.evaluate(n => {
    const v = window.__d.clouds
    v.params.set('alphaTiers', n)
    v._marchDirty = true
    window.__d.markDirty()
    return new Promise(resolve => {
      setTimeout(() => {
        const rt = v._cloudRT
        const buf = new Uint8Array(4 * rt.width * rt.height)
        window.__d.renderer.readRenderTargetPixels(rt, 0, 0, rt.width, rt.height, buf)
        const seen = new Set()
        for (let i = 3; i < buf.length; i += 4) seen.add(buf[i])
        resolve([...seen].sort((a, b) => a - b))
      }, 300)
    })
  }, tiers)
}

test('opacity tiers fill 0 to 1 evenly, and the densest is fully opaque', async ({ page }) => {
  const errors = await boot(page, { pause: false })
  await setupDenseDeck(page)

  // Not vacuous: with quantizing off, some rays must actually be saturating.
  const continuous = await alphaLevels(page, 0)
  expect(continuous[continuous.length - 1]).toBe(255)

  for (const N of [2, 5, 9]) {
    const levels = await alphaLevels(page, N)
    const allowed = Array.from({ length: N }, (_, k) => Math.round(k / (N - 1) * 255))
    for (const byte of levels) {
      expect(allowed.some(a => Math.abs(a - byte) <= 1), `byte ${byte} at N=${N}`).toBe(true)
    }
    expect(levels[levels.length - 1], `the densest tier at N=${N}`).toBeGreaterThanOrEqual(254)
  }
  expect(errors).toEqual([])
})
