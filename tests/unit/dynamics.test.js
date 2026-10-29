import { describe, test, expect, vi } from 'vitest'
import { Dynamics } from '../../src/dynamics/dynamics.js'

/** A running (unfrozen) instance — the shape most of these tests drive. A bare
 *  `new Dynamics()` starts frozen as a held painting. */
const running = (o = {}) => new Dynamics({ momentum: 0.5, restlessness: 1, ...o })

// ─── Constructor / initial state ─────────────────────────────────────────────

describe('constructor', () => {
  test('defaults to the held painting: frozen at restlessness 0', () => {
    const d = new Dynamics()
    expect(d.momentum).toBe(0)
    expect(d.restlessness).toBe(0)
    expect(d.noiseTime).toBe(6)
    expect(d.isFrozen()).toBe(true)
  })

  test('a positive restlessness constructs a running instance', () => {
    expect(new Dynamics({ restlessness: 1 }).isFrozen()).toBe(false)
  })

  test('accepts partial initial state, still starting frozen', () => {
    const d = new Dynamics({ momentum: 0.2 })
    expect(d.momentum).toBe(0.2)
    expect(d.restlessness).toBe(0)
    expect(d.isFrozen()).toBe(true)
  })

  test('accepts full initial state', () => {
    const d = new Dynamics({ momentum: 0.3, restlessness: 0.7, noiseTime: 42.0 })
    expect(d.momentum).toBe(0.3)
    expect(d.restlessness).toBe(0.7)
    expect(d.noiseTime).toBe(42.0)
  })
})

// ─── Held start ──────────────────────────────────────────────────────────────

describe('held start', () => {
  test('a default instance holds under high attention: no tick, no state change', () => {
    const d = new Dynamics()
    const tick = vi.fn()
    d.addEventListener('tick', tick)
    d.update(1 / 60, 1.0)
    expect(tick).not.toHaveBeenCalled()
    expect(d.restlessness).toBe(0)
    expect(d.noiseTime).toBe(6)
    expect(d.isFrozen()).toBe(true)
  })

  test('attention dropping below the threshold unfreezes it once and ticks', () => {
    const d = new Dynamics()
    const unfreeze = vi.fn(), tick = vi.fn()
    d.addEventListener('unfreeze', unfreeze)
    d.addEventListener('tick', tick)
    d.update(1 / 60, 0.0)
    expect(unfreeze).toHaveBeenCalledOnce()
    expect(tick).toHaveBeenCalledOnce()
    expect(d.isFrozen()).toBe(false)
  })
})

describe('wake', () => {
  test('a frozen instance returns to full restlessness, running, and fires unfreeze once', () => {
    const d = new Dynamics()
    const unfreeze = vi.fn(), tick = vi.fn()
    d.addEventListener('unfreeze', unfreeze)
    d.wake()
    expect(d.restlessness).toBe(1)
    expect(d.isFrozen()).toBe(false)
    expect(unfreeze).toHaveBeenCalledOnce()
    d.addEventListener('tick', tick)
    d.update(1 / 60, 1.0)
    expect(tick).toHaveBeenCalledOnce()
  })

  test('a running instance only gets its restlessness back to 1, no event', () => {
    const d = running({ restlessness: 0.4 })
    const unfreeze = vi.fn()
    d.addEventListener('unfreeze', unfreeze)
    d.wake()
    expect(d.restlessness).toBe(1)
    expect(unfreeze).not.toHaveBeenCalled()
  })
})

describe('snapshot state', () => {
  test('round-trips the three settings and noiseTime', () => {
    const a = running({ noiseTime: 123.5 })
    a.params.set('momentumTau', 3)
    a.params.set('settleIntervalAtMaxAttention', 40)
    a.params.set('unfreezeAttention', 0.7)
    const b = new Dynamics()
    b.importState(a.exportState())
    expect(b.params.get('momentumTau')).toBe(3)
    expect(b.params.get('settleIntervalAtMaxAttention')).toBe(40)
    expect(b.params.get('unfreezeAttention')).toBe(0.7)
    expect(b.noiseTime).toBe(123.5)
  })

  test('a snapshot without noiseTime leaves the live value alone', () => {
    const d = running({ noiseTime: 9 })
    d.importState({ momentumTau: 2 })
    expect(d.noiseTime).toBe(9)
  })
})

describe('broadcastState', () => {
  test('dispatches exactly one dt=0 tick carrying the current state, and changes nothing', () => {
    const d = new Dynamics({ momentum: 0.3, noiseTime: 9 })
    const ticks = [], other = vi.fn()
    d.addEventListener('tick', e => ticks.push(e.detail))
    d.addEventListener('freeze', other)
    d.addEventListener('unfreeze', other)
    d.broadcastState()
    expect(ticks).toEqual([{ dt: 0, momentum: 0.3, restlessness: 0, noiseTime: 9 }])
    expect(other).not.toHaveBeenCalled()
    expect(d.momentum).toBe(0.3)
    expect(d.restlessness).toBe(0)
    expect(d.noiseTime).toBe(9)
    expect(d.isFrozen()).toBe(true)
  })
})

// ─── tick event ──────────────────────────────────────────────────────────────

describe('tick event', () => {
  test('dispatched on every update call', () => {
    const d = running()
    const handler = vi.fn()
    d.addEventListener('tick', handler)
    d.update(0.016, 0.5)
    expect(handler).toHaveBeenCalledOnce()
  })

  test('payload contains momentum, restlessness, noiseTime', () => {
    const d = running()
    let payload
    d.addEventListener('tick', e => { payload = e.detail })
    d.update(0.016, 0.5)
    expect(payload).toMatchObject({
      momentum:     expect.any(Number),
      restlessness: expect.any(Number),
      noiseTime:    expect.any(Number),
    })
  })

  test('noiseTime in payload matches instance noiseTime after update', () => {
    const d = running()
    let payload
    d.addEventListener('tick', e => { payload = e.detail })
    d.update(0.016, 0.5)
    expect(payload.noiseTime).toBe(d.noiseTime)
  })
})

// ─── noiseTime advancement ────────────────────────────────────────────────────

describe('noiseTime', () => {
  test('advances each frame', () => {
    const d = running({ noiseTime: 0 })
    d.update(0.016, 0.5)
    expect(d.noiseTime).toBeGreaterThan(0)
  })

  test('advances proportional to dt', () => {
    const d1 = running({ noiseTime: 0 })
    const d2 = running({ noiseTime: 0 })
    d1.update(0.016, 0.5)
    d2.update(0.032, 0.5) // double dt
    expect(d2.noiseTime).toBeCloseTo(d1.noiseTime * 2, 5)
  })

  test('noiseSpeed is higher at high momentum than low momentum (D6: derived from momentum)', () => {
    // noiseSpeed is computed from momentum each frame, not set externally.
    const dLow  = running({ momentum: 0.0, noiseTime: 0 })
    const dHigh = running({ momentum: 1.0, noiseTime: 0 })
    dLow.update(0.016, 0.5)   // neutral attention keeps momentum roughly stable
    dHigh.update(0.016, 0.5)
    expect(dHigh.noiseTime).toBeGreaterThan(dLow.noiseTime)
  })
})

// ─── momentum ─────────────────────────────────────────────────────────────────
// These tests pin the momentum rule: attention charges or discharges momentum,
// and momentum drives the settle.

describe('momentum (D6)', () => {
  test('full attention (1.0) discharges momentum — high engagement drives the settle toward freezing', () => {
    const d = running({ momentum: 0.5 })
    d.update(0.016, 1.0)
    expect(d.momentum).toBeLessThan(0.5)
  })

  test('zero attention (0.0 = calm/empty) charges momentum — restlessness held', () => {
    const d = running({ momentum: 0.5 })
    d.update(0.016, 0.0)
    expect(d.momentum).toBeGreaterThan(0.5)
  })

  test('attentionLevel 0.5 targets momentum 0.5 — already there, so it stays', () => {
    const d = running({ momentum: 0.5 })
    d.update(0.016, 0.5)
    expect(d.momentum).toBeCloseTo(0.5, 3)
  })

  test('momentum clamped to [0, 1]', () => {
    const dMax = running({ momentum: 1.0 })
    dMax.update(0.016, 1.0)
    expect(dMax.momentum).toBeLessThanOrEqual(1.0)

    const dMin = running({ momentum: 0.0 })
    dMin.update(0.016, 0.0)
    expect(dMin.momentum).toBeGreaterThanOrEqual(0.0)
  })

  test('out-of-range attention (a bad sensor reading) is clamped, not passed through', () => {
    const d = running({ momentum: 0.5 })
    d.update(0.016, 1.5)
    expect(d.momentum).toBeGreaterThanOrEqual(0)
    expect(d.momentum).toBeLessThanOrEqual(1)
    expect(d.noiseSpeed).toBeGreaterThanOrEqual(0)
  })

  test('NaN attention falls back to neutral (0.5) rather than poisoning state', () => {
    const d = running({ momentum: 0.5 })
    d.update(0.016, NaN)
    expect(Number.isNaN(d.momentum)).toBe(false)
    expect(Number.isNaN(d.noiseSpeed)).toBe(false)
    expect(Number.isNaN(d.noiseTime)).toBe(false)
  })
})

// ─── momentum as a level, not a rate ─────────────────────────────────────────
// The contract that replaced the integrator. Ground truth is `1 - attention`
// derived from the spec, never from re-running the easing formula.

describe('momentum settles at the attention level', () => {
  /** Run `seconds` of simulated time at a fixed attention, 60 fps. */
  const run = (d, seconds, attention) => {
    for (let i = 0; i < Math.round(seconds * 60); i++) d.update(1 / 60, attention)
    return d.momentum
  }

  // Every attention level exercised below (0.2/0.3/0.5/0.8) sits at or under
  // the default unfreeze-attention threshold (0.9), so restlessness's decay
  // gate never opens and the sim never freezes partway through — these tests
  // measure momentum's own trajectory, independent of the settle pipeline's
  // ending, without needing to touch that threshold at all.
  test.each([
    ['0.2', 0.2, 0.8],
    ['0.5', 0.5, 0.5],
    ['0.8', 0.8, 0.2],
  ])('attention %s converges momentum to 1 - attention', (_label, attention, expected) => {
    const d = running({ momentum: 0.5 })
    expect(run(d, 120, attention)).toBeCloseTo(expected, 3)
  })

  test('having converged, it rests there instead of drifting on to a rail', () => {
    const d = running({ momentum: 0.5 })
    const settled = run(d, 120, 0.3)
    const later   = run(d, 600, 0.3)
    expect(later).toBeCloseTo(settled, 6)
    expect(later).toBeCloseTo(0.7, 3)
  })

  test('momentum never reaches 1, so the restlessness decay gate never zeroes', () => {
    // The reported bug: momentum railing to exactly 1 made (1 - momentum) zero,
    // restlessness froze, and the scene stopped settling forever. Calmest
    // possible attention must still leave the gate open.
    const d = running({ momentum: 0.5 })
    run(d, 600, 0.0)
    expect(d.momentum).toBeLessThan(1.0)
    expect(1 - d.momentum).toBeGreaterThan(0)
  })
})

describe('momentum inertia', () => {
  const run = (d, seconds, attention) => {
    for (let i = 0; i < Math.round(seconds * 60); i++) d.update(1 / 60, attention)
    return d.momentum
  }

  test('a longer time constant approaches the target more slowly', () => {
    const fast = running({ momentum: 0.0 })
    const slow = running({ momentum: 0.0 })
    fast.params.set('momentumTau', 1)
    slow.params.set('momentumTau', 30)
    expect(run(fast, 5, 0.0)).toBeGreaterThan(run(slow, 5, 0.0))
  })

  test('zero inertia snaps straight to the target', () => {
    const d = running({ momentum: 0.0 })
    d.params.set('momentumTau', 0)
    d.update(1 / 60, 0.25)
    expect(d.momentum).toBeCloseTo(0.75, 6)
  })

  test('dt = 0 leaves momentum untouched and never produces NaN', () => {
    // three's Clock.getDelta() returns exactly 0 on its first call, so frame 1
    // always hits this path. With a naive dt/tau at tau = 0 it would be 0/0.
    for (const tau of [0, 8]) {
      const d = running({ momentum: 0.4 })
      d.params.set('momentumTau', tau)
      d.update(0, 1.0)
      expect(Number.isNaN(d.momentum)).toBe(false)
      if (tau > 0) expect(d.momentum).toBeCloseTo(0.4, 12)
    }
  })

  test('the same elapsed time gives the same result at any frame rate', () => {
    const at = steps => {
      const d = running({ momentum: 0.0 })
      for (let i = 0; i < steps; i++) d.update(6 / steps, 0.1)
      return d.momentum
    }
    expect(at(360)).toBeCloseTo(at(6), 9)   // 60 fps vs 1 fps, same 6 seconds
    expect(at(1)).toBeCloseTo(at(360), 9)   // and one single 6-second step
  })
})

// ─── freeze / hold ───────────────────────────────────────────────────────────

describe('frozen means momentum 0', () => {
  test('the freezing frame publishes momentum and noiseSpeed 0', () => {
    const d = running({ momentum: 0.6, restlessness: 0.001 })
    const ticks = []
    d.addEventListener('tick', e => ticks.push(e.detail))
    d.update(1 / 60, 1.0)
    expect(d.isFrozen()).toBe(true)
    expect(ticks.at(-1).momentum).toBe(0)
    expect(d.noiseSpeed).toBe(0)
  })

  test('after an unfreeze momentum eases up from 0, not from its pre-freeze value', () => {
    const d = new Dynamics({ momentum: 0.5 })   // frozen, but carrying momentum
    const dt = 1 / 60
    d.update(dt, 0.0)                 // unfreezes this frame
    expect(d.momentum).toBeCloseTo(0.95 * (1 - Math.exp(-dt / 8)), 12)
  })
})

describe('hold', () => {
  test('freezes silently: no event, momentum 0, idempotent', () => {
    const d = running({ momentum: 0.6 })
    const ev = vi.fn()
    d.addEventListener('freeze', ev)
    d.addEventListener('unfreeze', ev)
    d.hold()
    d.hold()
    expect(ev).not.toHaveBeenCalled()
    expect(d.isFrozen()).toBe(true)
    expect(d.isHeld()).toBe(true)
    expect(d.momentum).toBe(0)
  })

  test('attention cannot unfreeze a held instance', () => {
    const d = running()
    d.hold()
    const tick = vi.fn()
    d.addEventListener('tick', tick)
    for (let i = 0; i < 60; i++) d.update(1 / 60, 0.0)
    expect(d.isFrozen()).toBe(true)
    expect(tick).not.toHaveBeenCalled()
  })

  test('wake() releases it and fires unfreeze', () => {
    const d = running()
    d.hold()
    const unfreeze = vi.fn()
    d.addEventListener('unfreeze', unfreeze)
    d.wake()
    expect(d.isHeld()).toBe(false)
    expect(d.isFrozen()).toBe(false)
    expect(unfreeze).toHaveBeenCalledOnce()
  })
})

// ─── restless-fade ───────────────────────────────────────────────────────────
// Below 0.1 the PUBLISHED momentum is the eased value × restlessness / 0.1 —
// an output transform, so it neither compounds per frame nor jumps when
// attention crosses the threshold.

describe('restless-fade (below 0.1, published momentum fades toward 0)', () => {
  test('inside the window, momentum is the eased value scaled by restlessness / 0.1', () => {
    const d = running({ momentum: 0.6, restlessness: 0.05 })
    expect(d.momentum).toBeCloseTo(0.3, 12)
    d.params.set('momentumTau', 1e9)   // hold the eased value still
    d.update(1 / 60, 1.0)
    expect(d.momentum).toBeCloseTo(0.6 * d.restlessness / 0.1, 9)
  })

  test('no effect at or above the 0.1 window', () => {
    expect(running({ momentum: 0.5, restlessness: 0.1 }).momentum).toBe(0.5)
    expect(running({ momentum: 0.5, restlessness: 0.5 }).momentum).toBe(0.5)
  })

  test('a negative restlessness (defensively) does not push momentum negative', () => {
    const d = running({ momentum: 0.6, restlessness: 0.05 })
    d.restlessness = -1
    expect(d.momentum).toBe(0)
  })

  test('frame-rate independent: 30 and 60 fps agree after the same sim time', () => {
    const at30 = running({ momentum: 0.4, restlessness: 0.09 })
    const at60 = running({ momentum: 0.4, restlessness: 0.09 })
    for (let i = 0; i < 15; i++) at30.update(1 / 30, 0.95)
    for (let i = 0; i < 30; i++) at60.update(1 / 60, 0.95)
    // Restlessness falls at a rate that depends on the faded momentum, which a
    // per-frame step samples at the frame start: a first-order difference
    // between the two rates, far below anything visible (≈1e-4 of the range).
    expect(at30.restlessness).toBeCloseTo(at60.restlessness, 3)
    expect(at30.momentum).toBeCloseTo(at60.momentum, 3)
  })

  test('continuous when attention crosses the threshold inside the window', () => {
    const d = running({ momentum: 0.1, restlessness: 0.03 })
    const seen = [d.momentum]
    for (const a of [0.95, 0.5, 0.95, 0.5]) { d.update(1 / 60, a); seen.push(d.momentum) }
    for (let i = 1; i < seen.length; i++) expect(Math.abs(seen[i] - seen[i - 1])).toBeLessThan(0.005)
  })

  test('not held down on the way back up: the fade lifts as restlessness rises past 0.1', () => {
    const d = running({ momentum: 0.6, restlessness: 0.05 })
    d.params.set('momentumTau', 1e9)
    for (let i = 0; i < 120; i++) d.update(1 / 60, 0.0)   // rising for 2 s at 1/15 per s
    expect(d.restlessness).toBeGreaterThan(0.1)
    expect(d.momentum).toBeCloseTo(0.6, 6)
  })
})

// ─── restlessness ─────────────────────────────────────────────────────────────
// These tests pin how restlessness decays and recovers over time.

describe('restlessness (D6)', () => {
  test('decays over time', () => {
    const d = running({ restlessness: 1.0, momentum: 0.5 })
    // Decay only happens once attention clears params.get('unfreezeAttention') — a
    // tuned slider, not a fixed fact this test should depend on. Zeroing it
    // here decouples "decay happens at all" from wherever that default
    // currently sits.
    d.params.set('unfreezeAttention', 0)
    d.update(0.1, 0.5)
    expect(d.restlessness).toBeLessThan(1.0)
  })

  test('low momentum decays restlessness faster than high momentum', () => {
    const dLow  = running({ restlessness: 1.0, momentum: 0.0 })
    const dHigh = running({ restlessness: 1.0, momentum: 1.0 })
    dLow.params.set('unfreezeAttention', 0)
    dHigh.params.set('unfreezeAttention', 0)
    dLow.update(0.1, 0.5)
    dHigh.update(0.1, 0.5)
    expect(dLow.restlessness).toBeLessThan(dHigh.restlessness)
  })

  test('restlessness clamped at 0 when a step would overshoot it', () => {
    const d = running({ restlessness: 0.01, momentum: 0.0 })
    d.update(1, 1.0)
    expect(d.restlessness).toBe(0)
    expect(d.isFrozen()).toBe(true)
  })
})

describe('settle interval at max attention', () => {
  test('at momentum 0 (max attention), freeze fires at exactly the configured interval', () => {
    const d = running({ restlessness: 1.0, momentum: 0.0 })
    d.params.set('settleIntervalAtMaxAttention', 50)
    const handler = vi.fn()
    d.addEventListener('freeze', handler)
    d.update(49.999, 1.0)
    expect(handler).not.toHaveBeenCalled()
    d.update(0.002, 1.0)
    expect(handler).toHaveBeenCalledOnce()
  })

  test('a shorter interval reaches the freeze sooner than a longer one', () => {
    // Freezing stops 'tick' until unfrozen, so this measures the time to the
    // first freeze.
    const secondsToFreeze = seconds => {
      const d = running({ restlessness: 1.0, momentum: 0.0 })
      d.params.set('settleIntervalAtMaxAttention', seconds)
      let elapsed = 0
      for (let i = 0; i < 400 * 60 && !d.isFrozen(); i++) {
        d.update(1 / 60, 1.0)
        elapsed += 1 / 60
      }
      return elapsed
    }
    expect(secondsToFreeze(30)).toBeLessThan(secondsToFreeze(300))
  })

  test('ignores values the rate 1/seconds cannot use (0, negative, NaN); accepts any positive', () => {
    const d = running()
    for (const bad of [0, -5, NaN, Infinity]) {
      d.params.set('settleIntervalAtMaxAttention', bad)
      expect(d.params.get('settleIntervalAtMaxAttention')).toBe(15)
    }
    d.params.set('settleIntervalAtMaxAttention', 1)
    expect(d.params.get('settleIntervalAtMaxAttention')).toBe(1)
  })
})

describe('the settle pipeline', () => {
  test('attention hitting max no longer snaps noiseSpeed to 0 — it rides momentum\'s own ease down', () => {
    const d = running({ momentum: 0.9 }) // momentum still high — would give a fast noiseSpeed otherwise
    d.update(1 / 60, 1.0)
    expect(d.noiseSpeed).toBeGreaterThan(0) // one tick's worth of momentum ease, not an instant snap
  })

  test('attention at max still eases momentum (and noiseSpeed with it) toward 0 over time', () => {
    const d = running({ momentum: 0.9 })
    for (let i = 0; i < 60 * 60; i++) d.update(1 / 60, 1.0) // 60s — several momentumTaus at default
    expect(d.momentum).toBeCloseTo(0, 2)
    expect(d.noiseSpeed).toBeLessThan(0.05) // converged near 0 along with momentum
  })

  test('attention just under max leaves noiseSpeed alone', () => {
    const d = running({ momentum: 0.9 })
    d.update(1 / 60, 0.99)
    expect(d.noiseSpeed).toBeGreaterThan(0)
  })

  test('restlessness already at 1 stays at 1 while attention is at or below the resume threshold — nothing to rise toward', () => {
    const d = running({ restlessness: 1.0, momentum: 0.0 })
    d.params.set('unfreezeAttention', 0.3)
    for (let i = 0; i < 600; i++) d.update(1 / 60, 0.3)   // AT the threshold, not above
    expect(d.restlessness).toBe(1.0)
    for (let i = 0; i < 600; i++) d.update(1 / 60, 0.1)   // well below it
    expect(d.restlessness).toBe(1.0)
  })

  test('restlessness below 1 rises — does not hold flat — while attention is at or below the resume threshold', () => {
    const d = running({ restlessness: 0.4, momentum: 0.0 })
    d.params.set('unfreezeAttention', 0.3)
    d.update(1 / 60, 0.1)   // well below the threshold — calm, should be rising
    expect(d.restlessness).toBeGreaterThan(0.4)
  })

  test('rise rate mirrors decay rate — both are 1/settleInterval, the same slider', () => {
    const rising = running({ restlessness: 0.25, momentum: 0.0 })
    rising.params.set('settleIntervalAtMaxAttention', 20)
    rising.params.set('unfreezeAttention', 0.3)
    rising.update(1, 0.0)   // 1 real second, calm — rising

    const decaying = running({ restlessness: 1.0, momentum: 0.0 })
    decaying.params.set('settleIntervalAtMaxAttention', 20)
    decaying.params.set('unfreezeAttention', 0.3)
    decaying.update(1, 1.0)   // 1 real second, attentive — decaying

    expect(rising.restlessness - 0.25).toBeCloseTo(1 / 20, 9)
    expect(1 - decaying.restlessness).toBeCloseTo(1 / 20, 9)
  })

  test('rise is clamped at 1, however long attention stays calm', () => {
    const d = running({ restlessness: 0.9, momentum: 0.0 })
    d.params.set('settleIntervalAtMaxAttention', 3)
    for (let i = 0; i < 600; i++) d.update(1 / 60, 0.0)
    expect(d.restlessness).toBe(1.0)
  })

  test('restlessness decreases once attention rises above the resume threshold', () => {
    const d = running({ restlessness: 1.0, momentum: 0.0 })
    d.params.set('unfreezeAttention', 0.3)
    d.update(1 / 60, 0.3)                 // at the threshold — no decay yet
    expect(d.restlessness).toBe(1.0)
    d.update(1 / 60, 0.31)                // just above it
    expect(d.restlessness).toBeLessThan(1.0)
  })

  test('crossing back below the threshold reverses decay into a rise from where it stood, no reset', () => {
    const d = running({ restlessness: 1.0, momentum: 0.0 })
    d.params.set('unfreezeAttention', 0.3)
    for (let i = 0; i < 60; i++) d.update(1 / 60, 1.0)   // decay a while
    const partial = d.restlessness
    expect(partial).toBeLessThan(1.0)
    expect(partial).toBeGreaterThan(0)
    d.update(1 / 60, 0.0)   // back to calm
    expect(d.restlessness).toBeGreaterThan(partial)   // rising from where decay left it, not reset to 1
  })

  test('a lower resume threshold makes decay start at a lower attention', () => {
    const startsDecaying = (threshold, attention) => {
      const d = running({ restlessness: 1.0, momentum: 0.0 })
      d.params.set('unfreezeAttention', threshold)
      d.update(1 / 60, attention)
      return d.restlessness < 1.0
    }
    expect(startsDecaying(0.3, 0.2)).toBe(false)
    expect(startsDecaying(0.1, 0.2)).toBe(true)
  })

  test('restlessness reaching 0 freezes: fires "freeze" once and stops dispatching "tick"', () => {
    // momentum starts AT its attention=1 target (0), so decayFactor is 1 from
    // the first frame — restlessness decays at exactly 1/interval per second,
    // reaching 0 at exactly `interval` seconds.
    const d = running({ restlessness: 1.0, momentum: 0.0 })
    d.params.set('settleIntervalAtMaxAttention', 50)
    const freeze = vi.fn()
    const tick   = vi.fn()
    d.addEventListener('freeze', freeze)
    d.addEventListener('tick', tick)

    d.update(49.999, 1.0)
    expect(d.isFrozen()).toBe(false)
    expect(freeze).not.toHaveBeenCalled()

    d.update(0.002, 1.0)
    expect(d.isFrozen()).toBe(true)
    expect(freeze).toHaveBeenCalledOnce()

    tick.mockClear()
    d.update(1 / 60, 1.0) // still above the unfreeze threshold — stays frozen
    expect(tick).not.toHaveBeenCalled()
  })

  test('frozen state holds exactly — momentum, restlessness, noiseTime do not drift', () => {
    const d = running({ restlessness: 1.0, momentum: 0.0 })
    d.params.set('settleIntervalAtMaxAttention', 30)
    d.params.set('unfreezeAttention', 0.3)   // explicit, not the class default — see below
    for (let i = 0; i < 30 * 60 + 5; i++) d.update(1 / 60, 1.0) // past the freeze point
    expect(d.isFrozen()).toBe(true)
    const { momentum, restlessness, noiseTime } = d

    for (let i = 0; i < 600; i++) d.update(1 / 60, 0.9) // held above the 0.3 threshold above
    expect(d.momentum).toBe(momentum)
    expect(d.restlessness).toBe(restlessness)
    expect(d.noiseTime).toBe(noiseTime)
  })

  test('attention dropping past the threshold unfreezes: restlessness resets to 1, resumes ticking', () => {
    const d = running({ restlessness: 1.0, momentum: 0.0 })
    d.params.set('settleIntervalAtMaxAttention', 30)
    d.params.set('unfreezeAttention', 0.3)
    for (let i = 0; i < 30 * 60 + 5; i++) d.update(1 / 60, 1.0)
    expect(d.isFrozen()).toBe(true)

    const unfreeze = vi.fn()
    d.addEventListener('unfreeze', unfreeze)
    d.update(1 / 60, 0.2) // below threshold
    expect(unfreeze).toHaveBeenCalledOnce()
    expect(d.isFrozen()).toBe(false)
    // Unfreezing resets restlessness to full (RESTLESSNESS_RESET), not a climb
    // from the 0 freezing left it at.
    expect(d.restlessness).toBe(1)
  })

  test('resumes in the SAME call that unfreezes — not one tick late', () => {
    const d = running({ restlessness: 1.0, momentum: 0.0 })
    d.params.set('settleIntervalAtMaxAttention', 30)
    for (let i = 0; i < 30 * 60 + 5; i++) d.update(1 / 60, 1.0)
    const before = d.noiseTime

    const tick = vi.fn()
    d.addEventListener('tick', tick)
    d.update(1 / 60, 0.0) // resume at full calm attention
    expect(tick).toHaveBeenCalledOnce()
    expect(d.momentum).toBeGreaterThan(0) // moved toward the new (calm) target already
    expect(d.noiseTime).not.toBe(before)
  })

  test('the unfreeze threshold ignores NaN and keeps any finite value (the slider owns the range)', () => {
    const d = running()
    d.params.set('unfreezeAttention', NaN)
    expect(d.params.get('unfreezeAttention')).toBe(0.9)
    d.params.set('unfreezeAttention', 0.4)
    expect(d.params.get('unfreezeAttention')).toBe(0.4)
  })
})
