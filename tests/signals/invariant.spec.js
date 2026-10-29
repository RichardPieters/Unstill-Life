/**
 * invariant.spec.js — signals with no analytic ground truth: assert bounds and
 * a monotonic response to a controlled change, never a value.
 *
 * moisture (drainMoisture) composites concavity + hollowness + a water-table
 * term + runoff. A JS re-type of its weighted sum would be a drifting mirror,
 * so instead: it must stay in [0,1] and must rise with basin-ness.
 *
 * Erosion signals (ridge / erosion-delta, views 7/8) are NOT tested here: the
 * fixture bypasses the erosion pass (G/B channels forced 0), so they read a
 * constant 0 under any fixture. Testing them needs the live erosion pipeline
 * (invariant/range on real output) — deferred to a future pass.
 */
import { test, expect } from '@playwright/test'
import { bootSignal, probeGrid, meanScalar } from './probe.js'
import { byId } from './signalRegistry.js'
import { paraboloid } from './fixtures.js'

const VIEW = 6   // moisture debug view
const CTRL = { heightMax: 200, uniforms: { uSeaLevel: -400 } }
// The moisture signal's gain is fixed at 1, so this curvature is chosen to
// give a measurable magnitude at that gain.
const CURVE = 0.0036

test.beforeEach(async ({ page }) => { await bootSignal(page) })

test('moisture stays within [0,1]', async ({ page }) => {
  const res = await probeGrid(page, { fixture: paraboloid(CURVE), debugViewId: VIEW, controls: CTRL })
  const lo = Math.min(...res.samples.map(s => s.v[0]))
  const hi = Math.max(...res.samples.map(s => s.v[0]))
  expect(lo, `min=${lo.toFixed(3)}`).toBeGreaterThanOrEqual(-0.001)
  expect(hi, `max=${hi.toFixed(3)}`).toBeLessThanOrEqual(1.001)
})

test('moisture rises with basin-ness (bowl wetter than dome)', async ({ page }) => {
  const bowl = meanScalar(await probeGrid(page, { fixture: paraboloid(CURVE),  debugViewId: VIEW, controls: CTRL }))
  const dome = meanScalar(await probeGrid(page, { fixture: paraboloid(-CURVE), debugViewId: VIEW, controls: CTRL }))
  expect(bowl, `bowl=${bowl.toFixed(3)} dome=${dome.toFixed(3)}`).toBeGreaterThan(dome + 0.03)
})
