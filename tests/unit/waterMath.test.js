import { describe, test, expect } from 'vitest'
import {
  seaLevelStep, rippleAdvance, foamWidthForMomentum, sparkleForMomentum,
  availableDepth, depthShare, TERRAIN_MIN_PER_AMP,
} from '../../src/water/waterMath.js'

describe('seaLevelStep', () => {
  test('calm (restlessness 1) targets the low level', () => {
    // target = low; from low it stays put
    expect(seaLevelStep(-14, -14, 6, 1.0, 0.02)).toBeCloseTo(-14)
  })
  test('fully settled (restlessness 0) targets the high level', () => {
    // target = high = 6; one 0.02 step from -14 toward 6
    expect(seaLevelStep(-14, -14, 6, 0.0, 0.02)).toBeCloseTo(-14 + (6 - -14) * 0.02)
  })
  test('converges to target under repetition', () => {
    let s = -14
    for (let i = 0; i < 5000; i++) s = seaLevelStep(s, -14, 6, 0.0, 0.02)
    expect(s).toBeCloseTo(6, 1)
  })
  test('moves a fraction of the gap, never overshoots in one step', () => {
    const next = seaLevelStep(0, -14, 6, 0.5, 0.02) // target = -4
    expect(next).toBeGreaterThan(-4)   // between current(0) and target(-4)
    expect(next).toBeLessThan(0)
  })
})

describe('rippleAdvance', () => {
  test('advances by dt·speed, speed lerps with momentum', () => {
    // momentum 0 → speedMin
    expect(rippleAdvance(0, 1, 0, 0.4, 1.8)).toBeCloseTo(0.4)
    // momentum 1 → speedMax
    expect(rippleAdvance(0, 1, 1, 0.4, 1.8)).toBeCloseTo(1.8)
    // momentum 0.5 → midpoint
    expect(rippleAdvance(10, 2, 0.5, 0.4, 1.8)).toBeCloseTo(10 + 2 * 1.1)
  })
  test('monotonic — time only moves forward for dt>0', () => {
    expect(rippleAdvance(5, 0.016, 0, 0.4, 1.8)).toBeGreaterThan(5)
  })
})

describe('foamWidthForMomentum', () => {
  test('scales base between the lo/hi factors', () => {
    expect(foamWidthForMomentum(15, 0, 0.6, 1.5)).toBeCloseTo(9)    // 15·0.6
    expect(foamWidthForMomentum(15, 1, 0.6, 1.5)).toBeCloseTo(22.5) // 15·1.5
  })
})

describe('sparkleForMomentum', () => {
  test('tightens as momentum rises', () => {
    expect(sparkleForMomentum(0.15, 0, 0.10)).toBeCloseTo(0.15)
    expect(sparkleForMomentum(0.15, 0.5, 0.10)).toBeCloseTo(0.10)
  })
  test('floored so it never reaches zero', () => {
    expect(sparkleForMomentum(0.05, 1.0, 0.10)).toBe(0.02) // 0.05-0.10 = -0.05 → floor
  })
})

describe('availableDepth and depthShare', () => {
  test('the depth available grows with the sea level and with the amplitude', () => {
    expect(availableDepth(200, 10)).toBeGreaterThan(availableDepth(200, 0))
    expect(availableDepth(300, 0)).toBeGreaterThan(availableDepth(200, 0))
  })
  test('the depth is the sea level above the estimated seabed, floored at 1', () => {
    expect(availableDepth(100, 5)).toBeCloseTo(5 + TERRAIN_MIN_PER_AMP * 100)
    expect(availableDepth(0, -20)).toBe(1)
    expect(availableDepth(-50, 0)).toBe(1)
  })
  test('a share is that fraction of the available depth', () => {
    expect(depthShare(0.5, 100, 5)).toBeCloseTo(0.5 * availableDepth(100, 5))
    expect(depthShare(0, 100, 5)).toBe(0)
  })
})
