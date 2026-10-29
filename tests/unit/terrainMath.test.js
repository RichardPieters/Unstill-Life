import { describe, test, expect } from 'vitest'
import {
  computeHeightMax,
  driftAngleStep, nonNegDelta,
  ampSum, mantleSigmaCoeff, mantleDcCoefficient, H_NORM_PER_AMP, hNormFor,
} from '../../src/terrain/terrainMath.js'

describe('computeHeightMax', () => {
  test('erosion off → plain amplitude sum', () => {
    expect(computeHeightMax(45, 10, false, 0.3, 0.17, 440)).toBe(55)
  })
  test('erosion on → adds strength·scale·2·hNorm margin', () => {
    // 0.3 * 0.17 * 2 * 440 = 44.88
    expect(computeHeightMax(45, 10, true, 0.3, 0.17, 440)).toBeCloseTo(99.88)
  })
  test('zero strength or scale → no margin even when enabled', () => {
    expect(computeHeightMax(45, 10, true, 0, 0.17, 440)).toBe(55)
    expect(computeHeightMax(45, 10, true, 0.3, 0, 440)).toBe(55)
  })
})

describe('driftAngleStep', () => {
  test('advances angle by realDt·momentum·angNoise·angularSpeed', () => {
    // 1.0 + 0.1*0.5*1.0*0.2 = 1.01
    expect(driftAngleStep(1.0, 0.1, 0.5, 1.0, 0.2)).toBeCloseTo(1.01)
  })
  test('zero momentum freezes the heading', () => {
    expect(driftAngleStep(1.0, 0.1, 0, 1.0, 0.2)).toBe(1.0)
  })
  test('negative noise reverses direction', () => {
    expect(driftAngleStep(1.0, 0.1, 0.5, -1.0, 0.2)).toBeCloseTo(0.99)
  })
})

describe('nonNegDelta', () => {
  test('forward delta passes through', () => {
    expect(nonNegDelta(5.2, 5.0)).toBeCloseTo(0.2)
  })
  test('a backward jump clamps to 0 (drift never rewinds)', () => {
    expect(nonNegDelta(3.0, 40.0)).toBe(0)
  })
})


describe('bedrock/mantle two-field algebra', () => {
  // Mantle 3 octaves, bedrock 6, and the amps/persistences the DC constant was measured at.
  const NF = 3, NK = 6, P0 = 0.65, P1 = 0.55, A0 = 83, A1 = 75.5

  test('ampSum is the geometric series the shader normalises by', () => {
    expect(ampSum(0.5, 3)).toBeCloseTo(1 + 0.5 + 0.25, 12)
    expect(ampSum(0.65, 1)).toBeCloseTo(1, 12)
    expect(ampSum(0.65, 0)).toBe(0)
  })

  // THE SIGN TRAP — the one claim that silently inverts the whole mechanism,
  // pinned here because it is pure algebra and costs nothing to check.
  //
  // Sharing the normalisation over nK gives every shared octave the coefficient
  // w_i/W(nK) in BOTH fields, so the coarse relief gap is (1-rho)·a > 0 and
  // bedrock sits on the high ground. Normalising the mantle over its OWN fewer
  // octaves gives it a LARGER coarse coefficient, the gap goes negative, and
  // bedrock ends up in the valleys. A sign, not a threshold.
  test('shared normalisation keeps the relief gap positive; independent normalisation inverts it', () => {
    for (const [amp, p] of [[A0, P0], [A1, P1]]) {
      const a = amp / ampSum(p, NK)              // bedrock coarse coefficient
      const b = 0.45 * a                         // mantle, correct construction
      expect(a - b).toBeGreaterThan(0)

      const bTrap = amp / ampSum(p, NF)          // mantle normalised over nF
      expect(a - bTrap).toBeLessThan(0)          // ← inverted
      expect(bTrap).toBeGreaterThan(a)           // fewer octaves ⇒ larger coefficient
    }
  })

  test('sigma coefficient vanishes only when the fields are identical', () => {
    // rho = 1 AND no extra bedrock octaves ⇒ F ≡ K ⇒ no difference at all.
    expect(mantleSigmaCoeff(A0, P0, NF, NF, 1.0)).toBeCloseTo(0, 12)
    // Either difference alone is enough to separate them.
    expect(mantleSigmaCoeff(A0, P0, NF, NK, 1.0)).toBeGreaterThan(0)   // extra octaves only
    expect(mantleSigmaCoeff(A0, P0, NF, NF, 0.45)).toBeGreaterThan(0)  // relief gap only
  })

  test('a bedrock octave count below the mantle count is clamped, not inverted', () => {
    const clamped = mantleSigmaCoeff(A0, P0, NF, 1, 0.45)
    const equal = mantleSigmaCoeff(A0, P0, NF, NF, 0.45)
    expect(clamped).toBeCloseTo(equal, 12)
  })

  test('DC is proportional to amplitude and shrinks as relief closes the gap', () => {
    const dc = mantleDcCoefficient(A0, P0, A1, P1, NF, NK, 0.45)
    // Amplitude-linear: the crossing is amp-invariant, but the LIFT is not.
    const dcScaled = mantleDcCoefficient(A0 * 2, P0, A1 * 2, P1, NF, NK, 0.45)
    expect(dcScaled / dc).toBeCloseTo(2, 9)
    // Monotone in rho over the usable band.
    let prev = Infinity
    for (const rho of [0.0, 0.15, 0.30, 0.45]) {
      const v = mantleDcCoefficient(A0, P0, A1, P1, NF, NK, rho)
      expect(v).toBeLessThan(prev)
      prev = v
    }
  })

  // Anchored to the 512² measurement behind MANTLE_DC_PER_SIGMA: at rho 0.45
  // the measured mean lift was 5.941 wu.
  // Loose to 2 significant figures — this pins the calibration against drift in
  // the octave algebra, not the exact tuning of the constant.
  test('predicts the measured lift at the shipped defaults', () => {
    const dc = mantleDcCoefficient(A0, P0, A1, P1, NF, NK, 0.45)
    expect(dc).toBeGreaterThan(5.4)
    expect(dc).toBeLessThan(6.5)
  })

  // The rock octaves give the bedrock-only octaves their own falloff, so the
  // DC's weight series bends at nF. These pin the DEPENDENCY (the constant-dependency
  // rule), not the values.
  test('rock persistence feeds through to the DC', () => {
    const plain = mantleDcCoefficient(A0, P0, A1, P1, NF, NK, 0.45)
    const tamed = mantleDcCoefficient(A0, P0, A1, P1, NF, NK, 0.45, 0.50)
    expect(tamed).not.toBeCloseTo(plain, 3)
    // A rock falloff equal to the instance persistence must reproduce the plain
    // series exactly for that instance — the bend disappears.
    expect(mantleSigmaCoeff(A0, P0, NF, NK, 0.45, P0))
      .toBeCloseTo(mantleSigmaCoeff(A0, P0, NF, NK, 0.45), 10)
  })

  test('a steeper rock falloff shrinks the bedrock-only contribution', () => {
    let prev = Infinity
    for (const rp of [0.80, 0.60, 0.40, 0.20]) {
      const v = mantleSigmaCoeff(A0, P0, NF, NK, 1.0, rp)   // relief 1 ⇒ extra octaves only
      expect(v).toBeLessThan(prev)
      prev = v
    }
  })

  // The tameness criterion the rock falloff exists to satisfy: octave i contributes
  // gradient ∝ (p·lac)^i, so p·lac <= 1 stops added octaves from increasing
  // slope. Documents why the stock persistences need it.
  test('a rock persistence of 0.5 sits at or below 1/lacunarity; the stock persistences do not', () => {
    const ROCK_PERSIST = 0.50
    for (const lac of [1.8, 1.9]) expect(ROCK_PERSIST * lac).toBeLessThanOrEqual(1.0)
    // and the stock persistences do NOT — which is the bug it addresses
    expect(P0 * 1.8).toBeGreaterThan(1.0)
    expect(P1 * 1.9).toBeGreaterThan(1.0)
  })
})

describe('hNormFor', () => {
  test('scales with the amplitude sum by the one shared ratio', () => {
    expect(hNormFor(80, 70)).toBeCloseTo(150 * H_NORM_PER_AMP, 9)
    expect(hNormFor(160, 140)).toBeCloseTo(2 * hNormFor(80, 70), 9)
  })
  test('is floored at 1, so a flat terrain does not divide by zero', () => {
    expect(hNormFor(0, 0)).toBe(1)
  })
})
