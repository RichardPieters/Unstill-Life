/**
 * terrainMath.js — the terrain driver's pure maps.
 *
 *   drift      driftAngleStep, nonNegDelta
 *   range      computeHeightMax (uHeightMax)
 *   mantle DC  ampSum, mantleSigmaCoeff, mantleDcCoefficient (uMantleDC)
 *
 * No THREE, DOM, uniforms or wall-clock time: terrainDriver.js owns the state
 * and writes the results into the shared uniforms. Tests: tests/unit/terrainMath.test.js.
 *
 * KNOWN LIMITS (accepted, the shipped values are tuned with them in place)
 *   computeHeightMax is the amplitudes plus the erosion margin. It ignores the
 *   ridge DC shift and the shaped noise range, so changing the ridge amount at
 *   runtime drifts the biome bands and the seabed.
 *   uMantleDC ignores mantleBias, so at the four form corners the land sits
 *   0.5–6.5 units lower against the sea and the bands than the lift model
 *   intends (applied DC 5.8 / 8.3 / 2.6 / 6.5 against a true lift of 1.0 /
 *   1.8 / 2.1 / 3.1). The fix would put the bias into the lift,
 *   E[max(0, D − B)] = σ·(φ(z) − z·(1 − Φ(z))) with z = B/σ_D, and then need a
 *   retune of the corners' sea bands.
 */

/**
 * World-height ↔ normalised-height scale per unit of amplitude sum:
 * H_NORM = (amp0 + amp1) × this. heightmap.frag's erosion filter works in
 * normalised space (terrain.js injects this value there), and uHeightMax's
 * erosion margin is sized with the same number, so both read one definition.
 */
export const H_NORM_PER_AMP = 2.776

/** H_NORM for the given amplitudes, floored at 1. */
export const hNormFor = (amp0, amp1) => Math.max((amp0 + amp1) * H_NORM_PER_AMP, 1.0)

/**
 * Populated vertical range = fBM amplitude sum + an erosion head-room margin.
 * Mirrors heightmap.frag: erosion can lift height by ~strength·scale·2·H_NORM
 * world units on top of the base fBM. Kept as a function so uHeightMax can
 * never drift from the amp sliders (the constant-dependency rule).
 * @param {number} hNorm world↔normalised height scale (hNormFor).
 */
export function computeHeightMax(amp0, amp1, erosionEnabled, strength, scale, hNorm) {
  const margin = erosionEnabled ? strength * scale * 2.0 * hNorm : 0.0
  return amp0 + amp1 + margin
}

/**
 * One drift-angle random-walk step. A low-frequency sinusoid (`angNoise`)
 * steers the heading; momentum scales the turn rate; `realDt` keeps it
 * wall-clock paced so it is frame-rate independent.
 */
export function driftAngleStep(angle, realDt, momentum, angNoise, angularSpeed) {
  return angle + realDt * momentum * angNoise * angularSpeed
}

/**
 * Non-negative noiseTime delta. A reset can move noiseTime backwards; clamping
 * ≥0 stops that from rewinding the integrated drift offset (drift is a one-way
 * accumulation).
 */
export function nonNegDelta(noiseTime, prevNoiseTime) {
  return Math.max(0, noiseTime - prevNoiseTime)
}

/** Amplitude sum Σ persistence^i over n octaves — fbmDual's normaliser `maxAmp` (stock persistence series). */
export function ampSum(persistence, octaves) {
  let s = 0, a = 1
  for (let i = 0; i < Math.max(0, Math.floor(octaves)); i++) { s += a; a *= persistence }
  return s
}

/**
 * σ of the bedrock−mantle difference D = K − F, in units of the per-octave
 * shaped-noise σ — i.e. the shape of the answer, not its scale.
 *
 * With the shared normalisation W = ampSum(p, nK), octave i carries w_i/W in
 * both fields, so the mantle's octaves survive D weighted by (1−ρ) while
 * bedrock's extra octaves survive at full weight:
 *
 *   D = (1−ρ)·Σ_{i<nF} w_i·n_i  +  Σ_{nF≤i<nK} w_i·n_i     (all ÷ W, × amp)
 *
 * Octaves are treated as independent — the standard fBM assumption, and only an
 * assumption: it is why mantleDcCoefficient needs a measured constant on top.
 */
export function mantleSigmaCoeff(amp, persistence, mantleOctaves, bedrockOctaves, relief, rockPersist = null) {
  const nK = Math.max(Math.floor(bedrockOctaves), Math.floor(mantleOctaves))
  const nF = Math.min(Math.floor(mantleOctaves), nK)
  // The rock octaves (bedrock-only, i >= nF) bend the weight series at nF, so
  // walk it rather than assuming a single geometric ratio. W tracks the STOCK
  // series only — matching fbm.glsl, where the normalisation deliberately
  // excludes uRockPersist so that knob cannot rescale the mantle.
  // rockPersist = null: no bend (the stock persistence throughout).
  const stepAt = i => (rockPersist != null && i + 1 >= nF ? rockPersist : persistence)
  let W = 0, shared = 0, extra = 0, w = 1, nw = 1
  for (let i = 0; i < nK; i++) {
    W += nw
    if (i < nF) shared += w * w
    else extra += w * w
    w *= stepAt(i)
    nw *= persistence
  }
  const g = 1 - relief
  return (amp / Math.max(W, 1e-6)) * Math.sqrt(g * g * shared + extra)
}

/**
 * Mean lift that h = max(F, K) adds over the mantle field, in world units —
 * subtracted in fbm.glsl as uMantleDC so the composed terrain stays zero-mean
 * and the biome bands do not slide against uSnowBase / uTreeBase.
 *
 * For a zero-mean Gaussian D, E[max(0,D)] = σ_D/√(2π) = 0.3989·σ_D, and σ_D is
 * the closed-form coefficient above times the per-octave noise σ. Neither factor
 * is available analytically — snoise has no closed-form pdf, and D is only
 * approximately Gaussian. So they are folded into ONE measured constant.
 *
 * ACCURACY. Measured on the live 512² height map, erosion off, averaged over 8
 * drift positions: (mean height with max()) − (mean height of the mantle alone)
 * is the true lift minus the DC applied here. At the four form-dial corners
 * (rolling/alpine × land/islands) the applied DC is 5.8 / 8.3 / 2.6 / 6.5 and
 * the true lift is 1.0 / 1.8 / 2.1 / 3.1, because the formula assumes no
 * mantleBias (6 / 13 / 0 / 6 at those corners): a raised mantle is overtaken by
 * bedrock less often, so max() lifts less. With the bias set to 0 the applied DC
 * still exceeds the true lift by 15–50% of its own value (rock octaves,
 * non-Gaussian difference).
 * The persistence and octave dependence, which momentum drives every tick,
 * stays closed form; the overall level is what the corners were tuned against.
 */
const MANTLE_DC_PER_SIGMA = 0.1745

/**
 * @param {number|null} rockPersist  uRockPersist, the bedrock-only octaves' own
 *   falloff; null = none. The shader always runs the rock octaves, so the DC is
 *   approximate in the shipped configuration (see KNOWN LIMITS above): this
 *   tracks the bent amplitude series but not the per-octave variance change
 *   that ridging them introduces.
 */
export function mantleDcCoefficient(amp0, p0, amp1, p1, mantleOctaves, bedrockOctaves, relief, rockPersist = null) {
  const c0 = mantleSigmaCoeff(amp0, p0, mantleOctaves, bedrockOctaves, relief, rockPersist)
  const c1 = mantleSigmaCoeff(amp1, p1, mantleOctaves, bedrockOctaves, relief, rockPersist)
  return MANTLE_DC_PER_SIGMA * Math.hypot(c0, c1)
}
