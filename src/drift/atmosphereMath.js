/**
 * atmosphereMath.js — the pure arithmetic behind atmosphere.js: the overcast
 * window and every clear→heavy curve the weather drives. No THREE, no DOM, no
 * clock. weatherDriver.applyWeather writes what the curves return.
 *
 * Every driven parameter has a CLEAR value (the scene as tuned, captured when
 * the weather switches on) and a HEAVY value (authored). The scalar curves
 * return lerp(clear, heavy, weight), so weight 0 reproduces the clear look
 * exactly. colourCurves blends the colours (mixHex, scaleHex).
 */

import { clamp01 } from '../shared/mathUtils.js'
import { WEATHER_PARAMS } from './atmosphereParams.js'

/** Linear interpolation. `t` is NOT clamped — callers pass weights already in [0,1]. */
export function lerp(a, b, t) {
  return a + (b - a) * t
}

/**
 * The overcast window: the weight of the light's effects, delayed onto the cloud
 * that is actually in the sky.
 *
 *   w       the overcast scalar, [0,1]
 *   onset   below this the light is still a clear day's
 *   full    at and above this the light has reached its heavy end
 *
 * Cloud amount is not linear in the scalar (uCoverage is a threshold on a noise
 * field): measured mean cloud alpha is 0.012 at overcast 0.2, 0.24 at 0.5, 0.676
 * at 0.75 and 1.0 at 1. A linear light blend would give a fifth of a grey day's
 * light under almost no cloud, so the light starts at `onset`.
 *
 * Above the onset the measured curve is nearly straight, so the window is a
 * plain ramp. A smoothstep would invent a shoulder near 1 that the data lacks
 * and put the light ahead of the cloud. The ramp's slope step at `onset` is not
 * visible, since the scalar drifts at most 0.005 per second.
 *
 * f(0) = 0 whenever onset >= 0 and f(1) = 1 whenever full <= 1 (atmosphere.js
 * clamps both), so both tuned looks are still reached.
 *
 * Known limit: one curve serves direct-sun terms (shadow floor, light level,
 * glow, water glint), which follow the chance the sun is covered and saturate
 * earlier, and diffuse terms, which follow mean alpha. The sun-dependent half
 * runs slightly late.
 */
export function shapeOvercast(w, { onset = 0, full = 1 } = {}) {
  const x = clamp01(w)
  // Degenerate window: a hard step at `onset`. `!(full > onset)` also catches a
  // NaN window, which would otherwise put NaN into every driven uniform.
  if (!(full > onset)) return x < onset ? 0 : 1
  return clamp01((x - onset) / (full - onset))
}

/**
 * The overcast curves: what a grey lid does to the light.
 *
 * `shadowValue` carries the contrast. uShadowValue scales only the shadow end
 * of terrain.frag's final mix, so raising it lifts the dark endpoint toward the
 * lit colour: the lit end never moves and all uLightSteps cel bands survive,
 * closer together in tone. Widening uShadeLo/uShadeHi instead would collapse
 * bands and halve peak luminance.
 *
 * `lightLevel` is the other axis: it scales the shaded colour, moving both ends
 * of the tonal range. A grey day is darker on the ground and the sky falls far
 * less, so the land/sky ratio drops and the lid reads as glare above dark
 * ground; terrain.frag applies it before the aerial block to leave the sky out.
 * The ratio is a zenith argument (a CIE overcast horizon is a third of its
 * zenith, so the heavy sky sits below the clear one in luminance), and the drop
 * depends on the sun angle, which the weather does not know. Neither is modelled.
 *
 * `glow` (alpenglow on snow and rock) has no warm key light under cloud.
 *
 * `shadowHueAmt` is the blue-violet push in the shadows. Physically it should go
 * out under a deck; the shipped heavy end rises instead, an artistic choice
 * explained on the heavy rows in atmosphereParams.js.
 *
 * `cloudCoverage`, `cloudGrey`, `specAmt` and `reflectAmt` carry the axis to the
 * rest of the scene: more cloud, cloud colour pulled toward the sky, the water's
 * sun glint going out and its mirror rising.
 */
export function overcastCurves(clear, heavy, overcast, shape, effectScale = 1, haze = 0) {
  // Three weights.
  //   w          the light window (shapeOvercast with onset/full).
  //   e          w scaled by how solid the cloud is (effectScale, cloudDialsMath's
  //              densityToWeatherEffect); every light term rides it. Applied to the
  //              weight, so the clear end is still reached at any density.
  //   wCoverage  cloud amount's own weight: the raw scalar, no window, so cloud
  //              gathers from the bottom of the dial. Density does not change how
  //              much cloud there is.
  const raw = clamp01(overcast)
  const w = shapeOvercast(raw, shape)
  const e = w * clamp01(effectScale)
  const wCoverage = raw
  return {
    shadowValue: lerp(clear.shadowValue, heavy.shadowValue, e),
    lightLevel:  lerp(clear.lightLevel,  heavy.lightLevel,  e),
    glow:        lerp(clear.glow,        heavy.glow,        e),
    shadowHueAmt: lerp(clear.shadowHueAmt, heavy.shadowHueAmt, e),
    // Lower coverage means more cloud, so heavy sits below clear.
    cloudCoverage: lerp(clear.cloudCoverage, heavy.cloudCoverage, wCoverage),
    // Weight max(e, haze): cloudGrey pulls cloud colour toward the live,
    // haze-blended horizon, so haze alone must grey the clouds too, or sharp
    // cumulus would sit in front of a milky horizon. `max`, not a sum: haze
    // alone pulls toward milky white, not overcast's grey.
    cloudGrey:   lerp(clear.cloudGrey,   heavy.cloudGrey,   Math.max(e, clamp01(haze))),
    specAmt:     lerp(clear.specAmt,     heavy.specAmt,     e),
    reflectAmt:  lerp(clear.reflectAmt,  heavy.reflectAmt,  e),
  }
}

/**
 * The haze curves: what moisture does to the distance.
 *
 * `fogCurve` is the exponent of the aerial ramp (`pow(t, uFogCurve)`): lower
 * lifts the ramp and starts the haze closer, so raising it removes haze. The
 * heavy end sits slightly above clear on purpose and leaves the haze to fogNear.
 *
 * `aerialDesat` is how much distance washes hue toward grey before the melt into
 * the sky colour.
 *
 * `fogNear` is where the ramp starts. The ramp saturates at uFogFar, so steepening
 * the curve alone flattens the far half into one tone with a visible edge;
 * pulling fogNear toward the camera gives thick haze room to happen.
 *
 * `fogMaxAlpha` caps the ramp after the curve. At the clear 0.9 it leaves a seam
 * along the horizon, so it is driven toward 1 for full haze.
 */
export function hazeCurves(clear, heavy, haze) {
  const w = clamp01(haze)
  return {
    fogCurve:    lerp(clear.fogCurve,    heavy.fogCurve,    w),
    aerialDesat: lerp(clear.aerialDesat, heavy.aerialDesat, w),
    fogNear:     lerp(clear.fogNear,     heavy.fogNear,     w),
    fogMaxAlpha: lerp(clear.fogMaxAlpha, heavy.fogMaxAlpha, w),
  }
}

/**
 * Blend two 24-bit RGB hex ints channel-wise in byte space, matching what the
 * panel's colour picker previews (a linear-light blend darkens the midpoint).
 */
export function mixHex(a, b, t) {
  const w = clamp01(t)
  const ch = shift => {
    const ca = (a >> shift) & 0xff
    const cb = (b >> shift) & 0xff
    return Math.round(lerp(ca, cb, w)) & 0xff
  }
  return (ch(16) << 16) | (ch(8) << 8) | ch(0)
}

/**
 * Scale a 24-bit RGB hex's brightness by `k`, per channel: reflected radiance is
 * illuminant times reflectance per channel, so the colour loses vividness with
 * the light. Channels clamp at 255.
 */
export function scaleHex(hex, k) {
  const f = Number.isFinite(k) ? Math.max(0, k) : 1
  const ch = shift => Math.min(255, Math.round(((hex >> shift) & 0xff) * f))
  return (ch(16) << 16) | (ch(8) << 8) | ch(0)
}

/**
 * The weather's colour targets, keyed like the curves above, as 24-bit ints.
 * Each colour's `tint` in WEATHER_PARAMS picks how it blends:
 *   'sky'     clear → heavy.skyHex by `litW`, then toward heavy.hazeSky by `haze`.
 *             The horizon, painting sky and zenith all travel to the same heavy
 *             sky, so a grey or hazy sky loses its gradient.
 *   'ground'  the clear colour scaled by `lightRatio` (the light level now over
 *             its clear value): the land darkens with the light, the sky does not.
 * @param {object} clear, heavy  the two profiles
 * @param {number} litW          shapeOvercast(overcast, shape) × effectScale
 */
export function colourCurves(clear, heavy, litW, haze, lightRatio) {
  const out = {}
  for (const e of WEATHER_PARAMS) {
    if (e.tint === 'sky') out[e.key] = mixHex(mixHex(clear[e.key], heavy.skyHex, litW), heavy.hazeSky, haze)
    else if (e.tint === 'ground') out[e.key] = scaleHex(clear[e.key], lightRatio)
  }
  return out
}
