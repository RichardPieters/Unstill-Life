import { clamp01 } from '../shared/mathUtils.js'

/**
 * artPigments.js — pigments, the weight solve, and the lookup texture.
 *
 * The solve answers one question: given a target colour, which pigments and in
 * what area fractions. It runs here on the CPU over a colour-space grid and
 * bakes the answer into a texture, because the Newton iteration behind the
 * maximum-entropy weights is far too heavy to run per stroke.
 *
 * The lookup is NEAREST, deliberately. Interpolating pigment indices is
 * meaningless, and it costs nothing: the mixture's average is not the lookup's
 * job. Whatever family set comes back, artColour.glsl re-centres it onto the
 * target, so the depicted colour is exact for any entry the table returns. The
 * table only decides which pigments participate.
 */

// The darks (indigo, pine, dark madder) are needed. Measured against a hull
// test, a palette of only bright pigments excludes gold, slate and any dark
// brown — ordinary landscape colours — and the solve then silently degrades to
// nearest-point plus re-centring, with the strokes no longer raw pigment.
export const PIGMENTS = [
  { n: 'cadmium',     h: '#F5C400' },
  { n: 'vermilion',   h: '#E0442B' },
  { n: 'alizarin',    h: '#A81E4A' },
  { n: 'violet',      h: '#6B3FA0' },
  { n: 'ultramarine', h: '#1F44A8' },
  { n: 'cerulean',    h: '#1E8FC8' },
  { n: 'viridian',    h: '#17876B' },
  { n: 'indigo',      h: '#12233F' },
  { n: 'pine',        h: '#0E3A2C' },
  { n: 'dark madder', h: '#4A1230' },
  { n: 'lead white',  h: '#F2F0E6' },
]

export const MAX_FAMILIES = 4          // how many pigments one entry may carry
export const LUT_N = 16                // grid resolution per colour axis

const srgbToLinear = c => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))

export function hexToLinear(h) {
  return [1, 3, 5].map(i => srgbToLinear(parseInt(h.slice(i, i + 2), 16) / 255))
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

function solve3(M, v) {
  const [a, b, c] = M[0], [d, e, f] = M[1], [g, h, i] = M[2]
  const A = e * i - f * h, B = -(d * i - f * g), Cc = d * h - e * g
  const det = a * A + b * B + c * Cc
  if (Math.abs(det) < 1e-14) return null
  const D = -(b * i - c * h), E = a * i - c * g, F = -(a * h - b * g)
  const G = b * f - c * e, H = -(a * f - c * d), I = a * e - b * d
  return [
    (A * v[0] + D * v[1] + G * v[2]) / det,
    (B * v[0] + E * v[1] + H * v[2]) / det,
    (Cc * v[0] + F * v[1] + I * v[2]) / det,
  ]
}

/**
 * The dense end of the solution set. Σwᵢpᵢ = C with Σw = 1 is four equations in
 * n unknowns, so for n > 4 a whole convex family of weightings hits the target.
 * Maximum entropy picks the one spreading area over as many pigments as it can:
 * wᵢ ∝ exp(λ·pᵢ), λ found by Newton, Jacobian = covariance of p under w.
 */
function maxEntropyWeights(C, P) {
  const n = P.length
  let lam = [0, 0, 0], q = new Array(n).fill(1 / n)
  for (let it = 0; it < 24; it++) {
    const en = P.map(p => dot3(lam, p))
    const mx = Math.max(...en)
    let sum = 0
    for (let i = 0; i < n; i++) { q[i] = Math.exp(en[i] - mx); sum += q[i] }
    for (let i = 0; i < n; i++) q[i] /= sum

    const m = [0, 0, 0]
    for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) m[c] += q[i] * P[i][c]
    const r = sub(C, m)
    if (dot3(r, r) < 1e-12) break

    const cov = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
    for (let i = 0; i < n; i++) {
      const d = sub(P[i], m)
      for (let x = 0; x < 3; x++) for (let y = 0; y < 3; y++) cov[x][y] += q[i] * d[x] * d[y]
    }
    for (let i = 0; i < 3; i++) cov[i][i] += 1e-6

    const step = solve3(cov, r)
    if (!step) break
    // Outside the palette hull no solution exists and λ runs away; cap the
    // step and let the shader's re-centring absorb whatever residual is left.
    const L = Math.hypot(...step)
    const s = L > 40 ? 40 / L : 1
    lam = [lam[0] + step[0] * s, lam[1] + step[1] * s, lam[2] + step[2] * s]
  }
  return q
}

/** The sparse end: the pigment pair whose segment passes nearest the target. */
function nearestPair(C, P) {
  let best = { d: Infinity, a: 0, b: 1, t: 0.5 }
  for (let a = 0; a < P.length; a++) {
    for (let b = a + 1; b < P.length; b++) {
      const ab = sub(P[b], P[a])
      const len2 = dot3(ab, ab)
      let t = len2 > 1e-9 ? dot3(sub(C, P[a]), ab) / len2 : 0
      t = clamp01(t)
      const q = [P[a][0] + ab[0] * t, P[a][1] + ab[1] * t, P[a][2] + ab[2] * t]
      const dv = sub(q, C), d = dot3(dv, dv)
      if (d < best.d) best = { d, a, b, t }
    }
  }
  return best
}

/**
 * Weights for one target colour.
 * @param beta 0 = nearest pair, 1 = maximum entropy. Every value between is
 *             itself an exact solution, since the solution set is convex.
 * @param cull drop families below this area share. This is the outlier control:
 *             the rarest families sit furthest from the target, so keeping ones
 *             holding half a percent produces the few wildly-off strokes.
 */
export function weightsFor(C, P, beta, cull) {
  const n = P.length
  const pair = nearestPair(C, P)
  const wS = new Array(n).fill(0)
  wS[pair.a] = 1 - pair.t
  wS[pair.b] = pair.t
  const wD = maxEntropyWeights(C, P)

  const rows = []
  for (let i = 0; i < n; i++) {
    const v = (1 - beta) * wS[i] + beta * wD[i]
    if (v > cull) rows.push({ i, w: v })
  }
  rows.sort((a, b) => b.w - a.w)
  const keep = rows.slice(0, MAX_FAMILIES)
  const sum = keep.reduce((s, r) => s + r.w, 0) || 1
  for (const r of keep) r.w /= sum
  return keep
}

/**
 * Bake the solve over an RGB grid.
 * Returns two LUT_N³-entry byte arrays laid out as a (LUT_N² × LUT_N) texture:
 * `idx` holds pigment indices, `wts` their area fractions.
 */
export function buildLut({ beta, cull }) {
  const P = PIGMENTS.map(p => hexToLinear(p.h))
  const N = LUT_N
  const w = N * N, h = N
  const idx = new Uint8Array(w * h * 4)
  const wts = new Uint8Array(w * h * 4)

  for (let b = 0; b < N; b++) {
    for (let g = 0; g < N; g++) {
      for (let r = 0; r < N; r++) {
        // Grid is in sRGB (that is what the beauty buffer holds); the solve
        // itself runs in linear light, where optical mixing is an average.
        const C = [r, g, b].map(v => srgbToLinear(v / (N - 1)))
        const keep = weightsFor(C, P, beta, cull)
        const px = (b * N + r) + g * w      // slice b across x, g down y
        for (let k = 0; k < 4; k++) {
          const e = keep[k]
          idx[px * 4 + k] = e ? e.i : 0
          wts[px * 4 + k] = e ? Math.round(e.w * 255) : 0
        }
      }
    }
  }
  return { idx, wts, width: w, height: h }
}
