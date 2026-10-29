import { describe, test, expect } from 'vitest'
import { AnimSpeed, weatherSpeedFactor } from '../../src/dynamics/animSpeed.js'

/** Fake artPass exposing exactly the public surface AnimSpeed reads. */
function fakeArtPass({
  enabled = false, exitResumeEase = 8, isExitPlaying = () => false, holdsSceneStill = () => false,
} = {}) {
  return {
    enabled, isExitPlaying, holdsSceneStill,
    params: { get: key => (key === 'exitResumeEase' ? exitResumeEase : undefined) },
  }
}

/** Fake dynamics: `restlessness` is a plain mutable field, as on the real class. */
function fakeDynamics({ restlessness = 1 } = {}) {
  return { restlessness }
}

describe('constructor', () => {
  test('starts at the given target, and at rest the live speed IS that target', () => {
    expect(new AnimSpeed(fakeArtPass(), fakeDynamics(), 0.4).getSpeed()).toBe(0.4)
    expect(new AnimSpeed(fakeArtPass(), fakeDynamics(), 0.4).params.get('targetSpeed')).toBe(0.4)
    // The shipped default is a tuned number and deliberately not asserted here
    // — only that omitting it leaves the two in step, which is the invariant.
    const d = new AnimSpeed(fakeArtPass(), fakeDynamics())
    expect(d.getSpeed()).toBe(d.params.get('targetSpeed'))
    expect(d.getSpeed()).toBeGreaterThan(0)
  })

  test('a negative initial target is clamped to 0', () => {
    expect(new AnimSpeed(fakeArtPass(), fakeDynamics(), -5).getSpeed()).toBe(0)
  })
})

describe('direct proportional tracking — the fade IS restlessness, no separate ramp', () => {
  test('speed equals target * restlessness, recomputed every frame, with no lag', () => {
    const dyn = fakeDynamics({ restlessness: 1 })
    const a = new AnimSpeed(fakeArtPass(), dyn, 2)
    for (const s of [1, 0.7, 0.3, 0.05, 0]) {
      dyn.restlessness = s
      a.update(1 / 60)
      expect(a.getSpeed()).toBeCloseTo(2 * s, 10)
    }
  })

  test('tracks instantly even across a single huge dt — no timer involved', () => {
    const dyn = fakeDynamics({ restlessness: 0.5 })
    const a = new AnimSpeed(fakeArtPass(), dyn, 4)
    a.update(500)   // an enormous dt must not matter to direct tracking
    expect(a.getSpeed()).toBe(2)
  })

  test('reaches exactly 0 the instant restlessness does', () => {
    const dyn = fakeDynamics({ restlessness: 0.01 })
    const a = new AnimSpeed(fakeArtPass(), dyn, 1)
    a.update(1 / 60)
    expect(a.getSpeed()).toBeGreaterThan(0)
    dyn.restlessness = 0
    a.update(1 / 60)
    expect(a.getSpeed()).toBe(0)
  })

  test('changing the target rescales tracking immediately, no easing', () => {
    const dyn = fakeDynamics({ restlessness: 0.5 })
    const a = new AnimSpeed(fakeArtPass(), dyn, 1)
    a.update(1 / 60)
    expect(a.getSpeed()).toBe(0.5)
    a.params.set('targetSpeed', 4)
    a.update(1 / 60)
    expect(a.getSpeed()).toBe(2)
  })

  test('the target speed clamps negative values to 0', () => {
    const a = new AnimSpeed(fakeArtPass(), fakeDynamics())
    a.params.set('targetSpeed', -3)
    expect(a.params.get('targetSpeed')).toBe(0)
  })
})

describe('holding: the art pass being enabled (and not leaving) forces exactly 0', () => {
  test('forces 0 even if dynamics has not caught up (restlessness still 1)', () => {
    const dyn = fakeDynamics({ restlessness: 1 })
    const artPass = fakeArtPass({ enabled: true })
    const a = new AnimSpeed(artPass, dyn, 1)
    a.update(1 / 60)
    expect(a.getSpeed()).toBe(0)
  })

  test('a random exit holds at 0 through its whole run, even after a huge dt', () => {
    let exiting = true, holding = true
    const artPass = fakeArtPass({
      enabled: true, isExitPlaying: () => exiting, holdsSceneStill: () => holding,
    })
    const dyn = fakeDynamics({ restlessness: 1 })   // dynamics already unfrozen underneath
    const a = new AnimSpeed(artPass, dyn, 1)
    a.update(1 / 60)
    expect(a.getSpeed()).toBe(0)
    a.update(50)
    expect(a.getSpeed()).toBe(0)
  })

  test('a drift exit does NOT hold — it is not "holding" at all', () => {
    let exiting = true
    const artPass = fakeArtPass({ enabled: true, isExitPlaying: () => exiting })
    const dyn = fakeDynamics({ restlessness: 1 })
    const a = new AnimSpeed(artPass, dyn, 3)
    a.update(1 / 60)
    // Not held: falls straight to direct tracking (no prior hold to leave, so
    // no resume climb is triggered either — see the leaving describe below).
    expect(a.getSpeed()).toBe(3)
  })
})

describe('leaving a hold climbs back, eased by exitResumeEase', () => {
  test('checkbox off directly: climbs from 0 toward target*restlessness', () => {
    const dyn = fakeDynamics({ restlessness: 1 })
    const artPass = fakeArtPass({ enabled: true, exitResumeEase: 10 })
    const a = new AnimSpeed(artPass, dyn, 2)
    a.update(1 / 60)
    expect(a.getSpeed()).toBe(0)   // held

    artPass.enabled = false
    a.update(10)   // one full tau
    expect(a.getSpeed()).toBeCloseTo(2 * (1 - Math.exp(-1)), 6)
  })

  test('a drift exit starting leaves the hold the same way switching the checkbox off does', () => {
    let exiting = false
    const dyn = fakeDynamics({ restlessness: 1 })
    const artPass = fakeArtPass({ enabled: true, exitResumeEase: 10, isExitPlaying: () => exiting })
    const a = new AnimSpeed(artPass, dyn, 2)
    a.update(1 / 60)
    expect(a.getSpeed()).toBe(0)   // held: enabled, not yet exiting

    exiting = true   // the drift exit begins — enabled stays true throughout
    a.update(10)     // one full tau
    expect(a.getSpeed()).toBeCloseTo(2 * (1 - Math.exp(-1)), 6)
  })

  test('a random exit climbs back only once it stops holding', () => {
    let exiting = true, holding = true
    const dyn = fakeDynamics({ restlessness: 1 })
    const artPass = fakeArtPass({
      enabled: true, exitResumeEase: 4,
      isExitPlaying: () => exiting, holdsSceneStill: () => holding,
    })
    const a = new AnimSpeed(artPass, dyn, 1)
    a.update(1 / 60)
    expect(a.getSpeed()).toBe(0)

    holding = false             // the exit's last frame
    artPass.enabled = false
    exiting = false
    a.update(4)                 // one full tau
    expect(a.getSpeed()).toBeCloseTo(1 - Math.exp(-1), 6)
  })

  test('the ease is read live: changing it mid-climb takes effect on the next frame', () => {
    const dyn = fakeDynamics({ restlessness: 1 })
    const artPass = fakeArtPass({ enabled: true, exitResumeEase: 100 })
    const a = new AnimSpeed(artPass, dyn, 1)
    a.update(1 / 60)
    artPass.enabled = false
    a.update(1 / 60)
    expect(a.getSpeed()).toBeLessThan(0.01)   // barely moved on the slow ease
    artPass.params.get = () => 0              // slider to 0: snap
    a.update(1 / 60)
    expect(a.getSpeed()).toBe(1)
  })

  test('the climb targets target*restlessness, not a flat target — gives way if restlessness falls again mid-climb', () => {
    const dyn = fakeDynamics({ restlessness: 1 })
    const artPass = fakeArtPass({ enabled: true, exitResumeEase: 5 })
    const a = new AnimSpeed(artPass, dyn, 2)
    a.update(1 / 60)
    expect(a.getSpeed()).toBe(0)

    artPass.enabled = false
    a.update(1)
    const midClimb = a.getSpeed()
    expect(midClimb).toBeGreaterThan(0)
    expect(midClimb).toBeLessThan(2)

    dyn.restlessness = 0.1   // attention rose again — heading back toward a fade
    for (let i = 0; i < 6000; i++) a.update(1 / 60)   // 100s — many tau, plenty to settle
    // Converges near 2*0.1 = 0.2 — NOT near the original target of 2, which is
    // where a climb ignoring restlessness's new value would have ended up.
    expect(a.getSpeed()).toBeCloseTo(0.2, 3)
  })

  test('once converged, reverts to direct tracking — a later fade is not run through the climb’s lag', () => {
    const dyn = fakeDynamics({ restlessness: 1 })
    const artPass = fakeArtPass({ enabled: true, exitResumeEase: 0 })   // tau=0 snaps, converges in one call
    const a = new AnimSpeed(artPass, dyn, 1)
    a.update(1 / 60)
    expect(a.getSpeed()).toBe(0)

    artPass.enabled = false
    a.update(1 / 60)
    expect(a.getSpeed()).toBe(1)   // snapped to target*1

    // Give the climb a huge, slow ease — if it were still "resuming" this
    // would barely move; direct tracking moves it exactly and instantly.
    artPass.params.get = () => 100
    dyn.restlessness = 0.3
    a.update(1 / 60)
    expect(a.getSpeed()).toBeCloseTo(0.3, 10)
  })

  test('re-entering holding mid-climb cancels it and re-forces 0', () => {
    const dyn = fakeDynamics({ restlessness: 1 })
    const artPass = fakeArtPass({ enabled: true, exitResumeEase: 100 })
    const a = new AnimSpeed(artPass, dyn, 1)
    a.update(1 / 60)
    artPass.enabled = false
    a.update(1)
    expect(a.getSpeed()).toBeGreaterThan(0)
    expect(a.getSpeed()).toBeLessThan(1)

    artPass.enabled = true   // held again before the climb finished
    a.update(1 / 60)
    expect(a.getSpeed()).toBe(0)
  })
})

describe('ease safety', () => {
  test('tau = 0 snaps to target*restlessness in one call, even at dt = 0', () => {
    const dyn = fakeDynamics({ restlessness: 0.5 })
    const artPass = fakeArtPass({ enabled: true, exitResumeEase: 0 })
    const a = new AnimSpeed(artPass, dyn, 2)
    a.update(0)            // held
    artPass.enabled = false
    a.update(0)
    expect(a.getSpeed()).toBe(1)   // 2 * 0.5, snapped
    expect(Number.isNaN(a.getSpeed())).toBe(false)
  })

  test('dt = 0 with tau > 0 leaves the climb unchanged (no NaN from a stalled first frame)', () => {
    const dyn = fakeDynamics({ restlessness: 1 })
    const artPass = fakeArtPass({ enabled: true, exitResumeEase: 8 })
    const a = new AnimSpeed(artPass, dyn, 1)
    a.update(0)
    artPass.enabled = false
    a.update(0)
    expect(a.getSpeed()).toBe(0)
    expect(Number.isNaN(a.getSpeed())).toBe(false)
  })

  test('the climb is frame-rate independent: 30 and 60 fps reach the same speed after 1 s', () => {
    const climb = fps => {
      const artPass = fakeArtPass({ enabled: true, exitResumeEase: 2 })
      const a = new AnimSpeed(artPass, fakeDynamics({ restlessness: 1 }), 1)
      a.update(1 / fps)
      artPass.enabled = false
      for (let i = 0; i < fps; i++) a.update(1 / fps)
      return a.getSpeed()
    }
    expect(climb(30)).toBeCloseTo(climb(60), 10)
  })

  test('a non-finite target is ignored', () => {
    const a = new AnimSpeed(fakeArtPass(), fakeDynamics(), 1)
    a.params.set('targetSpeed', NaN)
    expect(a.params.get('targetSpeed')).toBe(1)
  })
})

describe('weatherSpeedFactor', () => {
  // The whole point of the knob: it LAYERS on the existing pace rather than
  // replacing it, so a clear sky has to reproduce that pace exactly. Anything
  // but 1 here and the shipped look is retuned by the mere presence of the
  // feature.
  test('a clear sky is exactly no change, at every gain', () => {
    for (const gain of [0, 0.5, 1, 3]) expect(weatherSpeedFactor(0, gain)).toBe(1)
  })

  test('zero gain is exactly no change, at every sky', () => {
    for (const drive of [0, 0.3, 0.75, 1]) expect(weatherSpeedFactor(drive, 0)).toBe(1)
  })

  test('the gain names the multiplier reached at full overcast', () => {
    expect(weatherSpeedFactor(1, 1)).toBeCloseTo(2, 12)
    expect(weatherSpeedFactor(1, 2.5)).toBeCloseTo(3.5, 12)
  })

  test('it only ever hurries — never slower than the pace it multiplies', () => {
    for (const drive of [0, 0.2, 0.6, 1]) {
      for (const gain of [0, 0.4, 2]) expect(weatherSpeedFactor(drive, gain)).toBeGreaterThanOrEqual(1)
    }
  })

  test('monotone in how grey the sky is', () => {
    let prev = -Infinity
    for (let d = 0; d <= 1.0001; d += 0.1) {
      const f = weatherSpeedFactor(d, 1.5)
      expect(f).toBeGreaterThan(prev)
      prev = f
    }
  })

  test('junk leaves the pace alone rather than killing the motion', () => {
    expect(weatherSpeedFactor(NaN, 1)).toBe(1)
    expect(weatherSpeedFactor(0.5, NaN)).toBe(1)
    expect(weatherSpeedFactor(-2, 1)).toBe(1)
    expect(weatherSpeedFactor(5, 1)).toBeCloseTo(2, 12)   // drive clamps at full grey
    expect(weatherSpeedFactor(1, -3)).toBe(1)
  })
})
