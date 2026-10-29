/**
 * sun_azimuth.spec.js — the sun-position azimuth control.
 *
 * uSunAzimuth is a horizontal (x,z) direction shared by terrain and the cloud
 * system (so terrain shading and the cloud gradient always agree on where
 * the sun is). The `sunAzimuth` param (degrees) rotates it while holding
 * its magnitude fixed — that magnitude is elevation's axis, not azimuth's
 * (see uSunElevation), so a real bug here would be azimuth bleeding into
 * elevation or vice versa. Checked as an exact invariant (radius preserved,
 * angle advances by exactly the requested delta), not a rendered pixel diff.
 */
import { test, expect } from '@playwright/test'
import { boot } from './helpers.js'

test('rotating sun azimuth preserves its magnitude and syncs to the cloud system', async ({ page }) => {
  await boot(page, { pause: false })
  const result = await page.evaluate(async () => {
    const { terrain, clouds } = window.__d
    const before = terrain.getSunAzimuth()
    const radiusBefore = Math.hypot(before.x, before.y)
    const angleBefore = terrain.params.get('sunAzimuth')

    terrain.params.set('sunAzimuth', angleBefore + 90)
    // Let main.js's render loop run at least once to push the new azimuth
    // into the cloud system (that sync happens in the frame loop, not the
    // setter itself — see main.js).
    await new Promise(r => requestAnimationFrame(r))
    await new Promise(r => requestAnimationFrame(r))

    const after = terrain.getSunAzimuth()
    const cloudAz = clouds._shared.uSunAzimuth.value
    return {
      angleDelta: terrain.params.get('sunAzimuth') - angleBefore,
      radiusAfter: Math.hypot(after.x, after.y),
      radiusBefore,
      matchesClouds: Math.abs(after.x - cloudAz.x) < 1e-6 && Math.abs(after.y - cloudAz.y) < 1e-6,
    }
  })

  expect(result.angleDelta, 'angle should advance by exactly the requested 90°').toBeCloseTo(90, 5)
  expect(result.radiusAfter, "rotating azimuth shouldn't change its magnitude (that's elevation's job)")
    .toBeCloseTo(result.radiusBefore, 5)
  expect(result.matchesClouds, 'the cloud system should see the same sun azimuth as terrain').toBe(true)
})

test('sun azimuth angle survives a scene-snapshot round trip', async ({ page }) => {
  await boot(page)
  const result = await page.evaluate(() => {
    const { terrain } = window.__d
    // A restore re-reads the angle from the vector through atan2, folded into
    // [0, 360) — a value inside that range round-trips.
    terrain.params.set('sunAzimuth', 100)
    const angleSet = terrain.params.get('sunAzimuth')
    const snap = terrain.exportState()
    terrain.params.set('sunAzimuth', 10)   // perturb, so restore is actually exercised
    terrain.importState(snap)
    return { angleSet, angleRestored: terrain.params.get('sunAzimuth') }
  })
  expect(result.angleRestored).toBeCloseTo(result.angleSet, 5)
})
