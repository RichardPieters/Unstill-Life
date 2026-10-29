/**
 * shading.spec.js — the tonal-variety guard. Debug view 0 = the real shaded
 * material colour. These catch a dead-diffuse failure, where the whole scene
 * collapses to one tone because the N·L transfer window is wrong.
 *
 * Non-ossifying: assert a LOOSE bucket count and a directional response, never
 * a specific luminance or the cel-step count.
 */
import { test, expect } from '@playwright/test'
import { bootSignal, probeGrid, meanScalar } from './probe.js'
import { gaussianDome, tiltedPlane } from './fixtures.js'

const lum = ([r, g, b]) => 0.299 * r + 0.587 * g + 0.114 * b
// material view; fog off so distance haze doesn't flatten the read; sea low.
const CTRL = { heightMax: 200, uniforms: { uSeaLevel: -400, uEnableFog: false } }

test.beforeEach(async ({ page }) => { await bootSignal(page) })

test('scene has tonal variety (>= 4 luminance buckets on a dome)', async ({ page }) => {
  // Steep dome: spans several biome bands AND a wide N·L range, so a healthy
  // scene clears 4 buckets comfortably. Collapse (dead diffuse) → 1-2.
  const res = await probeGrid(page, { fixture: gaussianDome(200, 170), debugViewId: 0, controls: CTRL })
  const buckets = new Set(res.samples.map(s => Math.round(lum(s.v) * 16)))
  expect(buckets.size, `distinct luminance buckets = ${buckets.size}`).toBeGreaterThanOrEqual(4)
})

test('shading responds to sun elevation (single material, luminance shifts)', async ({ page }) => {
  // A gentle tilted plane — one material, so any luminance change is SHADING,
  // not a biome switch. Low sun vs high sun must differ.
  const fixture = tiltedPlane(18, 0, 0)
  const low = await probeGrid(page, {
    fixture, debugViewId: 0, controls: { ...CTRL, sunElevation: 0.15 },
  })
  const high = await probeGrid(page, {
    fixture, debugViewId: 0, controls: { ...CTRL, sunElevation: 1.5 },
  })
  const dLum = Math.abs(meanScalar({ samples: low.samples.map(s => ({ v: [lum(s.v)] })) })
                      - meanScalar({ samples: high.samples.map(s => ({ v: [lum(s.v)] })) }))
  expect(dLum, `luminance delta low→high sun = ${dLum.toFixed(4)}`).toBeGreaterThan(0.02)
})

/**
 * The shadow transfer's three axes must stay independent.
 *
 * material.glsl's toShadow derives a shadow from a lit colour by three
 * uniforms, each of which is meant to move exactly one thing: uShadowValue its
 * VALUE, uShadowDesat its CHROMA, uShadowHueAmt its HUE. That separation was
 * broken for as long as the function existed — the hue term was a colour scaled
 * by a brightness, so "how blue" also darkened, by 64% at a raised shadow floor,
 * and read as a second copy of the floor control.
 *
 * Asserted as a property (luminance is INVARIANT under the hue axis, hue is NOT)
 * rather than as numbers, so retuning any of the three keeps this green.
 */
test('shadow hue tints without darkening: the axes stay separate', async ({ page }) => {
  // A tilted plane away from the sun, one material: everything read here is the
  // shadow end of the transfer, not a biome change. The shadow floor is raised
  // well off its shipped 0.05 because at that value the shadow is near black and
  // NO colour axis is measurable in it — which is the second half of why the
  // control looked dead.
  const fixture = tiltedPlane(18, 0, 0)
  const at = hueAmt => probeGrid(page, {
    fixture, debugViewId: 0,
    controls: { ...CTRL, sunElevation: 0.15, uniforms: { ...CTRL.uniforms, uShadowValue: 0.75, uShadowHueAmt: hueAmt } },
  })
  const none = await at(0.0)
  const full = await at(1.0)

  const meanLum = r => meanScalar({ samples: r.samples.map(s => ({ v: [lum(s.v)] })) })
  // Blueness as blue-minus-red: independent of the shader's own formula, and
  // the thing the control claims to do.
  const meanBlue = r => meanScalar({ samples: r.samples.map(s => ({ v: [s.v[2] - s.v[0]] })) })

  const dLum  = Math.abs(meanLum(full) - meanLum(none))
  const dBlue = meanBlue(full) - meanBlue(none)

  expect(dBlue, `blueness delta over the hue axis = ${dBlue.toFixed(4)}`).toBeGreaterThan(0.05)
  // The invariant: the hue axis must not be a brightness axis in disguise. The
  // old formula moved luminance by ~0.33 here, an order of magnitude over this.
  expect(dLum, `luminance drift over the hue axis = ${dLum.toFixed(4)}`).toBeLessThan(0.05)
})
