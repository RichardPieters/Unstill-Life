import { describe, test, expect } from 'vitest'
import { quantile, frameStats, costSchedule, pairedCost } from '../../src/panel/perfMath.js'
import { CostMeasure } from '../../src/panel/costMeasure.js'

describe('quantile / frameStats', () => {
  test('median and p95 of a known list', () => {
    const ms = Array.from({ length: 101 }, (_, i) => i)   // 0..100
    expect(quantile(ms, 0.5)).toBe(50)
    expect(quantile(ms, 0.95)).toBe(95)
  })
  test('one hitch moves p95, not the typical frame', () => {
    const ms = [...Array(40).fill(20), ...Array(3).fill(200)]
    const s = frameStats(ms)
    expect(s.median).toBe(20)
    expect(s.fps).toBe(50)
    expect(s.p95).toBe(200)
  })
  test('empty input gives NaN, not a crash', () => {
    expect(frameStats([]).median).toBeNaN()
  })
})

describe('costSchedule', () => {
  test('every part gets as many part-off windows as base windows', () => {
    const s = costSchedule(['a', 'b'], 4)
    for (const p of ['a', 'b']) {
      expect(s.filter(w => w.part === p && w.off)).toHaveLength(4)
      expect(s.filter(w => w.part === p && !w.off)).toHaveLength(4)
    }
  })
  test('the order inside a pair alternates, so linear drift cancels', () => {
    const s = costSchedule(['a'], 4)
    const firsts = [0, 2, 4, 6].map(i => s[i].off)
    expect(firsts).toEqual([false, true, false, true])
  })
})

describe('pairedCost', () => {
  test('a slow drift common to both windows of a pair cancels', () => {
    // Drift adds 0, 10, 20, 30 ms to both windows; the part costs 5 ms.
    const base = [40, 50, 60, 70], variant = [35, 45, 55, 65]
    expect(pairedCost(base, variant).ms).toBe(5)
  })
})

// Ground truth is SYNTHETIC, not a re-derivation: fake parts that each add a
// known number of ms to every frame while switched on, plus a drift that grows
// with every frame. The run must recover each known cost.
describe('CostMeasure', () => {
  function simulate(costs, { drift = 0 } = {}) {
    const on = Object.fromEntries(Object.keys(costs).map(k => [k, true]))
    const parts = Object.keys(costs).map(name => ({ name, off: () => { on[name] = false }, on: () => { on[name] = true } }))
    const m = new CostMeasure({ settleFrames: 2, windowFrames: 6, pairs: 4 })
    m.start(parts)
    let frame = 0, ms = 0
    while (m.active && frame < 10000) {
      m.onFrame(ms)
      // The frame just drawn, with the parts as they are NOW.
      ms = 10 + drift * frame + Object.entries(costs).reduce((s, [k, c]) => s + (on[k] ? c : 0), 0)
      frame++
    }
    return { m, on }
  }

  test('recovers each part\'s known cost', () => {
    const { m } = simulate({ clouds: 7, forest: 21, reflection: 0 })
    const got = Object.fromEntries(m.results.map(r => [r.name, r.ms]))
    expect(got.clouds).toBeCloseTo(7, 6)
    expect(got.forest).toBeCloseTo(21, 6)
    expect(got.reflection).toBeCloseTo(0, 6)
  })

  test('recovers it under a steady drift too', () => {
    const { m } = simulate({ clouds: 7, forest: 21 }, { drift: 0.05 })
    for (const r of m.results) expect(Math.abs(r.ms - (r.name === 'clouds' ? 7 : 21))).toBeLessThan(1)
  })

  test('leaves every part switched back on when it finishes', () => {
    const { m, on } = simulate({ clouds: 7, forest: 21 })
    expect(m.active).toBe(false)
    expect(Object.values(on).every(Boolean)).toBe(true)
  })

  test('cancel mid-run switches the part being measured back on', () => {
    let isOn = true
    const m = new CostMeasure({ settleFrames: 0, windowFrames: 1, pairs: 2 })
    m.start([{ name: 'a', off: () => { isOn = false }, on: () => { isOn = true } }])
    m.onFrame(10)          // window 1 (base) done → window 2 switches 'a' off
    expect(isOn).toBe(false)
    m.cancel()
    expect(isOn).toBe(true)
    expect(m.active).toBe(false)
  })
})
