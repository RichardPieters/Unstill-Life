/**
 * atmosphere.spec.js — the weather (atmosphere.js) ↔ the real terrain, water
 * and scene background, wired in main.js through weatherDriver.js's
 * applyWeather.
 *
 * The unit tests already cover the walk and the clear→heavy curves in isolation.
 * What only the real app can prove is the half that lives in the wiring: that
 * the captured CLEAR end is the live scene rather than a second set of defaults,
 * that both materials' copies of the shared fog uniform move together, that
 * switching the weather off is an exact restore, and — the one that matters —
 * that any of this reaches the pixels at all.
 *
 * Removing the Atmosphere's `apply` / `live` wiring in main.js, or
 * `controls.bindAtmosphere`, fails these; passing unit tests would not notice.
 */
import { test, expect } from '@playwright/test'
import { boot, canvasPixelStats, screenshotPixels, waitFrames } from './helpers.js'

/** How many of the sampled pixels differ between two frames, out of how many. */
function changedFraction(a, b) {
  let changed = 0, total = 0
  for (let i = 0; i < a.length; i += 4) {
    total++
    if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) changed++
  }
  return changed / total
}

/** Every uniform the weather drives, read straight off the live materials. */
async function readDriven(page) {
  return page.evaluate(() => {
    const { terrain, water, sky, clouds, artPass } = window.__d
    const tu = terrain._material.uniforms, wu = water._material.uniforms
    return {
      shadowValue: terrain.params.get('shadowValue'),
      lightLevelTerrain: tu.uLightLevel.value,
      lightLevelWater:   wu.uLightLevel.value,
      glow:        terrain.params.get('glow'),
      shadowHueAmt:terrain.params.get('shadowHueAmt'),
      aerialDesat: terrain.params.get('aerialDesat'),
      fogCurveTerrain: tu.uFogCurve.value,
      fogCurveWater:   wu.uFogCurve.value,
      fogMaxAlpha: tu.uFogMaxAlpha.value,
      fogNear:     tu.uFogNear.value,
      cloudCoverage: clouds.params.get('coverage'),
      cloudGrey:   clouds.params.get('weatherGrey'),
      cloudSky:    parseInt(clouds.params.get('weatherSky').slice(1), 16),
      specAmt:     water.params.get('specAmt'),
      reflectAmt:  water.params.get('reflectAmt'),
      skyHex: sky.params.get('horizonHex'),
      artSky: artPass.params.get('colSky'),
      artGround: artPass.params.get('groundColor'),
    }
  })
}

/** Everything that holds a copy of the aerial-ramp range. */
async function readFogRange(page) {
  return page.evaluate(() => {
    const { terrain, water, scene, artPass } = window.__d
    return {
      terrain: terrain._material.uniforms.uFogNear.value,
      water:   water._material.uniforms.uFogNear.value,
      sceneFog: scene.fog.near,
      artPass: artPass._sceneUniforms.uFogNear.value,
    }
  })
}

/**
 * Put the weather in its CLEAR corner and stop it drifting.
 *
 * The master defaults on and walking, so a bare boot() leaves every
 * driven uniform at whatever the opening overcast/haze happen to blend to —
 * which is not the clear-weather value any of these cases mean when they say
 * "clear". Pinning both scalars to 0 with the master still ON makes `readDriven`
 * return the clear end exactly, by the clear/heavy contract rather than by luck.
 */
async function settleClear(page) {
  await page.evaluate(() => {
    const a = window.__d.atmosphere
    a.params.set('walking', false)
    a.params.set('enabled', true)
    a.setChannel('overcast', 0)
    a.setChannel('haze', 0)
  })
}

test('with the master off, a full run of ticks leaves every driven uniform untouched', async ({ page }) => {
  // The master defaults ON — the shipped clear-weather cloud amount is an
  // empty sky, so the weather is the shipped picture rather than an addition
  // to it. This case turns it OFF first: while the master is down, the walk
  // must not reach a single uniform however long it runs.
  const errors = await boot(page)
  await page.evaluate(() => window.__d.atmosphere.params.set('enabled', false))
  expect(await page.evaluate(() => window.__d.atmosphere.params.get('enabled'))).toBe(false)
  const before = await readDriven(page)

  // The walk is paced by noiseSpeed, so drive real ticks rather than waiting.
  await page.evaluate(() => {
    for (let i = 0; i < 1200; i++) window.__d.dynamics.update(1 / 60, 0.5)
  })
  expect(await readDriven(page)).toEqual(before)
  expect(errors).toEqual([])
})

test('the master defaults on', async ({ page }) => {
  await boot(page)
  expect(await page.evaluate(() => window.__d.atmosphere.params.get('enabled'))).toBe(true)
})

test('full overcast lifts the shadow floor and kills alpenglow, and leaves the distance alone', async ({ page }) => {
  await boot(page)
  await settleClear(page)
  const clear = await readDriven(page)

  await page.evaluate(() => {
    const a = window.__d.atmosphere
    a.params.set('walking', false)             // hand-drive, so the assertion is about the curve
    a.params.set('enabled', true)
    a.setChannel('overcast', 1)
    a.setChannel('haze', 0)
  })
  const heavy = await readDriven(page)

  // The load-bearing direction: the DARK end rises toward the lit colour, i.e.
  // the tonal range COMPRESSES. That is a statement about contrast only — how
  // much light is arriving is uLightLevel's axis, and it moves the other way;
  // see the light-level case further down.
  expect(heavy.shadowValue).toBeGreaterThan(clear.shadowValue)
  expect(heavy.glow).toBeLessThan(clear.glow)
  // haze held at 0, so the distance uniforms must not have moved with overcast.
  expect(heavy.aerialDesat).toBeCloseTo(clear.aerialDesat, 6)
  expect(heavy.fogCurveTerrain).toBeCloseTo(clear.fogCurveTerrain, 6)
})

test('full haze thickens the distance, and moves BOTH materials copies of the fog curve', async ({ page }) => {
  await boot(page)
  const clear = await readDriven(page)
  // The two are supposed to be identical to begin with — water.frag says so in
  // as many words. If they have already drifted, the assertion below is moot.
  expect(clear.fogCurveWater).toBeCloseTo(clear.fogCurveTerrain, 6)

  await page.evaluate(() => {
    const a = window.__d.atmosphere
    a.params.set('walking', false)
    a.params.set('enabled', true)
    a.setChannel('overcast', 0)
    a.setChannel('haze', 1)
  })
  const heavy = await readDriven(page)

  expect(heavy.aerialDesat).toBeGreaterThan(clear.aerialDesat)
  // Driving only one leaves a visible seam along the waterline. This is the
  // invariant the test is named for and the one that cannot be tuned away.
  expect(heavy.fogCurveWater).toBeCloseTo(heavy.fogCurveTerrain, 6)

  // Deliberately no direction assertion on uFogCurve itself. The ramp is
  // pow(t, uFogCurve), so a SMALLER exponent means more haze at a fixed
  // distance, but which of the two haze levers carries the heavy end is a
  // tuning choice: the shipped one puts nearly all of it in uFogNear (400 -> 0)
  // while leaving the curve a shade above its clear value as a counter-shape on
  // the near field. Asserting the curve's direction here would pin that choice.
  // What must hold is that the DISTANCE gets hazier, and that is asserted where
  // it can only be true or false: on the pixels, in the last case in this file.
})

/**
 * Shadow greying. uShadowHueAmt is the lever that makes shadows read as grey
 * under overcast: desaturation is a proportion, and a near-black base (the
 * clear shadow floor, 0.05) has no chroma left to drain, so uShadowDesat stays
 * at the Colour tab's constant.
 */
test('overcast drives the shadow hue amount that actually greys shadows', async ({ page }) => {
  await boot(page)
  const clear = await readDriven(page)

  await page.evaluate(() => {
    const a = window.__d.atmosphere
    a.params.set('walking', false); a.params.set('enabled', true)
    a.setChannel('haze', 0); a.setChannel('overcast', 1)
  })
  const heavy = await readDriven(page)

  // The shipped tuning RAISES the hue amount (0.07 -> 0.4) rather than
  // draining it to 0 — a shadow with no chroma at all under a cel ladder
  // reads as a rendering fault rather than as weather (see the shadowHueAmt
  // row in atmosphereParams.js). Only that the weather reaches it at all is
  // load-bearing.
  expect(heavy.shadowHueAmt).not.toBeCloseTo(clear.shadowHueAmt, 6)
})

/**
 * Haze reaching a fixed distance and stopping. `t` is
 * clamp((depth - uFogNear)/(uFogFar - uFogNear), 0, 1), so it saturates at
 * uFogFar and every fragment past it is hazed identically — a curve-only haze
 * runs out of gradient and leaves the far half of the scene one flat tone with a
 * visible edge. Heavy haze pulls the START in and lets the ceiling close.
 */
test('haze pulls its start toward the camera and closes at the far end', async ({ page }) => {
  await boot(page)
  const clear = await readDriven(page)

  await page.evaluate(() => {
    const a = window.__d.atmosphere
    a.params.set('walking', false); a.params.set('enabled', true)
    a.setChannel('overcast', 0); a.setChannel('haze', 1)
  })
  const heavy = await readDriven(page)

  expect(heavy.fogNear).toBeLessThan(clear.fogNear)
  // Below 1 the farthest ground never fully becomes sky, which is a permanent
  // seam along the horizon rather than a gradient that finishes.
  expect(heavy.fogMaxAlpha).toBeGreaterThan(clear.fogMaxAlpha)

  // All four copies of the range move together. Terrain and water seam along the
  // waterline if they disagree; scene.fog fogs everything that is not a
  // ShaderMaterial; artPass normalises the depth it paints from by this range.
  const range = await readFogRange(page)
  for (const k of Object.keys(range)) expect(range[k]).toBeCloseTo(heavy.fogNear, 3)
})

test('overcast reaches the clouds: more of them, coloured by the sky they sit in', async ({ page }) => {
  await boot(page)
  const clear = await readDriven(page)
  const clearAlpha = await page.evaluate(async () => {
    const { clouds, renderer, camera } = window.__d
    for (let i = 0; i < 40; i++) { clouds.update(camera, 0); clouds.renderClouds(renderer) }
    return window.__cloudRead.alpha(0.45)
  })

  await page.evaluate(() => {
    const a = window.__d.atmosphere
    a.params.set('walking', false); a.params.set('enabled', true)
    a.setChannel('haze', 0); a.setChannel('overcast', 1)
  })
  const heavy = await readDriven(page)

  // MEASURED, not inferred from the uniform moving: a driven parameter can
  // change while the sky gets measurably CLEARER (uWeatherStrength, for one,
  // scales a zero-mean field and nets a loss of cloud as it rises). A
  // parameter moving is not the claim; the sky getting cloudier is.
  const alpha = await page.evaluate(async () => {
    const { clouds, renderer, camera } = window.__d
    // The light volume refreshes one layer per frame, so a coverage change
    // needs LAYERS frames to propagate before the readback means anything.
    for (let i = 0; i < 40; i++) { clouds.update(camera, 0); clouds.renderClouds(renderer) }
    return window.__cloudRead.alpha(0.45)
  })
  expect(alpha, `mean cloud alpha at full overcast = ${alpha.toFixed(4)}`).toBeGreaterThan(clearAlpha * 1.3)
  // uCoverage is a threshold subtracted from density, so more cloud means a
  // LOWER number. Stated here because the direction is genuinely inverted.
  expect(heavy.cloudCoverage).toBeLessThan(clear.cloudCoverage)
  expect(heavy.cloudGrey).toBeGreaterThan(clear.cloudGrey)
  // cloudShade.glsl's two colour gradients are functions of sun height alone, so
  // the sky colour has to be pushed to them explicitly or an overcast lid is
  // drawn in clear-day cumulus colours.
  expect(heavy.cloudSky).toBe(heavy.skyHex)
})

test('overcast reaches the water: the sun glint goes out with the sun', async ({ page }) => {
  await boot(page)
  const clear = await readDriven(page)

  await page.evaluate(() => {
    const a = window.__d.atmosphere
    a.params.set('walking', false); a.params.set('enabled', true)
    a.setChannel('haze', 0); a.setChannel('overcast', 1)
  })
  const heavy = await readDriven(page)
  // The glint is the sun's own disc breaking up on the ripples. No disc, no
  // glint — this is the one that has to hold, and it is the most immediately
  // readable weather cue the water has.
  expect(heavy.specAmt).toBeLessThan(clear.specAmt)
  // The MIRROR is not asserted downward, and the direction is worth writing
  // down because it looks like it should follow the glint. It does not: with
  // the disc gone, a broad diffuse reflection of the sky is most of what is
  // left on the surface, so the shipped heavy end takes it UP rather than down.
  // What must hold is only that the weather reaches it at all.
  expect(heavy.reflectAmt).not.toBeCloseTo(clear.reflectAmt, 6)
})

/**
 * The app boots with a thin cloud dial (density 0.26), and the
 * weather scales every LIGHT term by the density effect (<1 below density 0.5).
 * Specs asserting "full overcast reaches the authored heavy end" need a solid
 * sky, so they raise the dial first, the way a user dragging it would.
 */
async function solidCloud(page) {
  await page.evaluate(() => window.__d.clouds.params.set('absorption', 0.005 + 0.9 * (0.075 - 0.005)))
}

test('the painting does not appear under a sky from before the weather', async ({ page }) => {
  await boot(page)
  await solidCloud(page)
  const before = await readDriven(page)
  await page.evaluate(() => {
    const a = window.__d.atmosphere
    a.params.set('walking', false); a.params.set('enabled', true)
    // Haze explicitly to 0: it lays a second blend toward the haze colour on
    // top of the overcast one, so with both up the destination is neither end.
    a.setChannel('haze', 0)
    a.setChannel('overcast', 1)
  })
  const { artSky } = await readDriven(page)
  // artPass keeps its OWN copy of the sky, for the ground and the aerial-fog
  // target it paints from. The freeze IS the terminal state, so a stale copy is
  // the sky the piece parks under. At full overcast it must have arrived at the
  // heavy sky — the same destination the scene's own sky travels to, though it
  // starts from its own authored colour rather than the palette horizon.
  const heavySky = await page.evaluate(() => window.__d.atmosphere.params.get('heavy.skyHex'))
  expect(artSky.toLowerCase()).toBe(heavySky)
  // ...and it was NOT already there before the weather ran, or this proves nothing.
  expect(artSky.toLowerCase()).not.toBe(before.artSky.toLowerCase())
})

test('the clear end is captured from the live scene, not from a second set of defaults', async ({ page }) => {
  await boot(page)
  // The master defaults ON, so getting at the capture EDGE means switching it
  // off first — which is also the honest way to reach this: the scene is only
  // free to be moved by hand while the weather is not writing it.
  await page.evaluate(() => {
    window.__d.atmosphere.params.set('walking', false)
    window.__d.atmosphere.params.set('enabled', false)
    // Somewhere no default would be.
    window.__d.terrain.params.set('glow', 0.77)
  })

  await page.evaluate(() => {
    const a = window.__d.atmosphere
    a.params.set('enabled', true)
    a.setChannel('overcast', 0)     // clear weather must reproduce what it found
  })
  expect((await readDriven(page)).glow).toBeCloseTo(0.77, 6)
})

test('switching the weather off restores the captured values exactly', async ({ page }) => {
  await boot(page)
  await settleClear(page)
  const clear = await readDriven(page)

  await page.evaluate(() => {
    const a = window.__d.atmosphere
    a.params.set('walking', false)
    a.params.set('enabled', true)
    a.setChannel('overcast', 0.8)
    a.setChannel('haze', 0.9)
  })
  const heavy = await readDriven(page)
  expect(heavy.shadowValue).not.toBeCloseTo(clear.shadowValue, 3)

  await page.evaluate(() => window.__d.atmosphere.params.set('enabled', false))
  // Exact, not approximate — the whole point of capturing rather than
  // re-deriving is that switching the feature off is a restore.
  expect(await readDriven(page)).toEqual(clear)
})

/**
 * Overcast ALONE, with haze held at 0 — the axes are separated on purpose.
 * Haze melts the far distance into the sky colour, so a combined run measures
 * the sky swatch as much as it measures the light, and "did overcast darken the
 * frame" stops being answerable: a combined run can pass the shadow-floor
 * assertions while the frame's luminance drop comes from the sky colour, not
 * from the light model.
 */
/** Mean of R+G+B over a horizontal band, rows given as fractions of height. */
function bandMean(px, size, y0, y1) {
  let sum = 0, n = 0
  for (let y = Math.floor(size * y0); y < Math.floor(size * y1); y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      sum += px[i] + px[i + 1] + px[i + 2]
      n += 3
    }
  }
  return sum / n
}

test('overcast reaches the pixels: the LAND darkens and the sky does not', async ({ page }) => {
  await boot(page)
  await page.evaluate(() => window.__d.markDirty())
  await waitFrames(page, 3)
  const clearPx = await screenshotPixels(page, 128)

  await page.evaluate(() => {
    const a = window.__d.atmosphere
    a.params.set('walking', false)
    a.params.set('enabled', true)
    a.setChannel('haze', 0)
    a.setChannel('overcast', 1)
    window.__d.markDirty()
  })
  await waitFrames(page, 3)
  const greyPx = await screenshotPixels(page, 128)

  // It changed the image at all. Without this every other assertion in this
  // file is just uniforms moving behind a picture that never redrew. Counted as
  // CHANGED PIXELS rather than as a mean delta, so the threshold does not
  // encode any particular amount of change.
  expect(changedFraction(clearPx, greyPx)).toBeGreaterThan(0.5)

  // The load-bearing claim, and the reason this test exists in this shape.
  //
  // Flat cloud light is bright at the LID and dim on the GROUND. Clear sun puts
  // on the order of 100 klx on the ground against a solid deck's 1-20, while the sky's
  // own luminance barely moves, so the land/sky ratio drops and the land reads
  // dark against glare. uLightLevel is the term that does it, and it is applied
  // before the aerial melt precisely so the sky is left out.
  //
  // Asserted as the RATIO of two bands rather than as either band's absolute
  // value, so it survives any retune of how far either end goes: what must hold
  // is that the land loses more than the sky does.
  const land = px => bandMean(px, 128, 0.6, 1)
  const sky  = px => bandMean(px, 128, 0, 0.25)
  expect(land(greyPx)).toBeLessThan(land(clearPx))
  expect(land(greyPx) / sky(greyPx)).toBeLessThan(land(clearPx) / sky(clearPx))

  // NOTE: no assertion on whole-frame VARIANCE here, deliberately. It looks like
  // the natural way to measure "the contrast compresses", and it is the wrong
  // instrument for this axis: measured per term, lifting the shadow floor takes
  // variance 4229 -> 4049 while dropping alpenglow takes it 4229 -> 4617 (snow
  // goes pure white against dark rock), so the two very nearly cancel and the
  // combined figure is a coin flip that would flake on any retune. The haze case
  // below does assert it, because there the whole mechanism IS pulling the frame
  // toward one colour.
})

test('the light level is a separate axis from the shadow floor, on both materials', async ({ page }) => {
  await boot(page)
  await settleClear(page)
  const clear = await readDriven(page)
  // Terrain and water share a shoreline; a light level they disagreed about
  // would seam along it, the same failure uFogCurve has to avoid.
  expect(clear.lightLevelWater).toBeCloseTo(clear.lightLevelTerrain, 6)

  await page.evaluate(() => {
    const a = window.__d.atmosphere
    a.params.set('walking', false); a.params.set('enabled', true); a.setChannel('haze', 0); a.setChannel('overcast', 1)
  })
  const grey = await readDriven(page)
  // The two move in OPPOSITE directions, which is what makes them two axes and
  // not one: the floor rises (contrast compresses toward the lit end) while the
  // level falls (less light arrives in the first place).
  expect(grey.shadowValue).toBeGreaterThan(clear.shadowValue)
  expect(grey.lightLevelTerrain).toBeLessThan(clear.lightLevelTerrain)
  expect(grey.lightLevelWater).toBeCloseTo(grey.lightLevelTerrain, 6)

  await page.evaluate(() => window.__d.atmosphere.params.set('enabled', false))
  expect(await readDriven(page)).toEqual(clear)
})

/**
 * The cause/effect split, in the real app.
 *
 * uCoverage is linear in the scalar, but the sky FILL it produces is a tail
 * integral and so strongly convex: measured mean cloud alpha over the shipped
 * ends runs 0.012 of its range at overcast 0.2 and 0.040 at 0.3. Light terms
 * blended linearly against that would put a fifth of a grey day's light under
 * a sky one part in eighty covered, so they wait for the light's onset.
 */
test('low overcast gathers cloud without touching the light', async ({ page }) => {
  await boot(page)
  await solidCloud(page)
  await settleClear(page)
  const clear = await readDriven(page)

  await page.evaluate(() => window.__d.atmosphere.setChannel('overcast', 0.2))
  const low = await readDriven(page)

  // The CAUSE has moved — cloud amount is linear in the scalar and must not be
  // delayed, or the sky would never start filling either.
  expect(low.cloudCoverage).not.toBeCloseTo(clear.cloudCoverage, 3)

  // The EFFECTS have not. Every one of them, so a term added to the light group
  // without being shaped fails here instead of silently putting the light
  // ahead of the cloud.
  for (const key of ['shadowValue', 'lightLevelTerrain', 'lightLevelWater',
                     'glow', 'shadowHueAmt', 'specAmt', 'reflectAmt']) {
    expect(low[key], `${key} should still be its clear-weather value at overcast 0.2`)
      .toBeCloseTo(clear[key], 6)
  }
  expect(low.skyHex).toBe(clear.skyHex)

  // And the delay is a delay, not a disconnection: by full overcast every one
  // of them has arrived at its authored heavy end.
  await page.evaluate(() => window.__d.atmosphere.setChannel('overcast', 1))
  const high = await readDriven(page)
  const heavy = await page.evaluate(() => {
    const a = window.__d.atmosphere
    return { shadowValue: a.params.get('heavy.shadowValue'), lightLevel: a.params.get('heavy.lightLevel'),
             glow: a.params.get('heavy.glow'), specAmt: a.params.get('heavy.specAmt') }
  })
  expect(high.shadowValue).toBeCloseTo(heavy.shadowValue, 6)
  expect(high.lightLevelTerrain).toBeCloseTo(heavy.lightLevel, 6)
  expect(high.glow).toBeCloseTo(heavy.glow, 6)
  expect(high.specAmt).toBeCloseTo(heavy.specAmt, 6)
})

test('the painted canvas dims with the land, and the painted sky does not', async ({ page }) => {
  await boot(page)
  await settleClear(page)
  const clear = await readDriven(page)
  const lum = hex => {
    const v = parseInt(hex.slice(1), 16)
    return 0.299 * ((v >> 16) & 0xff) + 0.587 * ((v >> 8) & 0xff) + 0.114 * (v & 0xff)
  }

  // Clear weather must return the AUTHORED canvas colour byte for byte. The
  // ground is driven as authored * (level / clear level), and the shipped clear
  // level is 1.11 rather than 1 — a hard-coded denominator would quietly darken
  // the painting by a tenth on a sunny day, and only this catches that.
  await page.evaluate(() => {
    const a = window.__d.atmosphere
    a.params.set('walking', false); a.params.set('enabled', true); a.setChannel('haze', 0); a.setChannel('overcast', 0)
  })
  expect((await readDriven(page)).artGround.toLowerCase()).toBe(clear.artGround.toLowerCase())

  await page.evaluate(() => window.__d.atmosphere.setChannel('overcast', 1))
  const grey = await readDriven(page)

  // The canvas is a flat stand-in for lit ground, so it goes down with the
  // light level — the painting is a picture of a grey day, not a sunny picture
  // hung in one.
  expect(lum(grey.artGround)).toBeLessThan(lum(clear.artGround))
  // The painted SKY is excluded from that dimming for the same reason
  // terrain.frag applies uLightLevel before the aerial block: the lid stays
  // bright while the ground darkens against it. It still moves — it travels to
  // the heavy sky — but it must not be dragged down by the light level too.
  expect(lum(grey.artSky)).toBeGreaterThan(lum(grey.artGround))

  await page.evaluate(() => window.__d.atmosphere.params.set('enabled', false))
  expect((await readDriven(page)).artGround.toLowerCase()).toBe(clear.artGround.toLowerCase())
})

test('haze whitens the sky it dissolves the distance into', async ({ page }) => {
  await boot(page)
  const chroma = hex => {
    const r = (hex >> 16) & 0xff, g = (hex >> 8) & 0xff, b = hex & 0xff
    return Math.max(r, g, b) - Math.min(r, g, b)
  }
  const readSky = () => page.evaluate(() => window.__d.sky.params.get('horizonHex'))

  await page.evaluate(() => {
    const a = window.__d.atmosphere
    a.params.set('walking', false); a.params.set('enabled', true); a.setChannel('overcast', 0); a.setChannel('haze', 0)
  })
  const clearSky = await readSky()
  await page.evaluate(() => window.__d.atmosphere.setChannel('haze', 1))
  const hazySky = await readSky()

  // Aerial perspective melts distance into the SKY colour, so at full haze the
  // far ground is that colour exactly and nothing else decides what heavy haze
  // looks like. A clear sky is blue because air molecules scatter short
  // wavelengths far harder; haze is aerosol, which scatters all of them about
  // equally, so it goes milky white. Without a haze colour of its own, full
  // haze under a clear sky would dissolve the ridges into saturated blue.
  //
  // Two directions, both stated as directions: less colour, and not less light
  // (airlight ADDS radiance along the path, so a haze that merely desaturated
  // at constant value would read as grime rather than as air).
  expect(chroma(hazySky)).toBeLessThan(chroma(clearSky))
  const luma = hex => 0.299 * ((hex >> 16) & 0xff) + 0.587 * ((hex >> 8) & 0xff) + 0.114 * (hex & 0xff)
  expect(luma(hazySky)).toBeGreaterThan(luma(clearSky))
})

/**
 * The snapshot path, end to end in the real app. Every other case here
 * enables and disables inside one page
 * session, where clear is correct by construction; only a capture→restore with
 * the weather UP catches a clear that did not survive the round trip.
 */
test('a snapshot taken with the weather up restores the same scene, and can still clear', async ({ page }) => {
  await boot(page)
  await settleClear(page)
  const clear = await readDriven(page)

  const snap = await page.evaluate(() => {
    const a = window.__d.atmosphere
    a.params.set('walking', false)
    a.params.set('enabled', true)
    a.setChannel('overcast', 0.8)
    a.setChannel('haze', 0.5)
    return window.__d.captureSnapshot()
  })
  const driven = await readDriven(page)

  // Move the scene somewhere else entirely, then restore.
  await page.evaluate(() => {
    const a = window.__d.atmosphere
    a.setChannel('overcast', 0.1)
    a.setChannel('haze', 0.9)
  })
  const report = await page.evaluate(s => window.__d.applySnapshot(s), snap)
  expect(report.unknown).toEqual([])

  // Back to the captured picture — not the weather applied a second time on top
  // of the uniforms the snapshot had already restored.
  const restored = await readDriven(page)
  for (const k of Object.keys(driven)) {
    // artSky is a hex STRING, the rest are numbers — compare each in its own kind.
    if (typeof driven[k] === 'string') expect(restored[k]).toBe(driven[k])
    else expect(restored[k]).toBeCloseTo(driven[k], 4)
  }

  // And the way home still works: the restored clear is the original clear day,
  // not the driven look promoted into one.
  await page.evaluate(() => window.__d.atmosphere.params.set('enabled', false))
  expect(await readDriven(page)).toEqual(clear)
})

test('haze reaches the pixels: the distance loses its separation from the sky', async ({ page }) => {
  await boot(page)
  await page.evaluate(() => window.__d.markDirty())
  await waitFrames(page, 3)
  const clear = await canvasPixelStats(page)

  await page.evaluate(() => {
    const a = window.__d.atmosphere
    a.params.set('walking', false)
    a.params.set('enabled', true)
    a.setChannel('overcast', 0)
    a.setChannel('haze', 1)
    window.__d.markDirty()
  })
  await waitFrames(page, 3)
  const hazy = await canvasPixelStats(page)

  // Aerial perspective pulls far ground toward one colour, so the spread across
  // the frame narrows. Stated as a direction, not a threshold, so a retune of
  // either end does not turn this red.
  expect(hazy.variance).toBeLessThan(clear.variance)
})
