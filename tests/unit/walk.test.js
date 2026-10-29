import { describe, test, expect } from 'vitest'
import { Walk } from '../../src/drift/walk.js'

const SNOW = { key: 'snow', warp: u => u ** 0.35, unwarp: p => p ** (1 / 0.35) }

/** random() returns the queued values in order, then 0.5. */
const queue = (...vs) => () => (vs.length ? vs.shift() : 0.5)

const make = (opts = {}) => new Walk({
  channels: [{ key: 'a' }, SNOW],
  spreadOf: () => 0.25,
  random: queue(),
  ...opts,
})

describe('seed', () => {
  test('a warped channel reads back the seeded position', () => {
    const w = make()
    w.seed('snow', 0.7)
    expect(w.position('snow')).toBeCloseTo(0.7, 12)
    expect(w.latent('snow')).toBeCloseTo(0.7 ** (1 / 0.35), 12)
  })

  test('clamps before the inverse warp, so a negative position is not NaN', () => {
    const w = make()
    w.seed('snow', -0.4)
    expect(w.latent('snow')).toBe(0)
    w.seed('snow', 3)
    expect(w.position('snow')).toBeCloseTo(1, 12)
  })

  test('a non-finite position starts at 0.5', () => {
    const w = make()
    for (const bad of [NaN, undefined, Infinity]) {
      w.seed('a', bad)
      expect(w.position('a')).toBe(0.5)
    }
  })

  test('the target is drawn within the spread of the latent', () => {
    const w = make({ random: queue(1) })
    w.seed('a', 0.5)
    expect(w.exportState().target.a).toBeCloseTo(0.75, 12)
  })

  test('unseeded channels rest at 0.5', () => {
    expect(make().positions()).toEqual({ a: 0.5, snow: 0.5 ** 0.35 })
  })
})

describe('step', () => {
  test('moves one fixed step toward the target and reports it', () => {
    const w = make({ random: queue(1) })
    w.seed('a', 0.5)                       // target 0.75
    expect(w.step('a', 0.1)).toBe(true)
    expect(w.position('a')).toBeCloseTo(0.6, 12)
  })

  test('redraws the target on arrival', () => {
    const w = make({ random: queue(1, 0) })
    w.seed('a', 0.5)                       // target 0.75
    w.step('a', 0.3)                       // arrives, next hop -0.25
    expect(w.position('a')).toBeCloseTo(0.75, 12)
    expect(w.exportState().target.a).toBeCloseTo(0.5, 12)
  })

  test('a non-positive or NaN step leaves the channel alone', () => {
    const w = make({ random: queue(1) })
    w.seed('a', 0.5)
    const before = w.exportState()
    for (const s of [0, -1, NaN]) expect(w.step('a', s)).toBe(false)
    expect(w.exportState()).toEqual(before)
  })

  test('only the stepped channel moves', () => {
    const w = make({ random: queue(1, 1) })
    w.seed('a', 0.5); w.seed('snow', 0.5)
    w.step('a', 0.1)
    expect(w.position('snow')).toBeCloseTo(0.5, 12)
  })
})

describe('setPosition', () => {
  test('reflects an out-of-range value instead of clamping', () => {
    const w = make()
    w.setPosition('a', 1.3)
    expect(w.position('a')).toBeCloseTo(0.7, 12)
    w.setPosition('a', -0.2)
    expect(w.position('a')).toBeCloseTo(0.2, 12)
  })

  test('a non-finite value reads as 0.5', () => {
    const w = make()
    w.setPosition('a', NaN)
    expect(w.position('a')).toBe(0.5)
  })

  test('redraws the target from the new position', () => {
    const w = make({ random: queue(1) })
    w.setPosition('a', 0.2)
    expect(w.exportState().target.a).toBeCloseTo(0.45, 12)
  })
})

describe('import / export', () => {
  test('import clamps latents and targets', () => {
    const w = make()
    w.importState({ u: { a: 3, snow: -2 }, target: { a: -1, snow: 9 } })
    expect(w.exportState()).toEqual({ u: { a: 1, snow: 0 }, target: { a: 0, snow: 1 } })
  })

  test('import ignores non-finite and missing entries', () => {
    const w = make()
    w.importState({ u: { a: 0.2, snow: NaN }, target: { a: 0.9 } })
    expect(w.exportState()).toEqual({ u: { a: 0.2, snow: 0.5 }, target: { a: 0.9, snow: 0.5 } })
    expect(() => w.importState()).not.toThrow()
  })

  test('export then import round-trips', () => {
    const a = make({ random: queue(0.9, 0.1) })
    a.seed('a', 0.3); a.seed('snow', 0.8)
    a.step('a', 0.05)
    const b = make()
    b.importState(a.exportState())
    expect(b.exportState()).toEqual(a.exportState())
    expect(b.positions()).toEqual(a.positions())
  })

  test('the export is a copy', () => {
    const w = make()
    w.exportState().u.a = 0.9
    expect(w.position('a')).toBe(0.5)
  })
})
