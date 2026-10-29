/**
 * curvature.spec.js — the concavity/hollowness signals. No absolute VALUES are
 * asserted (that would re-implement the k=(REF/r)² normalization + remap = a
 * mirror). Instead:
 *
 *  - concaveSmall radius-INDEPENDENCE (property): on a constant-curvature
 *    paraboloid, concaveSmall = k·REF²/HEIGHT_MAX — independent of
 *    creaseRadius. Sweeping creaseRadius must leave it unchanged. This is
 *    exactly the r²-normalization; the raw (unnormalized) signal would scale
 *    with radius², and this test goes red.
 *  - concavity SIGN: bowl (k>0) reads concave (+), dome (k<0) convex (−),
 *    flat ~0.
 *  - hollowness ORDERING: basin > flat > dome (the consumer-facing "basin-ness").
 *
 * concaveLarge carries an intentional hollowR/creaseR weighting (not radius-
 * independent), so only its sign is checked, via hollowness ordering.
 */
import { test, expect } from '@playwright/test'
import { bootSignal, probeGrid, meanScalar } from './probe.js'
import { byId } from './signalRegistry.js'
import { paraboloid, tiltedPlane } from './fixtures.js'

// Curvature gentle enough that concaveSmall stays off the [-1,1] clamp.
// (The signal's gain is fixed at 1.)
const BOWL = paraboloid(0.0036)
const DOME = paraboloid(-0.0036)
const FLAT = tiltedPlane(0, 0)

// Pin the curvature-relevant controls to known values (HEIGHT_MAX sets the
// concaveSmall scale; radii are what the property test sweeps).
const base = { heightMax: 200, uniforms: {} }

test.beforeEach(async ({ page }) => { await bootSignal(page) })

test('concaveSmall is radius-independent (sweep creaseRadius)', async ({ page }) => {
  const radii = [10, 15, 20, 30]
  const vals = []
  for (const r of radii) {
    const res = await probeGrid(page, {
      fixture: BOWL,
      debugViewId: byId.concaveSmall.debugViewId,
      controls: { ...base, uniforms: { ...base.uniforms, uCreaseRadius: r } },
    })
    vals.push(meanScalar(res))
  }
  const range = Math.max(...vals) - Math.min(...vals)
  // Radius-independent → all equal. A raw (unnormalized) signal would scale
  // with r², spanning the whole [10,30] sweep — range would be large.
  expect(range, `concaveSmall over creaseRadius ${radii} = ${vals.map(v => v.toFixed(3))}`)
    .toBeLessThan(0.05)
  // and it must actually be a live, non-zero signal (not clamped/dead)
  expect(Math.abs(vals[0]), 'concaveSmall should be clearly non-zero on a bowl').toBeGreaterThan(0.05)
})

test('concaveSmall sign: bowl + / dome − / flat ~0', async ({ page }) => {
  const bowl = meanScalar(await probeGrid(page, { fixture: BOWL, debugViewId: byId.concaveSmall.debugViewId, controls: base }))
  const dome = meanScalar(await probeGrid(page, { fixture: DOME, debugViewId: byId.concaveSmall.debugViewId, controls: base }))
  const flat = meanScalar(await probeGrid(page, { fixture: FLAT, debugViewId: byId.concaveSmall.debugViewId, controls: base }))
  expect(bowl, `bowl=${bowl.toFixed(3)}`).toBeGreaterThan(0.05)
  expect(dome, `dome=${dome.toFixed(3)}`).toBeLessThan(-0.05)
  expect(Math.abs(flat), `flat=${flat.toFixed(3)}`).toBeLessThan(0.03)
})

test('hollowness ordering: basin > flat > dome', async ({ page }) => {
  const bowl = meanScalar(await probeGrid(page, { fixture: BOWL, debugViewId: byId.hollowness.debugViewId, controls: base }))
  const flat = meanScalar(await probeGrid(page, { fixture: FLAT, debugViewId: byId.hollowness.debugViewId, controls: base }))
  const dome = meanScalar(await probeGrid(page, { fixture: DOME, debugViewId: byId.hollowness.debugViewId, controls: base }))
  expect(bowl, `bowl=${bowl.toFixed(3)} flat=${flat.toFixed(3)}`).toBeGreaterThan(flat + 0.05)
  expect(flat, `flat=${flat.toFixed(3)} dome=${dome.toFixed(3)}`).toBeGreaterThan(dome + 0.05)
})
