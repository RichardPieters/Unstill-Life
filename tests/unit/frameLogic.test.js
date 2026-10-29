import { describe, it, expect } from 'vitest'
import { shouldAdvanceDynamics, reconcilePaintingHold, isArtPassAnimating, computeSceneStatic, isPaintingStill } from '../../src/scene/frameLogic.js'

/** Fake artPass exposing exactly the surface this file reads. */
function fakeArtPass({ enabled = false, holdsSceneStill = false, revealPlaying = false, exitPlaying = false } = {}) {
  return {
    enabled,
    holdsSceneStill: () => holdsSceneStill,
    isRevealPlaying: () => revealPlaying,
    isExitPlaying:   () => exitPlaying,
  }
}

/** Fake dynamics exposing exactly the surface this file reads. */
function fakeDynamics(frozen = false) {
  return { isFrozen: () => frozen }
}

describe('shouldAdvanceDynamics', () => {
  it('true when running and the art pass is not holding the scene still', () => {
    expect(shouldAdvanceDynamics(false, fakeArtPass())).toBe(true)
  })

  it('false while paused, regardless of the art pass', () => {
    expect(shouldAdvanceDynamics(true, fakeArtPass())).toBe(false)
    expect(shouldAdvanceDynamics(true, fakeArtPass({ holdsSceneStill: true }))).toBe(false)
  })

  it('false while the art pass asks to hold the scene still, even though not paused', () => {
    expect(shouldAdvanceDynamics(false, fakeArtPass({ holdsSceneStill: true }))).toBe(false)
  })

  it('true under a finished painting — a frozen update() must keep polling attention to ever unfreeze', () => {
    expect(shouldAdvanceDynamics(false, fakeArtPass({ enabled: true }))).toBe(true)
  })

  it('false while the reveal plays — the point of no return: attention is not read until the painting is complete', () => {
    expect(shouldAdvanceDynamics(false, fakeArtPass({ enabled: true, revealPlaying: true }))).toBe(false)
  })
})

describe('reconcilePaintingHold', () => {
  /** Fake dynamics recording hold/wake. */
  function fakeHoldable({ frozen = false, held = false } = {}) {
    const d = { frozen, held, calls: [] }
    d.isFrozen = () => d.frozen
    d.isHeld = () => d.held
    d.hold = () => { d.calls.push('hold'); d.frozen = true; d.held = true }
    d.wake = () => { d.calls.push('wake'); d.frozen = false; d.held = false }
    return d
  }

  it('holds dynamics under a painting it did not freeze for (checkbox, restore, test hook)', () => {
    const d = fakeHoldable()
    reconcilePaintingHold(fakeArtPass({ enabled: true }), d)
    expect(d.calls).toEqual(['hold'])
  })

  it('leaves a naturally frozen scene alone — that painting belongs to the cycle', () => {
    const d = fakeHoldable({ frozen: true })
    reconcilePaintingHold(fakeArtPass({ enabled: true }), d)
    expect(d.calls).toEqual([])
  })

  it('releases a hold once that painting starts its exit', () => {
    const d = fakeHoldable({ frozen: true, held: true })
    reconcilePaintingHold(fakeArtPass({ enabled: true, exitPlaying: true }), d)
    expect(d.calls).toEqual(['wake'])
  })

  it('does nothing with no painting and no hold', () => {
    const d = fakeHoldable()
    reconcilePaintingHold(fakeArtPass(), d)
    expect(d.calls).toEqual([])
  })
})

describe('isPaintingStill', () => {
  it('false when the art pass is off', () => {
    expect(isPaintingStill(fakeArtPass())).toBe(false)
  })

  it('true while the reveal is playing', () => {
    expect(isPaintingStill(fakeArtPass({ enabled: true, revealPlaying: true }))).toBe(true)
  })

  it('true once held (enabled, reveal finished, not exiting)', () => {
    expect(isPaintingStill(fakeArtPass({ enabled: true }))).toBe(true)
  })

  it('false while exiting — the dissolve needs the landscape drifting, not held', () => {
    expect(isPaintingStill(fakeArtPass({ enabled: true, exitPlaying: true }))).toBe(false)
  })
})

describe('isArtPassAnimating', () => {
  it('false when neither the reveal nor the exit is playing', () => {
    expect(isArtPassAnimating(fakeArtPass())).toBe(false)
  })

  it('true while the reveal is playing', () => {
    expect(isArtPassAnimating(fakeArtPass({ revealPlaying: true }))).toBe(true)
  })

  it('true while the exit is playing', () => {
    expect(isArtPassAnimating(fakeArtPass({ exitPlaying: true }))).toBe(true)
  })

  it('true when both happen to be true at once', () => {
    expect(isArtPassAnimating(fakeArtPass({ revealPlaying: true, exitPlaying: true }))).toBe(true)
  })
})

describe('computeSceneStatic', () => {
  it('static when frozen, not paused, camera still', () => {
    expect(computeSceneStatic(false, false, fakeDynamics(true))).toBe(true)
  })

  it('static when paused, not frozen, camera still', () => {
    expect(computeSceneStatic(true, false, fakeDynamics(false))).toBe(true)
  })

  it('not static when neither frozen nor paused', () => {
    expect(computeSceneStatic(false, false, fakeDynamics(false))).toBe(false)
  })

  it('not static the moment the camera has moved, even if frozen and paused', () => {
    expect(computeSceneStatic(true, true, fakeDynamics(true))).toBe(false)
  })

  it('not static on a frame a control was touched, however still everything else is', () => {
    // The case the whole flag exists to protect: the landscape is frozen under
    // a painting and a slider moves. Reporting "static" there would skip the
    // very pass that has to re-run for the change to reach the screen.
    expect(computeSceneStatic(false, false, fakeDynamics(true), true)).toBe(false)
    expect(computeSceneStatic(true, false, fakeDynamics(true), true)).toBe(false)
  })

  it('dirty defaults to false, so a caller that does not track it is unaffected', () => {
    expect(computeSceneStatic(true, false, fakeDynamics(true))).toBe(true)
  })

  it('has no side effects — does not call setSceneStatic or anything else on its args', () => {
    const dynamics = fakeDynamics(true)
    let calls = 0
    const proxy = new Proxy(dynamics, { get: (t, p) => { calls++; return t[p] } })
    computeSceneStatic(false, false, proxy)
    // Exactly one read (isFrozen), nothing else touched or mutated.
    expect(calls).toBe(1)
  })
})
