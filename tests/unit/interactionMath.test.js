import { describe, test, expect } from 'vitest'
import {
  byteWaveformLevel, rmsToDbfs, spectralFlux, fractionOfSpan, emaStep,
  restlessnessToAttention, sanitiseAttention,
  predictedMicRms, excessDb, unexplainedFraction, dbfsToRms, valueAt,
} from '../../src/interaction/interactionMath.js'

describe('byteWaveformLevel', () => {
  test('silence (every byte at 128) is 0', () => {
    expect(byteWaveformLevel(new Uint8Array(64).fill(128))).toEqual({ rms: 0, peak: 0 })
  })
  test('a ±64 square wave has RMS and peak 0.5', () => {
    const buf = Uint8Array.from({ length: 64 }, (_, k) => (k % 2 ? 192 : 64))
    expect(byteWaveformLevel(buf)).toEqual({ rms: 0.5, peak: 0.5 })
  })
  test('one full-scale sample among four: peak 1, RMS sqrt(1/4)', () => {
    const { rms, peak } = byteWaveformLevel(Uint8Array.of(128, 0, 128, 128))
    expect(peak).toBe(1)
    expect(rms).toBeCloseTo(0.5, 12)
  })
})

describe('rmsToDbfs', () => {
  test('matches the textbook dBFS formula', () => {
    expect(rmsToDbfs(0.5)).toBeCloseTo(20 * Math.log10(0.5), 6)
  })
  test('rms=0 stays finite (floored, not -Infinity)', () => {
    expect(Number.isFinite(rmsToDbfs(0))).toBe(true)
  })
})

describe('spectralFlux', () => {
  test('identical spectra → 0 (a stationary drone is invisible to it)', () => {
    const mags = [0.1, 0.4, 0.2, 0.9]
    expect(spectralFlux(mags, mags)).toBe(0)
  })
  test('ignores bins that fell', () => {
    expect(spectralFlux([0.1, 0.2], [0.5, 0.1])).toBeCloseTo((0 + 0.1) / 2, 6)
  })
})

describe('fractionOfSpan', () => {
  test('exact at both endpoints', () => {
    expect(fractionOfSpan(0, 30)).toBe(0)
    expect(fractionOfSpan(30, 30)).toBe(1)
  })
  test('clamped beyond the span', () => {
    expect(fractionOfSpan(-20, 30)).toBe(0)
    expect(fractionOfSpan(50, 30)).toBe(1)
  })
})

describe('emaStep', () => {
  test('frame-rate invariant: one 1.0s step ≈ ten 0.1s steps', () => {
    const oneStep = emaStep(0, 1, 1.0, 2.0)
    let tenSteps = 0
    for (let i = 0; i < 10; i++) tenSteps = emaStep(tenSteps, 1, 0.1, 2.0)
    expect(tenSteps).toBeCloseTo(oneStep, 6)
  })
  test('tau=0 snaps straight to target', () => {
    expect(emaStep(0, 1, 0.016, 0)).toBe(1)
  })
})

describe('restlessnessToAttention', () => {
  test('monotone decreasing for any curve > 0', () => {
    for (const curve of [0.3, 1, 3]) {
      expect(restlessnessToAttention(0, curve)).toBeGreaterThan(restlessnessToAttention(0.5, curve))
      expect(restlessnessToAttention(0.5, curve)).toBeGreaterThan(restlessnessToAttention(1, curve))
    }
  })
  test('endpoints exact', () => {
    expect(restlessnessToAttention(0, 2)).toBe(1)
    expect(restlessnessToAttention(1, 2)).toBe(0)
  })
})

describe('sanitiseAttention', () => {
  test('passes through in-range values', () => {
    expect(sanitiseAttention(0.7)).toBe(0.7)
  })
  test.each([NaN, Infinity, -Infinity])('falls back to 0.5 on %s', v => {
    expect(sanitiseAttention(v)).toBe(0.5)
  })
  test('clamps out-of-range finite values', () => {
    expect(sanitiseAttention(1.5)).toBe(1)
    expect(sanitiseAttention(-0.2)).toBe(0)
  })
})

describe('self-noise helpers', () => {
  test('predictedMicRms is the measured linear law', () => {
    expect(predictedMicRms(0.01, 1.8, 0.0047)).toBeCloseTo(0.0227, 12)
    expect(predictedMicRms(0, 1.8, 0.0047)).toBe(0.0047)          // silent sim → just the quiet room
  })
  test('excessDb: 0 at the prediction, +20 dB at 10× it', () => {
    expect(excessDb(0.02, 0.02)).toBeCloseTo(0, 12)
    expect(excessDb(0.2, 0.02)).toBeCloseTo(20, 9)
    expect(excessDb(0.002, 0.02)).toBeCloseTo(-20, 9)
  })
  test('unexplainedFraction: 0 at/below the prediction, 0.5 at 2×, → 1 far above', () => {
    expect(unexplainedFraction(0.02, 0.02)).toBe(0)
    expect(unexplainedFraction(0.01, 0.02)).toBe(0)              // clamped, never negative
    expect(unexplainedFraction(0.04, 0.02)).toBeCloseTo(0.5, 12)
    expect(unexplainedFraction(20, 0.02)).toBeGreaterThan(0.99)
  })
  test('dbfsToRms inverts rmsToDbfs', () => {
    for (const r of [0.001, 0.05, 0.7]) expect(dbfsToRms(rmsToDbfs(r))).toBeCloseTo(r, 12)
  })
  test('valueAt holds the latest entry at or before t, and the oldest before them all', () => {
    const h = [{ t: 1, v: 10 }, { t: 2, v: 20 }, { t: 3, v: 30 }]
    expect(valueAt(h, 2.5)).toBe(20)
    expect(valueAt(h, 3)).toBe(30)
    expect(valueAt(h, 0)).toBe(10)
    expect(valueAt([], 5)).toBe(0)
  })
})
