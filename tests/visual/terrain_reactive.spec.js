// Guard: the terrain MUST re-render when a shared fBM uniform changes.
//
// The terrain geometry displaces from uDataMap, produced by the heightmap
// pass — a SEPARATE material that shares the fBM/drift uniform OBJECTS
// with the terrain material by reference (terrain.js). If a refactor ever
// copies those values instead of sharing the reference, drift/momentum
// stop reaching the data map: the mountains freeze while water keeps moving —
// and the existing "scene evolves" gate still passes, because water alone keeps
// the frame changing. This test removes water from the equation and pokes a
// shared uniform directly, so that failure mode is caught.
import { test, expect } from '@playwright/test'
import { boot, canvasFingerprint, waitFrames } from './helpers.js'

test('terrain re-renders when a shared fBM uniform changes (data-map wiring)', async ({ page }) => {
  const errors = await boot(page, { pause: true, settleMs: 700 })

  // Isolate terrain: hide water so any frame change is terrain-only. Sky is a
  // constant background, so with water gone the fingerprint is a terrain hash.
  await page.evaluate(() => window.__d.water.params.set('enabled', false))
  await waitFrames(page, 3)
  const before = await canvasFingerprint(page)

  // Poke a shared uniform hard: a large drift-offset jump shifts the sampled
  // fBM domain well beyond one feature wavelength. This reaches the data-map
  // pass ONLY through the shared-by-reference wiring; the render loop rebakes
  // the map every frame, so a couple frames later the terrain must look
  // different.
  await page.evaluate(() => {
    const u = window.__d.terrain._material.uniforms
    u.uFBM0DriftOffset.value.set(400, 400)
    u.uFBM1DriftOffset.value.set(400, 400)
    // Writing a uniform by hand is the programmatic path, which has to announce
    // itself — a panel control gets this from the debug panel's own input/change
    // listener, and the render loop now skips the data-map pass on frames where
    // nothing claims to have changed. Without this the poke below lands in the
    // uniform and the map that reads it is never rebaked.
    window.__d.markDirty()
  })
  await waitFrames(page, 3)
  const after = await canvasFingerprint(page)

  // Fingerprint is a summed hash of a 64px downsample; a domain shift this
  // large moves it well clear of sampling noise.
  expect(Math.abs(after - before)).toBeGreaterThan(50)
  expect(errors).toEqual([])
})
