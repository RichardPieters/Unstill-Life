/**
 * classify.spec.js — biome zonation ORDER, not boundary location. Fixtures sit
 * well inside each band so a legitimate threshold tweak (the artist's constant
 * tuning) doesn't flip them — only a broken zonation DIRECTION (snow at the
 * bottom, sea material on a peak, cliffs not carving) turns these red.
 *
 * Material ids (material.glsl): forest 0, meadow 1, rock 3, snow 4, riparian 5,
 * seabed 6 (2 is unused).
 */
import { test, expect } from '@playwright/test'
import { bootSignal, probeGrid, meanScalar } from './probe.js'
import { byId } from './signalRegistry.js'
import { tiltedPlane } from './fixtures.js'

const VIEW = byId.classify.debugViewId
// Sea pinned well below the land fixtures; HEIGHT_MAX known so tH lands where
// intended. Other thresholds stay at their tuned defaults on purpose — the
// tests assert order, which must hold across any reasonable tuning.
const CTRL = { heightMax: 200, uniforms: { uSeaLevel: -60 } }

const idOf = res => Math.round(meanScalar(res))
const flatAt = h => tiltedPlane(0, 0, h)

test.beforeEach(async ({ page }) => { await bootSignal(page) })

test('high flat ground reads snow (id 4)', async ({ page }) => {
  const res = await probeGrid(page, { fixture: flatAt(150), debugViewId: VIEW, controls: CTRL })
  expect(idOf(res)).toBe(4)
})

test('below sea level reads seabed (id 6)', async ({ page }) => {
  const res = await probeGrid(page, { fixture: flatAt(-120), debugViewId: VIEW, controls: CTRL })
  expect(idOf(res)).toBe(6)
})

test('mid flat ground is a dry-land material, not snow or seabed', async ({ page }) => {
  const id = idOf(await probeGrid(page, { fixture: flatAt(0), debugViewId: VIEW, controls: CTRL }))
  expect(id, `got id ${id}`).not.toBe(4)   // not snow
  expect(id).not.toBe(6)                    // not seabed
  expect(id).toBeGreaterThanOrEqual(0)
  expect(id).toBeLessThanOrEqual(5)
})

test('cliff carve: steep ground reads rock, flat ground does not', async ({ page }) => {
  // Steep plane (flatness cos37°≈0.80 < uCliffFlat) sampled over a small centred
  // region so its height span stays in the mid band (no snow/sea crossing).
  const steep = await probeGrid(page, {
    fixture: tiltedPlane(37, 0, 0), debugViewId: VIEW, controls: CTRL, margin: 700,
  })
  const flat = await probeGrid(page, {
    fixture: flatAt(0), debugViewId: VIEW, controls: CTRL, margin: 700,
  })
  expect(idOf(steep), 'steep → rock').toBe(3)
  expect(idOf(flat), 'flat → not rock').not.toBe(3)
})
