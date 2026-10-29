/**
 * waterMath.js — the pure maps waterDriver.js's tick applies: dynamics state
 * (restlessness, momentum, dt) → sea level, ripple time, foam reach, sparkle
 * cutoff, and the depth scaling of the depth-measured constants.
 */

/**
 * One smoothing step of the reactive sea level toward its target.
 * Target rises as restlessness decays: calm (1) → low, fully settled (0) → high.
 * @returns {number} the new (smoothed) sea level
 */
export function seaLevelStep(current, low, high, restlessness, smooth) {
  const target = low + (high - low) * (1.0 - restlessness)
  return current + (target - current) * smooth
}

/**
 * Advance ripple time by dt scaled to momentum (calm crawls, agitated churns).
 * @returns {number} the new ripple time
 */
export function rippleAdvance(rippleTime, dt, momentum, speedMin, speedMax) {
  return rippleTime + dt * (speedMin + (speedMax - speedMin) * momentum)
}

/** Shore-foam reach = base × a momentum-scaled factor (thin lapping → surf). */
export function foamWidthForMomentum(base, momentum, factorLo, factorHi) {
  return base * (factorLo + (factorHi - factorLo) * momentum)
}

/**
 * Sparkle cutoff tightens (denser glitter) as momentum rises, floored so it
 * never collapses to zero.
 */
export function sparkleForMomentum(base, momentum, range, floor = 0.02) {
  return Math.max(floor, base - range * momentum)
}

// ─── Depth scaling ───────────────────────────────────────────────────────────
// water.frag measures two things in world units of water depth: uDepthMax (the
// depth at which the deep colour is fully reached) and uFoamWidth (the depth
// within which shore foam is drawn). The form dials change how deep the water
// can get, so both are set as a SHARE of the depth available,
// seaLevel − seabed. The seabed's lowest point needs a GPU readback to know
// exactly; it tracks the terrain's amplitude sum, at 0.236 × ampSum below zero
// (the mean of the ratio measured at the four dial corners).
export const TERRAIN_MIN_PER_AMP = 0.236

/**
 * Depth of water available between the waterline and the seabed, estimated from
 * the terrain's amplitude. Floored, so a terrain sitting entirely above the sea
 * cannot make it zero (water.frag divides by uDepthMax, and foam would vanish).
 */
export function availableDepth(ampSum, seaLevel) {
  const amp = ampSum > 0 ? ampSum : 0
  return Math.max(seaLevel + TERRAIN_MIN_PER_AMP * amp, 1)
}

/**
 * A share of the available depth, in world units of depth.
 *
 * @param {number} share     the slider value: 0.5 is half the water's depth
 * @param {number} ampSum    uFBM0Amp + uFBM1Amp right now
 * @param {number} seaLevel  the current waterline
 */
export function depthShare(share, ampSum, seaLevel) {
  return share * availableDepth(ampSum, seaLevel)
}
