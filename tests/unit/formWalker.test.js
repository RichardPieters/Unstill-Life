import { describe, test, expect, vi } from 'vitest'
import { FormWalker } from '../../src/drift/formWalker.js'
import { FORM_WALKER_PARAMS } from '../../src/drift/formWalkerParams.js'
import { removedNameHits } from './sourceScan.js'

describe('settings are params', () => {
  test('no removed settings method remains in src/ or tests/', () => {
    const names = ['setEnabled', 'getEnabled', 'setCalmSpread', 'getCalmSpread', 'setFollowRate', 'getFollowRate']
    expect(removedNameHits(['(?!)'], { receiver: '\\w*[wW]alker', names }, import.meta.url)).toEqual([])
  })
})

/** Deterministic seeded PRNG (mulberry32) — an independent stream per call, so
 *  two walkers each given their own instance never interleave/steal draws from
 *  each other the way two closures wrapping the SAME Math.random do: on a
 *  shared tick loop walker a's draw would consume the next value off the one
 *  global stream, so walker b's draw would get a different number even from
 *  identical state, and a comparison of the two would be flaky. */
function seededRandom(seed) {
  let s = seed >>> 0
  return () => {
    s |= 0; s = (s + 0x6D2B79F5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Minimal stand-in for the Dynamics EventTarget. */
function fakeDynamics() {
  const d = new EventTarget()
  d.tick    = dt => d.dispatchEvent(new CustomEvent('tick', { detail: { dt } }))
  return d
}

/**
 * @param {object} o
 * @param {() => number} [o.random]     injected RNG
 * @param {number}       [o.noiseSpeed] held constant for the run
 */
function makeWalker({ random, noiseSpeed = 1, start, cloudSpread = () => FORM_SPREAD, cloudRate = () => FORM_RATE } = {}) {
  const dynamics = fakeDynamics()
  const applied  = []
  const walker   = new FormWalker(dynamics, {
    apply: pos => applied.push(pos),
    noiseSpeed: () => noiseSpeed,
    random: random ?? (() => 0.5),
    cloudSpread,
    cloudRate,
    start,
  })
  return { dynamics, walker, applied }
}

const FORM_SPREAD = FORM_WALKER_PARAMS.find(r => r.key === 'calmSpread').value
const FORM_RATE = FORM_WALKER_PARAMS.find(r => r.key === 'followRate').value

const CHANNELS = ['ocean', 'mountains', 'snowline']

// ─── positions stay in range ──────────────────────────────────────────────────

describe('normalised output', () => {
  test('every channel stays within [0,1] across a long random walk', () => {
    const { dynamics, walker } = makeWalker()
    // Extremes gathered in the loop, asserted once — per-step expect() calls
    // are slow enough to time out on a busy machine.
    let lo = Infinity, hi = -Infinity
    for (let i = 0; i < 20000; i++) {
      dynamics.tick(1 / 60)
      const pos = walker.getPositions()
      for (const k of CHANNELS) { lo = Math.min(lo, pos[k]); hi = Math.max(hi, pos[k]) }
    }
    expect(lo).toBeGreaterThanOrEqual(0)
    expect(hi).toBeLessThanOrEqual(1)
  })

  test('a start position round-trips through the warp', () => {
    const start = { ocean: 0.45, mountains: 0.65, snowline: 0.8 }
    const { walker } = makeWalker({ start })
    const pos = walker.getPositions()
    for (const k of CHANNELS) expect(pos[k]).toBeCloseTo(start[k], 9)
  })
})

// ─── nothing may produce NaN ──────────────────────────────────────────────────
// A NaN latent silently propagates into every terrain uniform the walk writes,
// so the screen goes black with no error. Each case is a way one can arrive.

describe('NaN safety', () => {
  const finite = w => CHANNELS.every(k => Number.isFinite(w.getPositions()[k]))

  test.each([
    ['out of range below', { ocean: -0.5, mountains: 0.5, snowline: -0.2 }],
    ['out of range above', { ocean: 2, mountains: 0.5, snowline: 1.7 }],
    ['NaN seeds',          { ocean: NaN, mountains: NaN, snowline: NaN }],
    ['missing keys',       {}],
  ])('a %s start still yields finite positions', (_label, start) => {
    const { dynamics, walker } = makeWalker({ start, random: Math.random })
    expect(finite(walker)).toBe(true)
    for (let i = 0; i < 200; i++) dynamics.tick(1 / 60)
    expect(finite(walker)).toBe(true)
  })

  test('a tick with no dt is ignored rather than poisoning the walk', () => {
    const { dynamics, walker } = makeWalker()
    const before = walker.getPositions()
    dynamics.dispatchEvent(new CustomEvent('tick', { detail: {} }))
    expect(walker.getPositions()).toEqual(before)
    expect(finite(walker)).toBe(true)
  })
})

// ─── snapshot round-trip ──────────────────────────────────────────────────────

describe('snapshot state', () => {
  test('a restored walker resumes the same walk, not just the same position', () => {
    // Independent streams (not both wrapping Math.random) — two walkers pulling
    // from the same global generator would interleave draws and diverge for a
    // reason that has nothing to do with the code under test.
    const a = makeWalker({ random: seededRandom(1) })
    for (let i = 0; i < 300; i++) a.dynamics.tick(1 / 60)
    const saved = a.walker.exportState()

    const b = makeWalker({ random: seededRandom(2) })
    b.walker.importState(saved)
    expect(b.walker.getPositions()).toEqual(a.walker.getPositions())

    // The in-flight target has to come back too, or the two diverge on resume.
    for (let i = 0; i < 50; i++) { a.dynamics.tick(1 / 60); b.dynamics.tick(1 / 60) }
    expect(b.walker.getPositions()).toEqual(a.walker.getPositions())
  })

  test('the enabled flag round-trips', () => {
    const a = makeWalker()
    a.walker.params.set('enabled', false)
    const b = makeWalker()
    b.walker.importState(a.walker.exportState())
    expect(b.walker.params.get('enabled')).toBe(false)
  })

  test('the drift range and speed round-trip', () => {
    const a = makeWalker()
    a.walker.params.set('calmSpread', 0.4)
    a.walker.params.set('followRate', 0.07)
    const b = makeWalker()
    expect(b.walker.importState(a.walker.exportState()).unknown).toEqual([])
    expect(b.walker.params.get('calmSpread')).toBe(0.4)
    expect(b.walker.params.get('followRate')).toBe(0.07)
  })

  test('a snapshot without the drift settings leaves them alone', () => {
    const { walker } = makeWalker()
    walker.params.set('followRate', 0.07)
    walker.importState({ u: {}, target: {}, enabled: true })
    expect(walker.params.get('followRate')).toBe(0.07)
  })

  test('out-of-range snapshot latents are clamped into [0,1]', () => {
    const { walker } = makeWalker()
    walker.importState({ u: { ocean: 3, mountains: -2 }, target: { ocean: 5 } })
    const pos = walker.getPositions()
    expect(pos.ocean).toBe(1)
    expect(pos.mountains).toBe(0)
    expect(walker.exportState().target.ocean).toBe(1)
  })

  test('unrecognised keys are reported, not swallowed', () => {
    const { walker } = makeWalker()
    expect(walker.importState({ u: {}, nope: 1 }).unknown).toEqual(['formWalker.nope'])
  })
})

// ─── pacing ───────────────────────────────────────────────────────────────────

describe('drift speed tracks noiseSpeed', () => {
  /** Distance the ocean channel covers in `seconds`, target held far away. */
  const travelled = (noiseSpeed, seconds, rate) => {
    // random() = 1 puts every target at +calmSpread, so the walk always climbs.
    const { dynamics, walker } = makeWalker({ random: () => 1, noiseSpeed })
    walker.params.set('followRate', rate)
    const before = walker.getPositions().ocean
    for (let i = 0; i < Math.round(seconds * 60); i++) dynamics.tick(1 / 60)
    return walker.getPositions().ocean - before
  }

  test('double the noiseSpeed covers double the ground', () => {
    // Short window and a small rate so neither run saturates at 1.
    expect(travelled(2, 2, 0.01)).toBeCloseTo(2 * travelled(1, 2, 0.01), 6)
  })

  test('a zero follow rate freezes the drift entirely', () => {
    expect(travelled(1, 10, 0)).toBe(0)
  })

  test('a non-finite drift setting is ignored', () => {
    const { walker } = makeWalker()
    walker.params.set('calmSpread', NaN)
    walker.params.set('followRate', undefined)
    expect(Number.isFinite(walker.params.get('calmSpread'))).toBe(true)
    expect(Number.isFinite(walker.params.get('followRate'))).toBe(true)
  })

  test('a zero noiseSpeed freezes the drift entirely', () => {
    expect(travelled(0, 10, 0.05)).toBe(0)
  })

  test('nothing moves and nothing is applied while disabled', () => {
    const { dynamics, walker, applied } = makeWalker({ random: () => 1 })
    walker.params.set('enabled', false)
    const before = walker.getPositions()
    for (let i = 0; i < 600; i++) dynamics.tick(1 / 60)
    expect(walker.getPositions()).toEqual(before)
    expect(applied).toHaveLength(0)
  })
})

// ─── calm-period targets stay near where they were ────────────────────────────

describe('calm drift is local', () => {
  // NOTE the spread bounds each HOP, not the total excursion. The walk is a
  // reflected random walk, so given enough calm time it explores the whole
  // range whatever the spread — a small spread just gets there in more, smaller
  // steps.
  // Changing the spread does not yank the target already in flight, so the walk
  // finishes that one hop and only then freezes. `drift speed` 0 is the control
  // that stops it on the spot.
  test('zero spread pins the walk once its in-flight hop finishes', () => {
    const { dynamics, walker } = makeWalker({ random: Math.random })
    walker.params.set('calmSpread', 0)
    walker.params.set('followRate', 0.5)
    for (let i = 0; i < 200; i++) dynamics.tick(1 / 60)   // retire the stale target
    const form = () => Object.fromEntries(CHANNELS.map(k => [k, walker.getPositions()[k]]))
    const settled = form()
    for (let i = 0; i < 2000; i++) dynamics.tick(1 / 60)
    expect(form()).toEqual(settled)
  })

  test('a larger spread redraws its target less often', () => {
    // Counts REVERSALS, not movement — every tick moves, so counting movement
    // would compare 3000 against 3000 and pass against any implementation.
    const reversals = spread => {
      const { dynamics, walker } = makeWalker({ random: Math.random })
      walker.params.set('calmSpread', spread)
      walker.params.set('followRate', 0.05)
      dynamics.tick(1 / 60)
      let prev = walker.getPositions().ocean
      let dir = 0, n = 0
      for (let i = 0; i < 3000; i++) {
        dynamics.tick(1 / 60)
        const now = walker.getPositions().ocean
        const d = Math.sign(now - prev)
        if (d !== 0 && dir !== 0 && d !== dir) n++
        if (d !== 0) dir = d
        prev = now
      }
      return n
    }
    // Small hops are consumed in a tick or two, so the target is redrawn — and
    // the direction re-rolled — far more often than for long hauls.
    expect(reversals(0.02)).toBeGreaterThan(3 * reversals(0.5))
  })

  test('one hop never exceeds the spread', () => {
    const spread = 0.1
    const { dynamics, walker } = makeWalker({ random: Math.random })
    walker.params.set('calmSpread', spread)
    walker.params.set('followRate', 1e6)            // each tick completes a whole hop
    dynamics.tick(1 / 60)                // retire the target drawn at the old spread
    let prev = walker.getPositions().ocean
    for (let i = 0; i < 400; i++) {
      dynamics.tick(1 / 60)
      const now = walker.getPositions().ocean
      expect(Math.abs(now - prev)).toBeLessThanOrEqual(spread + 1e-9)
      prev = now
    }
  })

  test('the walk does not pile up on the ends', () => {
    // Reflection, not clamping. With clamping every overshoot lands exactly on
    // 0 or 1, so those two values alone take a large share of the samples.
    const { dynamics, walker } = makeWalker({ random: Math.random })
    walker.params.set('calmSpread', 0.4)
    walker.params.set('followRate', 1e6)
    let onEnd = 0
    const n = 20000
    for (let i = 0; i < n; i++) {
      dynamics.tick(1 / 60)
      const v = walker.getPositions().ocean
      if (v === 0 || v === 1) onEnd++
    }
    expect(onEnd / n).toBeLessThan(0.01)
  })
})

// ─── the snowline distribution ────────────────────────────────────────────────
// Ground truth is the two properties the bias was specified from, measured over
// the walk's actual output — not a re-evaluation of the warp formula.

describe('snowline favours the upper band', () => {
  /** Sample the settled snowline distribution over a long run. */
  const sample = () => {
    const { dynamics, walker } = makeWalker({ random: Math.random })
    walker.params.set('followRate', 0.5)
    const seen = []
    for (let i = 0; i < 40000; i++) {
      dynamics.tick(1 / 60)
      seen.push(walker.getPositions().snowline)
    }
    return seen
  }

  test('most of the time is spent between 0.6 and 1.0', () => {
    const seen = sample()
    const inBand = seen.filter(v => v >= 0.6).length / seen.length
    // Measured 78-80%; the design target for a uniform latent is 77%. Banded
    // either side so a real change in the bias is caught, but RNG noise is not.
    expect(inBand).toBeGreaterThan(0.70)
    expect(inBand).toBeLessThan(0.88)
  })

  test('low snowlines are rare but do occur', () => {
    const seen = sample()
    const low = seen.filter(v => v < 0.2).length / seen.length
    // Occupancy, not the target distribution: transit time near the folded ends
    // is short, so this measures ~0.1% rather than the 1% a uniform latent would
    // give. Pinned as a band — an upper bound alone would pass if the tail
    // vanished entirely, which is the failure that actually matters here.
    expect(low).toBeGreaterThan(0.0002)
    expect(low).toBeLessThan(0.01)
  })

  test('the form dials get no such bias — they stay roughly even', () => {
    const { dynamics, walker } = makeWalker({ random: Math.random })
    walker.params.set('followRate', 0.5)
    let high = 0, n = 0
    for (let i = 0; i < 40000; i++) {
      dynamics.tick(1 / 60)
      if (walker.getPositions().ocean >= 0.6) high++
      n++
    }
    // A uniform channel sits above 0.6 about 40% of the time; the snowline is
    // pushed past 60%. Asserted as a band, not a point, so RNG noise is fine.
    expect(high / n).toBeGreaterThan(0.25)
    expect(high / n).toBeLessThan(0.55)
  })
})

// ─── the aggregate cloud dials ────────────────────────────────────────────────
// They share the macro form's walk and its snapshot (see formWalker's
// CHANNELS), so what is worth pinning is that
// they are genuinely IN both — a channel that silently never walks looks
// identical to a walking one from the outside until a whole session goes by.

const CLOUD_CHANNELS = ['cloudScatter', 'cloudDensity']

describe('cloud dials ride the form walk', () => {
  test('are reported as positions, in range, and seeded from `start`', () => {
    const { walker } = makeWalker({ start: { cloudScatter: 0.2, cloudDensity: 0.9 } })
    const pos = walker.getPositions()
    expect(pos.cloudScatter).toBeCloseTo(0.2, 9)
    expect(pos.cloudDensity).toBeCloseTo(0.9, 9)
  })

  test('walk on a tick like every other channel', () => {
    const { dynamics, walker } = makeWalker({
      random: seededRandom(7), start: { cloudScatter: 0.5, cloudDensity: 0.5 },
    })
    const before = walker.getPositions()
    for (let i = 0; i < 40; i++) dynamics.tick(1 / 60)
    const after = walker.getPositions()
    for (const k of CLOUD_CHANNELS) expect(after[k]).not.toBeCloseTo(before[k], 6)
  })

  test('stay inside [0,1] across a long walk, so no mapping ever extrapolates', () => {
    const { dynamics, walker } = makeWalker({ random: seededRandom(11) })
    for (let i = 0; i < 20000; i++) {
      dynamics.tick(1 / 60)
      const pos = walker.getPositions()
      for (const k of CLOUD_CHANNELS) {
        expect(pos[k]).toBeGreaterThanOrEqual(0)
        expect(pos[k]).toBeLessThanOrEqual(1)
      }
    }
  })

  test('round-trip through a snapshot', () => {
    const { dynamics, walker } = makeWalker({ random: seededRandom(5) })
    for (let i = 0; i < 100; i++) dynamics.tick(1 / 60)
    const state = walker.exportState()

    const { walker: restored } = makeWalker({ random: seededRandom(99) })
    const report = restored.importState(state)
    expect(report.unknown).toEqual([])
    for (const k of CLOUD_CHANNELS) {
      expect(restored.getPositions()[k]).toBeCloseTo(walker.getPositions()[k], 12)
    }
  })

  test('a snapshot carrying only the three form channels leaves these finite, not NaN', () => {
    // importState must not write undefined into a latent the snapshot lacks —
    // a NaN here reaches uBaseFreq and takes the whole baked volume with it.
    const { walker } = makeWalker()
    walker.importState({ u: { ocean: 0.4, mountains: 0.4, snowline: 0.7 }, target: {}, enabled: true })
    for (const k of CLOUD_CHANNELS) expect(Number.isFinite(walker.getPositions()[k])).toBe(true)
  })

  // The dials ride the walk and snapshot with the form, but their
  // calm-period pace answers to the weather's own spread/rate (main.js points
  // `cloudSpread`/`cloudRate` at atmosphere.js's), not this walker's own
  // "Form drift" calmSpread/followRate — see GROUPS in formWalker's header.
  describe('the cloud group rides its own spread/rate, not the form group\'s', () => {
    test('a zero form followRate freezes the form but not the clouds', () => {
      const { dynamics, walker } = makeWalker({
        random: seededRandom(13), cloudRate: () => 0.05,
      })
      walker.params.set('followRate', 0)
      const before = walker.getPositions()
      for (let i = 0; i < 40; i++) dynamics.tick(1 / 60)
      const after = walker.getPositions()
      for (const k of CHANNELS) expect(after[k]).toBeCloseTo(before[k], 12)
      for (const k of CLOUD_CHANNELS) expect(after[k]).not.toBeCloseTo(before[k], 6)
    })

    test('a zero cloud rate freezes the clouds but not the form', () => {
      const { dynamics, walker } = makeWalker({
        random: seededRandom(17), cloudRate: () => 0,
      })
      const before = walker.getPositions()
      for (let i = 0; i < 40; i++) dynamics.tick(1 / 60)
      const after = walker.getPositions()
      for (const k of CLOUD_CHANNELS) expect(after[k]).toBeCloseTo(before[k], 12)
      for (const k of CHANNELS) expect(after[k]).not.toBeCloseTo(before[k], 6)
    })
  })
})
