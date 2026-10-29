import { describe, it, expect } from 'vitest'
import { PIGMENTS, hexToLinear, weightsFor, buildLut, LUT_N, MAX_FAMILIES } from '../../src/artpass/artPigments.js'

const P = PIGMENTS.map(p => hexToLinear(p.h))

const TARGETS = [
  '#C9A227', // gold water
  '#8FA8C8', // pale haze
  '#5E7A6B', // sage slope
  '#3E3A5C', // slate shadow
  '#E8DCC0', // cream
  '#241A12', // dark brown — outside the hull, deliberately
]

const srgbToLinear = c => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))
const toLin = hex => [1, 3, 5].map(i => srgbToLinear(parseInt(hex.slice(i, i + 2), 16) / 255))

/** The centroid of the chosen pigments under their own weights. */
function centroid(keep) {
  const bar = [0, 0, 0]
  for (const e of keep) for (let c = 0; c < 3; c++) bar[c] += e.w * P[e.i][c]
  return bar
}

describe('artpass palette solve', () => {
  it('returns weights that are non-negative and sum to one', () => {
    for (const hex of TARGETS) {
      const keep = weightsFor(toLin(hex), P, 0.4, 0.02)
      expect(keep.length).toBeGreaterThan(0)
      expect(keep.length).toBeLessThanOrEqual(MAX_FAMILIES)
      for (const e of keep) expect(e.w).toBeGreaterThan(0)
      const sum = keep.reduce((s, e) => s + e.w, 0)
      expect(sum).toBeCloseTo(1, 10)
    }
  })

  // The invariant the whole colour engine rests on. Strokes are placed at
  // s = C + k(p - P̄); their weighted mean is C + k(P̄ - P̄) = C, exactly, for
  // ANY palette, any weights and any spread. If this ever fails, the pass is
  // depicting a colour other than the one the scene asked for.
  it('preserves the target exactly under re-centring, for every spread', () => {
    for (const hex of TARGETS) {
      const C = toLin(hex)
      const keep = weightsFor(C, P, 0.4, 0.02)
      const bar = centroid(keep)

      for (const k of [0, 0.3, 0.5, 1, 1.7, 3]) {
        const mean = [0, 0, 0]
        for (const e of keep) {
          for (let c = 0; c < 3; c++) mean[c] += e.w * (C[c] + k * (P[e.i][c] - bar[c]))
        }
        for (let c = 0; c < 3; c++) expect(mean[c]).toBeCloseTo(C[c], 10)
      }
    }
  })

  // β is a count knob, not a colour knob: it must change how many pigments
  // participate without touching what the mixture depicts.
  it('beta raises the pigment count while the invariant still holds', () => {
    const C = toLin('#5E7A6B')
    const sparse = weightsFor(C, P, 0, 0.02)
    const dense = weightsFor(C, P, 1, 0.02)
    expect(dense.length).toBeGreaterThan(sparse.length)

    for (const keep of [sparse, dense]) {
      const bar = centroid(keep)
      const mean = [0, 0, 0]
      for (const e of keep) {
        for (let c = 0; c < 3; c++) mean[c] += e.w * (C[c] + 1.0 * (P[e.i][c] - bar[c]))
      }
      for (let c = 0; c < 3; c++) expect(mean[c]).toBeCloseTo(C[c], 10)
    }
  })

  // A dominant family plus a thin tail is the structure the references show,
  // and it is what makes the field low-chroma while accents stay pure —
  // Σwᵢ(pᵢ − P̄) = 0 forces a heavily weighted family to sit near the centroid.
  it('produces a dominant family rather than an even spread', () => {
    for (const hex of ['#C9A227', '#8FA8C8', '#E8DCC0']) {
      const keep = weightsFor(toLin(hex), P, 0.4, 0.02)
      const top = Math.max(...keep.map(e => e.w))
      expect(top).toBeGreaterThan(1 / keep.length)
    }
  })

  it('culling more aggressively cannot increase the family count', () => {
    const C = toLin('#5E7A6B')
    const loose = weightsFor(C, P, 0.6, 0.002).length
    const tight = weightsFor(C, P, 0.6, 0.06).length
    expect(tight).toBeLessThanOrEqual(loose)
  })
})

describe('artpass lookup table', () => {
  it('covers the grid with valid pigment indices and normalised weights', () => {
    const { idx, wts, width, height } = buildLut({ beta: 0.4, cull: 0.02 })
    expect(width).toBe(LUT_N * LUT_N)
    expect(height).toBe(LUT_N)
    expect(idx.length).toBe(width * height * 4)

    let empty = 0
    for (let p = 0; p < width * height; p++) {
      let sum = 0
      for (let k = 0; k < 4; k++) {
        expect(idx[p * 4 + k]).toBeLessThan(PIGMENTS.length)
        sum += wts[p * 4 + k]
      }
      if (sum === 0) empty++
      else expect(Math.abs(sum - 255)).toBeLessThanOrEqual(4)  // 8-bit rounding
    }
    expect(empty).toBe(0)
  })
})
