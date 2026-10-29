import { describe, test, expect } from 'vitest'
import { reflect01, drawNearby, advance } from '../../src/drift/walkMath.js'

/** Deterministic seeded PRNG (mulberry32), one independent stream per call. */
function seededRandom(seed) {
  let s = seed >>> 0
  return () => {
    s |= 0; s = (s + 0x6D2B79F5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('reflect01', () => {
  test('leaves the interior alone', () => {
    for (const v of [0, 0.3, 0.5, 1]) expect(reflect01(v)).toBeCloseTo(v, 12)
  })

  test('folds overshoot back instead of clamping', () => {
    // The whole point: clamping would map BOTH of these onto the endpoints and
    // hand 0 and 1 a standing share of the walk's time.
    expect(reflect01(-0.2)).toBeCloseTo(0.2, 12)
    expect(reflect01(1.3)).toBeCloseTo(0.7, 12)
  })

  test('a NaN latent cannot propagate into the uniforms', () => {
    expect(reflect01(NaN)).toBe(0.5)
    expect(reflect01(Infinity)).toBe(0.5)
  })
})

describe('drawNearby', () => {
  test('stays inside [0,1] for every draw, from every start, at full spread', () => {
    const rnd = seededRandom(7)
    for (let i = 0; i < 2000; i++) {
      const u = (i % 101) / 100
      const v = drawNearby(u, 1, rnd)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(1)
    }
  })

  test('respects the spread before reflection', () => {
    // random()=1 is the largest hop up; spread 0.1 from 0.5 can reach 0.6.
    expect(drawNearby(0.5, 0.1, () => 1)).toBeCloseTo(0.6, 12)
    expect(drawNearby(0.5, 0.1, () => 0)).toBeCloseTo(0.4, 12)
  })

  test('zero spread never moves', () => {
    expect(drawNearby(0.42, 0, seededRandom(1))).toBeCloseTo(0.42, 12)
  })

  test('a negative spread acts as zero; a NaN latent comes back inside the range', () => {
    expect(drawNearby(0.42, -0.3, () => 1)).toBeCloseTo(0.42, 12)
    expect(drawNearby(NaN, 0.25, () => 1)).toBe(0.5)
    expect(drawNearby(0.42, NaN, () => 1)).toBeCloseTo(0.42, 12)
  })
})

describe('advance', () => {
  test('steps toward the target without overshooting it', () => {
    const r = advance(0.2, 0.5, 0.1, 0.25, () => 0.5)
    expect(r.u).toBeCloseTo(0.3, 12)
    expect(r.target).toBeCloseTo(0.5, 12)   // not yet arrived, target unchanged
    expect(r.moved).toBe(true)
  })

  test('lands exactly on the target and redraws rather than oscillating', () => {
    // random()=0.9 so the redraw genuinely hops (0.5 would give a zero hop and
    // a "new" target identical to the old one, which proves nothing).
    const r = advance(0.48, 0.5, 0.1, 0.25, () => 0.9)
    expect(r.u).toBeCloseTo(0.5, 12)
    expect(r.target).not.toBeCloseTo(0.5, 12)
    expect(r.moved).toBe(true)
  })

  test('a non-positive or NaN step reports no movement', () => {
    for (const step of [0, -1, NaN]) {
      const r = advance(0.2, 0.5, step, 0.25, () => 0.5)
      expect(r.u).toBe(0.2)
      expect(r.moved).toBe(false)
    }
  })

  test('walks the whole range over time and never leaves it', () => {
    const rnd = seededRandom(99)
    let u = 0.3, target = drawNearby(u, 0.25, rnd)
    // min/max gathered in the loop and asserted once: 400k expect() calls are
    // slow enough to time out on a busy machine.
    let lo = 1, hi = 0
    for (let i = 0; i < 200000; i++) {
      const r = advance(u, target, 0.002, 0.25, rnd)
      u = r.u; target = r.target
      lo = Math.min(lo, u); hi = Math.max(hi, u)
    }
    expect(lo).toBeGreaterThanOrEqual(0)
    expect(hi).toBeLessThanOrEqual(1)
    // A walk that cannot reach both ends is a walk with a preferred region,
    // which is exactly what reflection (rather than clamping) exists to avoid.
    expect(lo).toBeLessThan(0.1)
    expect(hi).toBeGreaterThan(0.9)
  })
})
