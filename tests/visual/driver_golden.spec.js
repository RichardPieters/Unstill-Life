/**
 * driver_golden.spec.js — characterization gate for the per-frame animation
 * drivers (terrain + water tick behaviour), captured BEFORE the driver-
 * extraction refactor so it brackets it: these live behaviours must be
 * identical before and after the closures move into TerrainDriver/WaterDriver.
 *
 * Drives dynamics.update() manually on a paused loop for a deterministic
 * sequence and asserts behaviour PROPERTIES (not recorded pixel/number
 * snapshots, which would ossify). Drift OFFSET absolute values ride wall-clock
 * realDt (performance.now) and a 2-D walk, so only "drift is alive + finite" is
 * checked here; the precise dNoiseTime≥0 no-rewind glue is unit-tested in
 * terrainDriver.test.js where noiseTime can be scripted deterministically.
 */
import { test, expect } from '@playwright/test'
import { boot } from './helpers.js'

test('driver characterization — terrain + water live tick behaviour', async ({ page }) => {
  // boot() pauses and holds the form still: the form walker rides the same
  // tick this drives, and moves the fBM amplitudes uHeightMax is
  // derived from, so the assertions below must see the drivers alone.
  await boot(page)

  const r = await page.evaluate(() => {
    const { dynamics, terrain, water } = window.__d
    const u  = terrain._material.uniforms
    const hu = terrain._heightmapMaterial.uniforms
    terrain.params.set('frozen', false)
    // Long settle interval so sustained high attention decays restlessness
    // over the run (exercising the sea-level reaction below) without
    // actually reaching 0 and freezing partway through — a frozen sim stops
    // dispatching 'tick' entirely, which would silently stall every
    // assertion downstream of it (ripple time included).
    dynamics.params.set('settleIntervalAtMaxAttention', 300)

    const rows = []
    for (let i = 0; i < 60; i++) {
      dynamics.update(1.0, 1.0)
      rows.push({
        noiseTime:    dynamics.noiseTime,
        restlessness: dynamics.restlessness,
        heightMax:    u.uHeightMax.value,
        uTime:        u.uTime.value,
        persistence:  u.uFBM0Persistence.value,
        offX:         u.uFBM0DriftOffset.value.x,
        offY:         u.uFBM0DriftOffset.value.y,
        seaY:         water.mesh.position.y,
        ripple:       water._material.uniforms.uTime.value,
      })
    }
    return { rows }
  })

  const rows = r.rows
  const first = rows[0], last = rows[rows.length - 1]

  // 1. uHeightMax constant (amps unchanged) and positive.
  for (const row of rows) {
    expect(row.heightMax).toBeGreaterThan(0)
    expect(Math.abs(row.heightMax - first.heightMax)).toBeLessThan(1e-3)
  }
  // 2. uTime mirrors noiseTime exactly.
  for (const row of rows) expect(Math.abs(row.uTime - row.noiseTime)).toBeLessThan(1e-3)
  // 3. Persistence untouched — it's a plain slider, nothing else writes it.
  for (const row of rows) expect(Math.abs(row.persistence - first.persistence)).toBeLessThan(1e-6)
  // 4. Drift alive + finite (absolute path rides wall-clock realDt; not exact).
  expect(rows.every(x => Number.isFinite(x.offX) && Number.isFinite(x.offY))).toBe(true)
  expect(Math.abs(last.offX - first.offX) + Math.abs(last.offY - first.offY),
    'drift offset should move over the run').toBeGreaterThan(0)
  // 5. Restlessness actually decayed but never froze (tick kept dispatching).
  expect(last.restlessness).toBeLessThan(first.restlessness)
  expect(last.restlessness).toBeGreaterThan(0)
  // 6. Water sea level rises as restlessness falls (calm→low, settled→high target).
  expect(last.seaY).toBeGreaterThan(first.seaY)
  // 7. Water ripple time advances every frame (dt>0, speed floor > 0).
  for (let i = 1; i < rows.length; i++) expect(rows[i].ripple).toBeGreaterThan(rows[i - 1].ripple)
})
