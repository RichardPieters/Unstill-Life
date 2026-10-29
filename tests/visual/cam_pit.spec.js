/**
 * cam_pit.spec.js — guards heightmap.frag's applyCamPit, the camera-safety
 * cap that stops the terrain's own drift from growing a peak through
 * the fixed authored camera position (fly mode is debug-only, so only that
 * one static point needs the guarantee).
 *
 * The claim under test: h_final(CAM_POSITION.xz) <= uCamPitFloor, ALWAYS, for
 * any terrain configuration — not a tuning value, a structural invariant of
 * min(h, mix(floor, uHeightMax, 1-(1-r/radius)^ease)) at r=0. Reads RT_A
 * directly (same technique as mantle.spec.js) rather than a fixture, since
 * the claim must hold against the live fBM+ridge+erosion pipeline, not an
 * analytic stand-in.
 *
 * The ease-out curve has a NONZERO slope at r=0 (heavier ease = steeper), so
 * the nearest sampled texel — up to half a texel off the true r=0 point — no
 * longer reads a value indistinguishable from the floor. The test mirrors the
 * ceiling formula itself (not the noise/erosion under it) to predict that
 * texel's exact expected ceiling from its true r, so the assertion stays
 * exact as the ease/radius sliders move instead of a hand-tuned tolerance.
 *
 * The actual safety precondition — uCamPitFloor's slider can never be pushed
 * above CAM_POSITION.y with margin — lives in the pit-floor row's `max` (terrainParams.js), not
 * in any shader math, so it is asserted directly against the generated slider.
 */
import { test, expect } from '@playwright/test'
import { boot } from './helpers.js'
import { CAM_POSITION } from '../../src/shared/sceneConfig.js'

const SAFETY_MARGIN = 5   // world units — see the ctrl-cam-pit-floor row's max in terrainParams.js

/**
 * Read RT_A height at the world point nearest (x,z), and return the exact
 * texel-center world coordinates that were actually sampled (they land up to
 * half a texel off the requested point — the mapping the shader itself uses).
 */
async function heightNear(page, x, z) {
  return page.evaluate(({ x, z }) => {
    const { THREE, terrain, renderer } = window.__d
    terrain.renderDataMap()
    const rt = terrain._dataMapRT
    const N = rt.width
    const planeSize = terrain._material.uniforms.uPlaneSize.value
    const isHalf = rt.texture.type === THREE.HalfFloatType
    const buf = isHalf ? new Uint16Array(N * N * 4) : new Float32Array(N * N * 4)
    renderer.readRenderTargetPixels(rt, 0, 0, N, N, buf)
    const half = h => {
      const s = (h & 0x8000) ? -1 : 1, e = (h & 0x7c00) >> 10, f = h & 0x03ff
      if (e === 0) return s * Math.pow(2, -14) * (f / 1024)
      return s * Math.pow(2, e - 15) * (1 + f / 1024)
    }
    const u = x / planeSize + 0.5, v = z / planeSize + 0.5
    const i = Math.min(N - 1, Math.max(0, Math.round(u * N - 0.5)))
    const j = Math.min(N - 1, Math.max(0, Math.round(v * N - 0.5)))
    const o = (j * N + i) * 4
    const sampledX = ((i + 0.5) / N - 0.5) * planeSize
    const sampledZ = ((j + 0.5) / N - 0.5) * planeSize
    return { h: isHalf ? half(buf[o]) : buf[o], sampledX, sampledZ }
  }, { x, z })
}

/** Mirror of heightmap.frag's applyCamPit ceiling — the formula under test,
 *  not the noise/erosion field it caps (see file header). */
function expectedCeiling(r, { radius, floor, ease, heightMax }) {
  const t = Math.min(1, Math.max(0, r / Math.max(radius, 1e-4)))
  const ceilT = 1 - Math.pow(1 - t, Math.max(ease, 1))
  return floor + ceilT * (heightMax - floor)
}

test('pit floor slider max is held below CAM_POSITION.y with margin', async ({ page }) => {
  await boot(page, { pause: true })
  const max = await page.locator('#ctrl-cam-pit-floor').getAttribute('max')
  expect(Number(max)).toBeLessThanOrEqual(CAM_POSITION.y - SAFETY_MARGIN)
})

test('height at the camera column never exceeds the formula-predicted ceiling, across configurations', async ({ page }) => {
  await boot(page, { pause: true })
  const pit = await page.evaluate(() => {
    const u = window.__d.terrain._heightmapMaterial.uniforms
    return { radius: u.uCamPitRadius.value, floor: u.uCamPitFloor.value, ease: u.uCamPitEase.value, heightMax: u.uHeightMax.value }
  })

  const configs = [
    {},
    { uRidgeAmt: 0.9, uFBM0Amp: 300, uFBM1Amp: 300 },
    { uErosionStrength: 0.6, uErosionGullyWeight: 0.5 },
    { uMantleBias: 80 },
  ]
  for (const cfg of configs) {
    await page.evaluate(cfg => {
      const u = window.__d.terrain._material.uniforms
      for (const [k, v] of Object.entries(cfg)) if (u[k]) u[k].value = v
    }, cfg)
    const { h, sampledX, sampledZ } = await heightNear(page, CAM_POSITION.x, CAM_POSITION.z)
    const r = Math.hypot(sampledX - CAM_POSITION.x, sampledZ - CAM_POSITION.z)
    // Float-precision slack only — the bound itself is the mirrored formula
    // evaluated at the texel's TRUE r, not a hand-picked tolerance.
    expect(h, JSON.stringify(cfg)).toBeLessThanOrEqual(expectedCeiling(r, pit) + 0.1)
  }
})

test('the pit is a no-op far outside its radius', async ({ page }) => {
  await boot(page, { pause: true })
  // Pin a small radius regardless of the live slider default, so "far" is
  // unambiguously outside it no matter how the default gets retuned later.
  await page.evaluate(() => { window.__d.terrain._heightmapMaterial.uniforms.uCamPitRadius.value = 50 })
  const far = { x: CAM_POSITION.x + 400, z: CAM_POSITION.z }

  const withPit = (await heightNear(page, far.x, far.z)).h
  await page.evaluate(() => {
    const u = window.__d.terrain._heightmapMaterial.uniforms
    u.uCamPitFloor.value = u.uHeightMax.value   // floor==ceiling everywhere → min() is a pure no-op
  })
  const disabled = (await heightNear(page, far.x, far.z)).h

  expect(withPit).toBeCloseTo(disabled, 3)
})

// Regression: an earlier version used min(h, ceiling(r)) directly. Since the
// ceiling depends only on r, that made the entire compressed area read back
// as the bare ceiling function — a flat-walled bowl with none of the actual
// terrain's relief. The fix is a proportional RESCALE, so height inside the
// disc must still vary with the underlying noise, not collapse to a function
// of r alone (flat walls around the camera would result).
test('terrain relief survives inside the disc — height is not purely a function of r', async ({ page }) => {
  await boot(page, { pause: true })
  await page.evaluate(() => {
    const u = window.__d.terrain._heightmapMaterial.uniforms
    u.uCamPitRadius.value = 400
    u.uCamPitFloor.value = 20
  })
  // Close to the camera, so the ceiling sits well below typical raw terrain
  // height and the rescale is guaranteed to actually engage (not an identity
  // pass-through) — the old min(h, ceiling(r)) bug only shows up once h > ceiling.
  const probe = { x: CAM_POSITION.x + 10, z: CAM_POSITION.z }
  const before = (await heightNear(page, probe.x, probe.z)).h
  await page.evaluate(() => {
    window.__d.terrain._material.uniforms.uFBM0DriftOffset.value.set(400, -300)
  })
  const after = (await heightNear(page, probe.x, probe.z)).h

  expect(Math.abs(after - before)).toBeGreaterThan(0.5)
})
