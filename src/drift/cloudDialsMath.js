/**
 * cloudDialsMath.js — the two cloud dials as pure maps from a dial position in
 * [0,1] onto what they drive.
 *
 *   scatter  → baseFreq     a few broad cloud masses → many small puffs
 *   density  → absorption, god-ray scale, cloud-shadow scale and depth, and how
 *              strongly the weather changes the light
 *
 * The endpoints are hand-set artistic values, pinned exactly by the unit test.
 * Every map clamps its input to [0,1] and reads non-finite input as 0, so
 * nothing extrapolates or emits NaN. scene/formDriver.js writes the results onto
 * the clouds, godrays and scene uniforms; formWalker.js moves the positions.
 */

import { clamp01 } from '../shared/mathUtils.js'

/** Linear interpolation between the endpoints; a position is [0,1]. */
function lerpClamped(lo, hi, t) {
  return lo + (hi - lo) * clamp01(t)
}

// SCATTER: a higher base frequency is a shorter wavelength, so the same cloud
// shell holds more, smaller masses. The range stops at 0.010: above it the
// masses are small enough that the detail octaves and the coverage gate carve
// them into speckle.
export const SCATTER_FREQ_LO = 0.005
export const SCATTER_FREQ_HI = 0.010

/** Base frequency for a scatter position in [0,1]. */
export function scatterToBaseFreq(t) {
  return lerpClamped(SCATTER_FREQ_LO, SCATTER_FREQ_HI, t)
}

// DENSITY: how solid the cloud reads. One dial, because its effects move together.
//   absorption    how fast a march ray goes opaque
//   ray scale     god-ray brightness. Shafts are light that got through the deck,
//                 so a denser deck makes harder shafts against a darker sky
//   shadow scale  cloud-shadow strength on the ground
//   shadow depth  how dark the shadow gets
//   weather       how much of the weather's effect on the light gets through
// The ray and shadow scales multiply their sliders and do not replace them, so
// each slider stays the authority on the base look.
export const DENSITY_ABSORPTION_LO = 0.005
export const DENSITY_ABSORPTION_HI = 0.075
export const DENSITY_RAY_SCALE_LO  = 0.25
export const DENSITY_RAY_SCALE_HI  = 2.5

/** Absorption for a density position in [0,1]. */
export function densityToAbsorption(t) {
  return lerpClamped(DENSITY_ABSORPTION_LO, DENSITY_ABSORPTION_HI, t)
}

/** Inverse of `densityToAbsorption`: the density position a given absorption reads as. */
export function absorptionToDensity(absorption) {
  return clamp01((absorption - DENSITY_ABSORPTION_LO) / (DENSITY_ABSORPTION_HI - DENSITY_ABSORPTION_LO))
}

/** God-ray brightness multiplier for a density position in [0,1]. */
export function densityToRayScale(t) {
  return lerpClamped(DENSITY_RAY_SCALE_LO, DENSITY_RAY_SCALE_HI, t)
}

// Never 0 at the thin end: the terrain shader skips the shadow term at 0, which
// would turn the faintest weather's modelled light flat.
const DENSITY_SHADOW_SCALE_LO = 0.25
const DENSITY_SHADOW_SCALE_HI = 1

/** Cloud-shadow strength multiplier for a density position in [0,1]. */
export function densityToShadowScale(t) {
  return lerpClamped(DENSITY_SHADOW_SCALE_LO, DENSITY_SHADOW_SCALE_HI, t)
}

/** Shadow depth, set outright (density 0 → 0, 1 → 1); every density write overwrites the depth slider. */
export function densityToShadowDepth(t) {
  return clamp01(t)
}

// How strongly the weather changes the light at a given density.
//
// The light (light level, shadow value, glow, shadow hue, water reflection and
// glint, cloud grey) is blended between its clear-day and overcast values:
//
//   light = clear + (overcast value − clear) × overcast amount × FACTOR
//
// This function is FACTOR: 0.2 at density 0, rising in a straight line to 1 at
// density 0.5, and 1 above that. Under full overcast, thin clouds give a fifth
// of the darkening, and density 0.5 or more the full darkening. A clear sky
// (overcast amount 0) stays clear at any density.
const DENSITY_EFFECT_LO   = 0.2
const DENSITY_EFFECT_FULL = 0.5

/** Weather-effect strength for a density position in [0,1]. */
export function densityToWeatherEffect(t) {
  const d = clamp01(t)
  if (d >= DENSITY_EFFECT_FULL) return 1
  return DENSITY_EFFECT_LO + (1 - DENSITY_EFFECT_LO) * (d / DENSITY_EFFECT_FULL)
}
