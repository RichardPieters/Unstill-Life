/**
 * terrainForm.js — the two macro dials for the terrain's overall form, as one
 * pure map from dial positions onto terrain and water targets.
 *
 *   ocean      0 = one big landmass with ponds · 1 = sea with small islands
 *   mountains  0 = rolling                     · 1 = alpine
 *
 * THE BLEND   Four hand-tuned configurations pin the corners of the
 *             (ocean, mountains) square:
 *
 *                           ocean 0              ocean 1
 *               mountains 1 alpine landmass ──── alpine islands
 *                           │                    │
 *               mountains 0 rolling landmass ─── rolling islands
 *
 *             A point inside is the bilinear blend of the four: exact at every
 *             corner, with no curve shape guessed and nothing extrapolated.
 * NOT BLENDED Everything else (palette, biome thresholds, erosion, the forest
 *             controls) is the same in all four configurations.
 * WIRING      scene/formDriver.js writes the targets onto terrain and water, in a
 *             load-bearing order. The piece opens on the start scene's form (main.js).
 */

import { clamp01 } from '../shared/mathUtils.js'

/**
 * Corner values, always ordered
 *   [ rolling landmass, alpine landmass, rolling islands, alpine islands ]
 * i.e. [ ocean 0 · mtn 0,  ocean 0 · mtn 1,  ocean 1 · mtn 0,  ocean 1 · mtn 1 ].
 */
export const FORM_CORNERS = {
  // ── The sea band (waterDriver's bounds, not the uSeaLevel uniform) ────────
  // `seaLow` is the waterline at full restlessness, `seaHigh` where it rises to
  // as the scene settles into a painting. The band rises bodily with the ocean
  // dial: seaLow averages −32 at ocean 0 and −2.5 at ocean 1, seaHigh −6 and +7.
  seaLow:         [-28, -36, 0, -5],
  seaHigh:        [-4, -8, 5, 9],

  // ── Landform scale ────────────────────────────────────────────────────────
  // fbm0's amplitude follows the mountain dial, its frequency the ocean dial.
  // That split is why islands work: the ocean end makes landforms SMALLER
  // (fbm0Freq doubles) and drops the secondary hills that bridge them together
  // (fbm1Amp 92 → 30 rolling, 129 → 23 alpine), rather than flooding a continent.
  fbm0Amp:        [62, 150, 38, 150],
  fbm1Amp:        [92, 129, 30, 23],
  fbm0Freq:       [0.001, 0.001, 0.002, 0.002],
  fbm1Freq:       [0.003, 0.003, 0.0035, 0.0025],

  // ── Ridge character ───────────────────────────────────────────────────────
  // These two move in OPPOSITE directions across the corners: the corner with the
  // most ridging (alpine landmass) has the least rounding, and the corner with no
  // ridging (rolling islands) has the most. Rounding keeps the slope continuous
  // through a crest, which the erosion stage needs (it carves along slope jumps),
  // and lowers the crest of a fully folded octave to 1 − 2 × round.
  ridgeAmt:       [0.35, 0.70, 0.0, 0.45],
  ridgeRound:     [0.45, 0.31, 0.50, 0.31],
  bedrockOctaves: [5, 6, 6, 6],

  // ── Soil vs rock ──────────────────────────────────────────────────────────
  // Relief is the mantle's share of bedrock's height; bias is an outright soil
  // level in world units. Bias tracks both dials — more mountainous means more
  // soil, more ocean means less — which is why it needs the 2-D blend rather
  // than belonging to one axis.
  mantleRelief:   [0.45, 0.55, 0.40, 0.50],
  mantleBias:     [6, 13, 0, 6],

  // ── Rock detail character ─────────────────────────────────────────────────
  rockRidge:      [0.55, 0.65, 0.85, 0.85],
  rockPersist:    [0.26, 0.45, 0.33, 0.33],
  rockAniso:      [1.4, 2.0, 1.2, 1.2],

  // ── Where rock is allowed to show ─────────────────────────────────────────
  gateAmt:        [0.65, 0.80, 0.90, 0.90],
  gateLo:         [-0.50, -0.05, -0.10, -0.10],
  gateHi:         [0.75, 0.60, 1.00, 0.60],
}

/** Values that must land on a whole number of octaves. */
const INTEGER_KEYS = new Set(['bedrockOctaves'])

/**
 * Blend the four corners at (ocean, mountains), both clamped to [0,1].
 *
 * @param {number} ocean      0 landmass with ponds → 1 sea with islands
 * @param {number} mountains  0 rolling → 1 alpine
 * @returns {Record<string, number>} one target per key in FORM_CORNERS
 */
export function formTargets(ocean, mountains) {
  const o = clamp01(ocean)
  const m = clamp01(mountains)
  // Bilinear weights, in the corner order of FORM_CORNERS.
  const w = [(1 - o) * (1 - m), (1 - o) * m, o * (1 - m), o * m]

  const out = {}
  for (const [key, c] of Object.entries(FORM_CORNERS)) {
    const v = c[0] * w[0] + c[1] * w[1] + c[2] * w[2] + c[3] * w[3]
    out[key] = INTEGER_KEYS.has(key) ? Math.round(v) : v
  }
  return out
}
