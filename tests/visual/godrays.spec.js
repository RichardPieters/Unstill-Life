/**
 * godrays.spec.js — volumetric light shafts.
 *
 * The march reads the SAME baked sun-shadow field the clouds light themselves
 * with and the ground reads for its shadows, so nothing here is a new
 * bake. What only the real app can prove is that the pass reaches the pixels,
 * that it is carved by cloud rather than by the terrain silhouette, that it
 * leans toward the sun's side of the frame, and that it does not quietly burn
 * the frame budget the static gate exists to save.
 */
import { test, expect } from '@playwright/test'
import { boot, screenshotPixels } from './helpers.js'

test.describe.configure({ timeout: 90_000 })

const S = 260
const lum = (px, i) => 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]

const meanOver = (px, x0, x1) => {
  let s = 0, n = 0
  for (let y = 0; y < S; y++)
    for (let x = Math.floor(S * x0); x < Math.floor(S * x1); x++) {
      const i = (y * S + x) * 4; s += lum(px, i); n++
    }
  return s / n
}
const frameMean = px => meanOver(px, 0, 1)

async function settle(page) {
  // At least 40 frames, then until the cloud light has converged: a relight is
  // one layer a frame and its fade a second cycle, so a fixed count can end
  // mid-fade.
  await page.evaluate(async () => {
    const converged = () => {
      const c = window.__d.clouds
      const d = c.getDiagnostics()
      return d.lightPending === 0 && d.shapePending === 0 && !c._litFading
    }
    for (let i = 0; i < 300 && (i < 40 || !converged()); i++) {
      window.__d.markDirty()
      await new Promise(r => requestAnimationFrame(() => setTimeout(r, 12)))
    }
  })
  return screenshotPixels(page, S)
}

async function setWeather(page, overcast) {
  await page.evaluate(o => {
    const a = window.__d.atmosphere
    a.params.set('walking', false); a.params.set('enabled', true)
    a.setChannel('haze', 0); a.setChannel('overcast', o)
    window.__d.clouds.snapEases()   // the cloud amount eases; these cases measure the settled shafts
    // The shipped brightness keeps the faint air under the first tier; these cases need shafts to measure.
    window.__d.godrays.params.set('intensity', 4)
  }, overcast)
}

test('on by default, and under a grey sky it reaches the pixels', async ({ page }) => {
  await boot(page)
  expect(await page.evaluate(() => window.__d.godrays.params.get('enabled'))).toBe(true)

  await setWeather(page, 1)
  const off = await page.evaluate(() => { window.__d.godrays.params.set('enabled', false) }).then(() => settle(page))
  await page.evaluate(() => window.__d.godrays.params.set('enabled', true))
  const on = await settle(page)

  // Direction, not magnitude: shafts are ADDITIVE in-scattered light, so they
  // can only ever brighten. A pass that darkened would mean the composite is
  // blending rather than adding.
  expect(frameMean(on)).toBeGreaterThan(frameMean(off))
})

/**
 * The march's own uDepthTexture is water.js's depth prepass, rendered with the
 * water MESH HIDDEN (see water.js's depthPrePass doc) — so it is blind to the
 * water surface itself, and a beam over a lake used to march all the way to
 * the real lake floor beneath it. main.js pushes the live sea level into the
 * march every frame so it can clip there analytically instead (see
 * godrays.frag's own doc on the fix). This only proves the WIRING reaches the
 * shader; the clip's own geometry has no independent ground truth short of
 * re-deriving the shader's ray-plane intersection, so it is not re-pinned here.
 */
test('the march\'s own sea-level uniform tracks the live water plane', async ({ page }) => {
  await boot(page)
  const r = await page.evaluate(async () => {
    const { water, godrays } = window.__d
    window.__d.markDirty()
    await new Promise(res => requestAnimationFrame(() => setTimeout(res, 12)))
    return {
      waterSea: water.getSeaLevel(),
      uniform:  godrays._marchMaterial.uniforms.uSeaLevel.value,
    }
  })
  expect(r.uniform).toBeCloseTo(r.waterSea, 5)
})

/**
 * The weather gate. Shafts are a heavy-overcast sight — they need a deck thick
 * enough to darken the land and a break in it for the light through — so below
 * the onset there are none AT ALL, and the pass is switched off rather than
 * marched and multiplied by zero. Above it they come up to strength with the
 * cloud, so the effect arrives with the weather rather than snapping on.
 */
test('no shafts below the overcast onset, and none of the cost either', async ({ page }) => {
  await boot(page)
  const at = async overcast => {
    await setWeather(page, overcast)
    return page.evaluate(async () => {
      // Frames, so the render loop has pushed this overcast into the gate. It is
      // pushed from the loop rather than from the setter because the weather
      // walks on its own, and a scene holding still still has to notice.
      const tick = () => new Promise(r => { window.__d.markDirty(); requestAnimationFrame(() => setTimeout(r, 16)) })
      for (let i = 0; i < 10; i++) await tick()
      const g = window.__d.godrays
      const before = g.marchCount
      for (let i = 0; i < 6; i++) await tick()
      return { gate: g.getWeatherGate(), passOn: g.pass.enabled, marched: g.marchCount > before }
    })
  }
  const onset = await page.evaluate(() => window.__d.godrays.params.get('gateOnset'))

  const clear = await at(0)
  expect(clear.gate).toBe(0)
  expect(clear.passOn).toBe(false)
  expect(clear.marched).toBe(false)

  // Exactly AT the onset is still nothing — the ramp starts there, it does not
  // step there.
  expect((await at(onset)).gate).toBe(0)

  // ...and it is monotone from there to a fully grey sky, which is what makes
  // the shafts fade in with the cloud rather than appear fully formed.
  const mid  = await at(onset + (1 - onset) * 0.5)
  const full = await at(1)
  expect(mid.gate).toBeGreaterThan(0)
  expect(full.gate).toBeGreaterThan(mid.gate)
  expect(full.gate).toBeCloseTo(1, 5)
  expect(full.passOn).toBe(true)
})

test('the beams lean toward the sun, which is off the right of the frame', async ({ page }) => {
  // The sun sits 62.8 degrees off the view axis with its horizontal part toward
  // +x, i.e. off frame to the right of a 36.4 degree horizontal half-FOV. The
  // Henyey-Greenstein phase is what carries that: it cannot change the
  // lit/shadowed contrast at a pixel, but it varies across the frame with the
  // view ray, which is the bright-side glare that makes the effect read as light
  // rather than as fog. At the shipped g = 0.44 the sunward and anti-sunward
  // frame edges differ by about 2.9x.
  await boot(page)
  await setWeather(page, 1)
  // The claim is about the phase, not where the weather map happens to open the
  // deck: without its bias no patch of the frame's right side is closed off.
  await page.evaluate(() => {
    window.__d.clouds.params.set('weatherStrength', 0)
    // The shafts read the whole column's depth, which is deeper than the shipped
    // absorption lets a gap through: lower it so the frame has shafts to compare.
    window.__d.godrays.params.set('absorption', 0.15)
    // A closed deck leaves no gap in the whole column's depth, and the gate is
    // open at overcast 1: thin the cloud so there are gaps for shafts to fill, and enough that an opaque cloud does not cover them.
    window.__d.clouds.params.set('coverage', 1.2)
    window.__d.clouds.snapEases()
  })
  await page.evaluate(() => window.__d.godrays.params.set('enabled', true))
  const on = await settle(page)
  await page.evaluate(() => window.__d.godrays.params.set('enabled', false))
  const off = await settle(page)

  const gainLeft  = meanOver(on, 0, 0.3)  - meanOver(off, 0, 0.3)
  const gainRight = meanOver(on, 0.7, 1)  - meanOver(off, 0.7, 1)
  expect(gainRight).toBeGreaterThan(gainLeft)
})

test('the near cutoff takes light out of the frame, and does it smoothly', async ({ page }) => {
  // The air immediately in front of the lens subtends most of the picture and is
  // also where the extinction weighting puts the most weight, so light collected
  // there arrives as a flat veil rather than as a beam with a shape. Pushing the
  // cutoff out must therefore REMOVE brightness — an ordering, not a threshold,
  // so it survives any retune of the shafts themselves.
  await boot(page)
  await setWeather(page, 1)
  const meanAt = async nearFade => {
    await page.evaluate(v => {
      const g = window.__d.godrays
      g.params.set('enabled', true); g.params.set('nearFade', v)
    }, nearFade)
    return frameMean(await settle(page))
  }
  const none = await meanAt(0)
  const far  = await meanAt(400)
  expect(far).toBeLessThan(none)
})

test('it stops marching while the world holds still', async ({ page }) => {
  // A pass that re-marched every frame under a finished painting would burn
  // exactly the budget the cloud volume's static gate exists to save, and
  // nothing else in the suite would notice — the picture would look right.
  //
  // Driven through render() directly rather than by holding the real scene
  // still: main.js pushes worldHolding into setSceneStatic every frame, so a
  // test that set the flag and then waited would have it overwritten before the
  // next march. This asserts the gate itself, which is the part that can break.
  await boot(page)
  const counts = await page.evaluate(() => {
    const { godrays, renderer, camera } = window.__d
    godrays.params.set('enabled', true)
    // Open the weather gate by hand. Below the overcast onset the pass is off
    // outright, which is a different (and also correct) reason not to march —
    // this test is about the static gate, so the weather one must not stand in
    // for it. The render loop pushes the real overcast back next frame; nothing
    // here waits for one.
    godrays.setOvercast(1)
    godrays.setSceneStatic(false)
    godrays.markDirty()
    const start = godrays.marchCount
    for (let i = 0; i < 5; i++) godrays.render(renderer, camera)
    const moving = godrays.marchCount - start

    godrays.setSceneStatic(true)
    godrays.markDirty()
    godrays.render(renderer, camera)          // the one dirty frame is allowed
    const afterDirty = godrays.marchCount
    for (let i = 0; i < 10; i++) godrays.render(renderer, camera)
    return { moving, held: godrays.marchCount - afterDirty }
  })
  expect(counts.moving).toBe(5)
  expect(counts.held).toBe(0)
})

test('it survives a snapshot round trip', async ({ page }) => {
  await boot(page)
  await page.evaluate(() => {
    const g = window.__d.godrays
    g.params.set('enabled', true); g.params.set('intensity', 2.75); g.params.set('tiers', 5); g.params.set('aniso', 0.42)
  })
  const snap = await page.evaluate(() => window.__d.captureSnapshot())
  await page.evaluate(() => {
    const g = window.__d.godrays
    g.params.set('enabled', false); g.params.set('intensity', 0.1); g.params.set('tiers', 2); g.params.set('aniso', 0.9)
  })
  const report = await page.evaluate(s => window.__d.applySnapshot(s), snap)
  expect(report.unknown).toEqual([])

  const back = await page.evaluate(() => {
    const g = window.__d.godrays
    return { enabled: g.params.get('enabled'), intensity: g.params.get('intensity'), tiers: g.params.get('tiers'), aniso: g.params.get('aniso') }
  })
  expect(back).toEqual({ enabled: true, intensity: 2.75, tiers: 5, aniso: 0.42 })
})
