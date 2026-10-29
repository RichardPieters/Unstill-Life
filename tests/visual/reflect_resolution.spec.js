/**
 * reflect_resolution.spec.js — guards the mirror-resolution debug slider
 * (the water's `reflectScale` param): renders the reflection pass at a
 * fraction of the canvas resolution, then relies on bilinear texture
 * sampling to blow it back up — softer/blurrier at low settings, cheaper to
 * render (a full terrain+scene redraw shrinks with it).
 *
 * See water.js's `_rebuildReflectRT` header comment for the LINEAR vs.
 * NEAREST tradeoff considered here: the reflection is sampled via a
 * projected UV, so either filter needs zero shader changes — this is purely
 * an aesthetic choice, verified here rather than left to a screenshot to hint at.
 */
import { test, expect } from '@playwright/test'
import { boot } from './helpers.js'

test('mirror-resolution slider scales the reflection RT and samples it with LINEAR filtering', async ({ page }) => {
  await boot(page, { pause: true })

  const result = await page.evaluate(() => {
    const { water, THREE } = window.__d
    const full = { w: water._fullSize.w, h: water._fullSize.h }

    water.params.set('reflectScale', 1.0)
    const atFull = {
      w: water._reflectRT.width, h: water._reflectRT.height,
      minFilter: water._reflectRT.texture.minFilter,
      magFilter: water._reflectRT.texture.magFilter,
    }

    water.params.set('reflectScale', 0.25)
    const atQuarter = { w: water._reflectRT.width, h: water._reflectRT.height }

    // Below the clamp floor — must not collapse to a 0-pixel RT.
    water.params.set('reflectScale', 0)
    const atZero = { w: water._reflectRT.width, h: water._reflectRT.height }

    water.params.set('reflectScale', 1.0)   // restore, so this test doesn't leak state
    return { full, atFull, atQuarter, atZero, linear: THREE.LinearFilter }
  })

  expect(result.atFull.w).toBe(result.full.w)
  expect(result.atFull.h).toBe(result.full.h)
  expect(result.atFull.minFilter).toBe(result.linear)
  expect(result.atFull.magFilter).toBe(result.linear)

  expect(result.atQuarter.w).toBe(Math.round(result.full.w * 0.25))
  expect(result.atQuarter.h).toBe(Math.round(result.full.h * 0.25))

  expect(result.atZero.w).toBeGreaterThan(0)
  expect(result.atZero.h).toBeGreaterThan(0)
})
