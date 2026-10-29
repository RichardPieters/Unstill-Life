/**
 * cloud_shadow.spec.js — the cloud volume's baked sun-shadow field, read by the
 * terrain.
 *
 * cloudsVolume.js bakes `_litRT`, whose .g is optical depth toward the sun
 * integrated inside the shell, and until now only its own march read it. The
 * terrain now reads it too: one fetch per fragment, quantised into flat tiers
 * and multiplied into `shade` AFTER the cel ladder, so the shadow keeps its own
 * hard edges while still falling toward each material's authored shadow floor.
 *
 * What only the real app can prove is that the oracle carries usable CONTRAST
 * at ground level. A ray-averaged debug view of the same field reads a 4.7%
 * spread and suggests a flat wash; read per-point at the terrain surface with
 * its own absorption it is 35-50%. These cases pin that down, as directions and
 * bounds rather than as the numbers of the day.
 */
import { test, expect } from '@playwright/test'
import { boot, screenshotPixels, restoreSeaForm } from './helpers.js'

// Several cases here need four or five full 32-layer relights (~200 frames). No
// per-file timeout: a 90 s override that used to sit here was LOWER than the
// config's 120 s hung-test bound, so a loaded parallel gate timed these out.

const S = 260

const lum = (px, i) => 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]

/** Per-pixel shadow factor (shadows on ÷ shadows off) over the land band. */
function shadowFactor(on, off) {
  const v = []
  for (let y = Math.floor(S * 0.55); y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4
      // Near-black ground makes the ratio numerically meaningless.
      if (lum(off, i) < 12) continue
      v.push(lum(on, i) / lum(off, i))
    }
  }
  v.sort((a, b) => a - b)
  return {
    all: v,
    p05: v[Math.floor(v.length * 0.05)],
    p50: v[Math.floor(v.length * 0.5)],
    max: v[v.length - 1],
    shadowedFraction: v.filter(t => t < 0.95).length / v.length,
  }
}

/**
 * Draw frames until the cloud volume has caught up.
 *
 * Changing overcast moves uCoverage, which invalidates all 32 layers of the lit
 * volume; the bake retires them one per frame. A few forced frames is not
 * enough — the shadow field is then a mix of layers baked at the old coverage
 * and the new, and the measurement lands somewhere between the two.
 *
 * MEASURED, because the number matters and a plausible-looking one is wrong:
 * after an overcast 0.30 -> 0.65 step, 12 frames reports 14.8% of the ground in
 * shadow and 40 frames reports 44.4%. The first is a half-relit volume, not a
 * result. 40 clears the 32-layer backlog with margin.
 */
const SETTLE_FRAMES = 40

async function settleFrames(page) {
  await page.evaluate(async n => {
    for (let i = 0; i < n; i++) {
      window.__d.markDirty()
      await new Promise(r => requestAnimationFrame(() => setTimeout(r, 12)))
    }
  }, SETTLE_FRAMES)
}

async function settle(page) {
  await settleFrames(page)
  return screenshotPixels(page, S)
}

/**
 * Write the scene-wide cloud-shadow settings (shared/sceneUniforms.js). One
 * write reaches terrain and water both: they read the same uniform objects.
 */
async function setShadow(page, values) {
  await page.evaluate(v => {
    for (const [k, x] of Object.entries(v)) window.__d.sceneUniforms.params.set(k, x)
  }, values)
}

async function setWeather(page, overcast) {
  await page.evaluate(o => {
    const a = window.__d.atmosphere
    a.params.set('walking', false); a.params.set('enabled', true)
    a.setChannel('haze', 0); a.setChannel('overcast', o)
    window.__d.clouds.snapEases()   // the cloud amount eases; these cases measure the settled shadow
  }, overcast)
}

test('on by default, and zero is provably inert', async ({ page }) => {
  // Two halves. The feature ships ON at its tuned strength, and BOTH
  // materials must agree about it or the shoreline seams — they read one
  // uniform object. And at zero it must leave the shading transfer — which is
  // tuned, and covered by shading.spec.js — exactly as it was.
  //
  // The inert half is measured against a CONTROL rather than asserted
  // byte-identical: the cloud volume relights amortised and its wind offset
  // scrolls, so two frames of this scene are never bit-for-bit equal and a
  // strict comparison would be testing the renderer's determinism instead.
  await boot(page)
  const [master, amt, oneObject] = await page.evaluate(() => {
    const { sceneUniforms, terrain, water } = window.__d
    const t = terrain._material.uniforms.uCloudShadowAmt
    return [sceneUniforms.params.get('cloudShadowAmt'), t.value, t === water._material.uniforms.uCloudShadowAmt]
  })
  expect(master).toBeGreaterThan(0)
  expect(amt).toBeGreaterThan(0)
  expect(oneObject).toBe(true)

  await setWeather(page, 0.65)
  await setShadow(page, { cloudShadowAmt: 0 })
  const a = await settle(page)
  const control = await settle(page)          // off vs off — the noise floor
  await setShadow(page, { cloudShadowAmt: 1 })
  const on = await settle(page)

  const meanAbsDiff = (x, y) => {
    let sum = 0, n = 0
    for (let i = 0; i < x.length; i += 4) { sum += Math.abs(lum(x, i) - lum(y, i)); n++ }
    return sum / n
  }
  const noise  = meanAbsDiff(a, control)
  const signal = meanAbsDiff(a, on)
  // Switching it on must move the image by far more than the frame-to-frame
  // noise — and, the half that matters here, leaving it off must not.
  expect(signal).toBeGreaterThan(noise * 5)
})

test('the oracle carries real contrast at ground level, and only ever darkens', async ({ page }) => {
  // The cloud dials are pinned to scatter 0.45 and density 0.26. Strength is
  // pinned to the oracle's own depth: the density dial would otherwise scale
  // the shadow to under half and set its depth.
  await boot(page)
  await page.evaluate(() => window.__d.applyFormPositions({ cloudScatter: 0.45, cloudDensity: 0.26 }))
  await setWeather(page, 0.45)
  // Floor 0 isolates the oracle.
  await setShadow(page, { cloudShadowAmt: 0, cloudShadowScale: 1, cloudShadowAbs: 0.5, cloudShadowFloor: 0 })
  const off = await settle(page)
  await setShadow(page, { cloudShadowAmt: 1 })
  const f = shadowFactor(await settle(page), off)

  // Direction: a cloud shadow removes light. Nothing may come out brighter —
  // a factor above 1 would mean the lookup is being read with the wrong sign.
  // The tolerance is for the cel ladder's own antialiasing at a band edge, where
  // a fragment can land a hair either side; it is not a tuning threshold, and a
  // sign error would put this far above 1, not a couple of percent.
  expect(f.max).toBeLessThan(1.05)

  // Some of the ground is shadowed and some is not. Both halves matter: all-lit
  // means the oracle is inert, all-shadowed means it is a flat dimming rather
  // than cloud shadow. How much lies in shadow depends on where the cloud field
  // stands over the view (about 98% under the start scene's clouds), so the
  // upper bound only asks for some lit ground.
  expect(f.shadowedFraction).toBeGreaterThan(0.10)
  expect(f.shadowedFraction).toBeLessThan(0.995)

  // ...and the shadowed ground is meaningfully darker, not a 5% ripple. This is
  // the assertion the whole feature rests on: a ray-averaged read of the same
  // field says 4.7% and would fail here.
  expect(1 - f.p05).toBeGreaterThan(0.15)
})

test('more overcast puts more ground in shadow', async ({ page }) => {
  // The coupling that makes this weather rather than an effect — and it is
  // emergent, not applied: nothing multiplies the shadow by an overcast term.
  // It follows because overcast lowers uCoverage, which thickens the very field
  // the shadow is read from.
  await boot(page)
  const measure = async overcast => {
    await setWeather(page, overcast)
    await setShadow(page, { cloudShadowAmt: 0, cloudShadowFloor: 0 })
    const off = await settle(page)
    await setShadow(page, { cloudShadowAmt: 1 })
    return shadowFactor(await settle(page), off).shadowedFraction
  }
  const clearish = await measure(0.30)
  const broken   = await measure(0.65)
  expect(broken).toBeGreaterThan(clearish)
})

test('the floor bounds how dark a shadow may get', async ({ page }) => {
  // Without a floor a thick cloud drives shade to 0, which removes the terrain's
  // own cel banding entirely and reads as a hole punched in the picture rather
  // than as shade.
  await boot(page)
  await setWeather(page, 1.0)
  await setShadow(page, { cloudShadowAmt: 0, cloudShadowAbs: 2 })
  const off = await settle(page)

  await setShadow(page, { cloudShadowAmt: 1, cloudShadowFloor: 0 })
  const deep = shadowFactor(await settle(page), off).p05
  await setShadow(page, { cloudShadowFloor: 0.8 })
  const lifted = shadowFactor(await settle(page), off).p05

  expect(lifted).toBeGreaterThan(deep)
})

test('the water is shadowed too, from the same oracle', async ({ page }) => {
  // Terrain and water meet at a shoreline, so a shadow that stopped at the
  // waterline would be worse than no shadow — the same rule uFogCurve and
  // uLightLevel already follow. Measured on a band that is mostly sea.
  await boot(page)
  await restoreSeaForm(page)
  await setWeather(page, 0.65)
  const seaBand = px => {
    let sum = 0, n = 0
    for (let y = Math.floor(S * 0.42); y < Math.floor(S * 0.62); y++)
      for (let x = 0; x < Math.floor(S * 0.30); x++) { const i = (y * S + x) * 4; sum += lum(px, i); n++ }
    return sum / n
  }
  // Water ONLY, so this cannot pass on the terrain's shadow leaking into the
  // band (through the translucent water, or along the shore). Terrain and water
  // read ONE amount object, so the terrain is given a private one held at 0 for
  // the measurement, and its shared one back afterwards.
  await page.evaluate(() => {
    const u = window.__d.terrain._material.uniforms
    window.__sharedShadowAmt = u.uCloudShadowAmt
    u.uCloudShadowAmt = { value: 0 }
  })
  let off, on
  try {
    await setShadow(page, { cloudShadowAmt: 0 })
    off = await settle(page)
    await setShadow(page, { cloudShadowAmt: 1 })
    on = await settle(page)
  } finally {
    await page.evaluate(() => {
      window.__d.terrain._material.uniforms.uCloudShadowAmt = window.__sharedShadowAmt
    })
  }
  expect(seaBand(on)).toBeLessThan(seaBand(off))

  // And both materials agree on the shadow depth, or the shoreline seams: one
  // object. The depth slider is clobbered by the cloud-density dial
  // (densityToShadowDepth), so drive the dial, not the slider.
  await page.evaluate(() => window.__d.applyFormPositions(
    { ...window.__d.readForm(), cloudDensity: 0.8 }))
  const [abs, oneObject] = await page.evaluate(() => {
    const { terrain, water } = window.__d
    const t = terrain._material.uniforms.uCloudShadowAbs
    return [t.value, t === water._material.uniforms.uCloudShadowAbs]
  })
  expect(abs).toBeCloseTo(0.8, 6)
  expect(oneObject).toBe(true)
})

test('the ground shadow is redone every frame and eases toward the sky, not once per light cycle', async ({ page }) => {
  // A shadow that jumps as the sky lighting is recalculated is a cadence
  // mismatch. The ground reads the
  // optical depth of the whole column, which the 32-layer cycle would refresh
  // once per 32 frames while uCoverage moves every frame as the weather walks.
  // The ground shadow therefore has its own 2-D target, redone every frame and
  // blended with the last value by an exponential ease (`groundEase`).
  //
  // Asserted on the cadence and the shape of the approach, not on pixels: a
  // screenshot round trip is far slower than a frame, so no pixel measurement
  // can see a per-frame staircase.
  await boot(page, { pause: false })
  const r = await page.evaluate(async () => {
    const { clouds: v, renderer, THREE, atmosphere: a } = window.__d
    a.params.set('walking', false)
    const frame = () => new Promise(res => { window.__d.markDirty(); requestAnimationFrame(res) })
    // Hold the sky's own motion still. Before the warm-up: a wind offset is
    // speed × the clouds' clock, so zeroing the speed moves the field back to
    // its origin and re-anchors the window, which these frames absorb.
    v.params.set('cloudSpeed', 0); v.params.set('weatherSpeed', 0)
    for (let i = 0; i < 40; i++) await frame()
    // groundEase is a time constant: a frame of length dt moves 1 - exp(-dt /
    // groundEase) of the way. At its maximum (1 s) a frame stays under half the
    // jump unless it lasts 0.69 s, so a loaded machine's long frames pass too.
    v.params.set('groundEase', 1)
    const mean = () => {
      const rt = v._ground[v._groundCur], n = rt.width * rt.height
      const buf = new Uint16Array(n * 4)
      const prev = renderer.getRenderTarget()
      renderer.setRenderTarget(rt)
      renderer.readRenderTargetPixels(rt, 0, 0, rt.width, rt.height, buf)
      renderer.setRenderTarget(prev)
      let s = 0
      for (let i = 0; i < n; i++) s += THREE.DataUtils.fromHalfFloat(buf[i * 4 + 1])
      return s / n
    }
    // Thicken the sky all at once.
    v.params.set('coverageEase', 0)
    v.params.set('coverage', v.params.get('coverage') - 0.6); v.snapEases()
    const before = v.groundDraws
    const trail = [mean()]
    for (let i = 0; i < 60; i++) { await frame(); trail.push(mean()) }
    return { draws: v.groundDraws - before, trail }
  })

  // One ground draw per rendered frame, give or take scheduling slop; a 32-layer
  // cursor would give roughly frames/32.
  expect(r.draws).toBeGreaterThan(60 * 0.8)
  const start = r.trail[0], end = r.trail[r.trail.length - 1]
  expect(end, 'the shadow did not deepen with the cloud').toBeGreaterThan(start)
  // An ease: it moves a bit each frame, never overshoots, and no frame takes the
  // whole jump.
  for (let i = 1; i < r.trail.length; i++) {
    expect(r.trail[i], `frame ${i}`).toBeGreaterThanOrEqual(r.trail[i - 1] - 1e-3)
    expect(r.trail[i], `frame ${i} overshoots`).toBeLessThanOrEqual(end + 1e-3)
  }
  expect(r.trail[1] - start, 'the first frame took most of the jump').toBeLessThan((end - start) * 0.5)
})

test('the shadow survives a snapshot round trip', async ({ page }) => {
  // The depth is a plain uniform, carried by the generic capture; the strength
  // master travels beside it (the uniform holds it only scaled by the dial).
  // This is the case that proves both rather than assuming them.
  await boot(page)
  await setShadow(page, { cloudShadowAmt: 0.7, cloudShadowAbs: 0.9 })
  const snap = await page.evaluate(() => window.__d.captureSnapshot())
  await setShadow(page, { cloudShadowAmt: 0, cloudShadowAbs: 0.1 })
  const report = await page.evaluate(s => window.__d.applySnapshot(s), snap)
  expect(report.unknown).toEqual([])
  const [abs, amt] = await page.evaluate(() => [
    window.__d.sceneUniforms.params.get('cloudShadowAbs'), window.__d.sceneUniforms.params.get('cloudShadowAmt'),
  ])
  expect(abs).toBeCloseTo(0.9, 6)
  expect(amt).toBeCloseTo(0.7, 6)
})
