import { describe, it, expect } from 'vitest'
import { RevealDirector } from '../../src/artpass/artPassReveal.js'

/**
 * The reveal/exit state machine, driven by a hand-advanced clock.
 *
 * These cases need no browser, GPU or wall-clock wait. Nothing here touches THREE.
 */

/** Slider state, at the shape the director reads. */
function state(over = {}) {
  return {
    revealDuration: 10,
    revealPrimeDuration: 2,
    revealPrimeLighten: 0.35,
    revealGroundBeat: 0.25,
    revealUnderpaintFirst: false,
    exitDuration: 4,
    exitRandom: false,
    exitSweep: 0.2,
    ...over,
  }
}

/** A director whose clock only moves when the test says so. */
function build(over = {}) {
  let t = 0
  const d = new RevealDirector({
    getState: () => state(over),
    now: () => t,
  })
  return { d, advance: (seconds) => { t += seconds * 1000 } }
}

describe('rest state', () => {
  it('reset leaves the picture fully painted, live, and animating nothing', () => {
    const { d } = build()
    d.reset()
    expect(d.isRevealPlaying()).toBe(false)
    expect(d.isExitPlaying()).toBe(false)
    expect(d.isHeld()).toBe(false)      // live, so a snapped-on pass repaints
    expect(d.isFinished()).toBe(false)
    expect(d.values.spawn).toBe(1)
    expect(d.values.weave).toBe(1)
    // A finished painting keeps the toned canvas a played reveal ends on.
    expect(d.values.lighten).toBeCloseTo(0.35, 6)
  })

  it('a snapped-on painting is toned like one a reveal finished', () => {
    const rest = build()
    rest.d.reset()
    const played = build()
    played.d.playReveal()
    played.advance(2 + 10)
    played.d.tick()
    expect(played.d.values.lighten).toBeCloseTo(rest.d.values.lighten, 6)
    expect(rest.d.values.lighten).toBeGreaterThan(0)
  })

  it('the resting tone follows the priming slider', () => {
    const over = {}
    const { d } = build(over)
    d.reset()
    over.revealPrimeLighten = 0.6
    d.tick()
    expect(d.values.lighten).toBeCloseTo(0.6, 6)
  })

  it('rest leaves the canvas surface PRESENT, not faded away', () => {
    // uExitFade multiplies the weave, the crevice shading and the high-key lift
    // in artFinish.frag. Its rest value is the only one those three ever see
    // outside an exit, so a rest of 0 switches the canvas off for good.
    const { d } = build()
    d.reset()
    expect(d.values.exitFade).toBe(1)
  })
})

describe('birth gating', () => {
  it('is off at rest and turns on with the reveal', () => {
    const { d } = build()
    d.reset()
    expect(d.gatesBirths()).toBe(false)
    d.playReveal()
    expect(d.gatesBirths()).toBe(true)
  })

  it('stays on through the last frame of the reveal and ends when the picture is held', () => {
    const { d, advance } = build()
    d.playReveal()
    advance(2 + 11)
    d.tick()
    // The last frame still draws the strokes that arrive at progress 1.
    expect(d.isRevealPlaying()).toBe(false)
    expect(d.gatesBirths()).toBe(true)
    d.onFrozen()
    expect(d.gatesBirths()).toBe(false)
  })

  it('stays on when an exit cuts the reveal short, until that picture is held', () => {
    const { d, advance } = build()
    d.playReveal()
    advance(2 + 3)
    d.tick()
    d.playExit()
    expect(d.gatesBirths()).toBe(true)
    d.onFrozen()
    expect(d.gatesBirths()).toBe(false)
  })

  it('is off again after a reset', () => {
    const { d } = build()
    d.playReveal()
    d.reset()
    expect(d.gatesBirths()).toBe(false)
  })
})

describe('the reveal', () => {
  it('primes first and spawns nothing while it does', () => {
    const { d, advance } = build()
    d.playReveal()
    advance(1)                       // half of a 2s prime
    d.tick()
    expect(d.values.weave).toBeGreaterThan(0)
    expect(d.values.weave).toBeLessThan(1)
    expect(d.values.spawn).toBe(0)     // not one mark yet
  })

  it('holds the primed canvas at its ceiling once marks start arriving', () => {
    const { d, advance } = build()
    d.playReveal()
    advance(2 + 5)                   // prime over, halfway through a 10s reveal
    d.tick()
    expect(d.values.weave).toBe(1)
    expect(d.values.lighten).toBeCloseTo(0.35, 6)
    expect(d.values.spawn).toBeCloseTo(0.5, 6)
  })

  it('asks for the hold exactly once the picture is finished', () => {
    const { d, advance } = build()
    d.playReveal()
    advance(2 + 9)
    d.tick()
    expect(d.needsFreeze()).toBe(false)    // still painting
    advance(2)
    d.tick()
    expect(d.isRevealPlaying()).toBe(false)
    expect(d.needsFreeze()).toBe(true)
    // …and holding only actually happens when render() says it has done it.
    expect(d.isHeld()).toBe(false)
    d.onFrozen()
    expect(d.isHeld()).toBe(true)
    expect(d.needsFreeze()).toBe(false)
  })

  it('asks for a growth-field solve, once per reveal', () => {
    const { d } = build()
    expect(d.needsGrowthBuild()).toBe(false)
    d.playReveal()
    expect(d.needsGrowthBuild()).toBe(true)
    d.onGrowthBuilt()
    expect(d.needsGrowthBuild()).toBe(false)
  })

  it('a resize asks for a new growth field only while an entrance plays', () => {
    const { d } = build()
    d.markGrowthStale()
    expect(d.needsGrowthBuild()).toBe(false)
    d.playReveal()
    d.onGrowthBuilt()
    d.markGrowthStale()
    expect(d.needsGrowthBuild()).toBe(true)
  })
})

describe('the exit', () => {
  it('takes its own hold when nothing was held yet', () => {
    // A pass switched on directly rather than revealed has no held copy, and
    // the dissolve has to measure against the frame painting stopped at.
    const { d } = build()
    d.reset()
    expect(d.playExit()).toBe(true)
    expect(d.needsFreeze()).toBe(true)
  })

  it('does not re-take a hold it already has', () => {
    const { d, advance } = build()
    d.playReveal()
    advance(20)
    d.tick()
    d.onFrozen()
    d.playExit()
    expect(d.needsFreeze()).toBe(false)
  })

  it('finishes without switching anything off itself', () => {
    // The frame that reaches progress 1 still has to be DRAWN; render() tears
    // down after the draw, or the painting flashes back to full for one frame.
    const { d, advance } = build()
    d.reset()
    d.playExit()
    advance(5)
    d.tick()
    expect(d.isFinished()).toBe(true)
    expect(d.isExitPlaying()).toBe(true)
  })

  it('a second playExit is ignored, so the picture never restarts its dissolve', () => {
    const { d, advance } = build()
    d.reset()
    d.playExit()
    advance(2)
    d.tick()
    const half = d.values.exitProgress
    expect(half).toBeGreaterThan(0)

    expect(d.playExit()).toBe(false)     // refused
    d.tick()
    expect(d.values.exitProgress).toBeGreaterThanOrEqual(half)   // monotonic
  })
})

describe('interrupts — attention is a live signal and can cross back any time', () => {
  it('a reveal arriving mid-exit cancels the exit outright', () => {
    // Both running at once is the bug: the exit ticks to its end and switches
    // the pass off underneath the reveal, while the hold it took makes render()
    // skip the paint pass — so the reveal is never drawn at all, leaving a
    // frozen world with no painting on it and no further freeze coming.
    const { d, advance } = build()
    d.reset()
    d.playExit()
    advance(2)
    d.tick()
    expect(d.isExitPlaying()).toBe(true)

    d.playReveal()
    expect(d.isExitPlaying()).toBe(false)
    expect(d.isRevealPlaying()).toBe(true)
    expect(d.isFinished()).toBe(false)
    expect(d.isHeld()).toBe(false)       // repainting live, not serving the copy
  })

  it('and the cancelled exit leaves no partial fade behind', () => {
    const { d, advance } = build()
    d.reset()
    d.playExit()
    advance(3.5)                  // well into the closing sweep
    d.tick()
    expect(d.values.exitFade).toBeLessThan(1)

    d.playReveal()
    expect(d.values.exitFade).toBe(1)
    expect(d.values.exitProgress).toBe(0)
  })

  it('a finished exit cannot switch off a reveal that replaced it', () => {
    // The exact ordering that stranded the piece: tick() must not resurrect the
    // cancelled exit's completion.
    const { d, advance } = build()
    d.reset()
    d.playExit()
    advance(3.9)
    d.tick()
    d.playReveal()
    advance(1)
    d.tick()
    expect(d.isFinished()).toBe(false)
    expect(d.isRevealPlaying()).toBe(true)
  })

  it('an exit arriving mid-reveal stops the reveal and holds what was painted', () => {
    const { d, advance } = build()
    d.playReveal()
    advance(2 + 3)
    d.tick()
    expect(d.isRevealPlaying()).toBe(true)

    d.playExit()
    expect(d.isRevealPlaying()).toBe(false)
    expect(d.isExitPlaying()).toBe(true)
    expect(d.needsFreeze()).toBe(true)   // hold the half-painted picture to dissolve
  })

  it('survives attention flapping repeatedly without ending up in a dead state', () => {
    const { d, advance } = build()
    d.reset()
    for (let i = 0; i < 12; i++) {
      d.playReveal()
      advance(0.4)
      d.tick()
      d.playExit()
      advance(0.4)
      d.tick()
    }
    // Whatever it settled on, it must be a state the loop can move: never both
    // animations, and never held-and-revealing at the same time.
    expect(d.isRevealPlaying() && d.isExitPlaying()).toBe(false)
    expect(d.isHeld() && d.isRevealPlaying()).toBe(false)
  })
})

describe('holds and thaws', () => {
  it('thaw re-takes the hold next frame, so a slider is visible but the picture stays still', () => {
    const { d, advance } = build()
    d.playReveal()
    advance(20)
    d.tick()
    d.onFrozen()

    d.thaw()
    expect(d.isHeld()).toBe(false)
    expect(d.needsFreeze()).toBe(true)     // repaint once, then hold again
  })

  it('thaw does nothing when the picture was never held', () => {
    const { d } = build()
    d.reset()
    d.thaw()
    expect(d.needsFreeze()).toBe(false)
  })

  it('thaw does nothing while an exit is in flight', () => {
    // isHeld() stays true for the whole exit (the dissolve reads straight
    // through the held buffers), so without this guard any colour, ground-mode
    // or toggle change mid-exit — including the ambient weather
    // walk's own colSky/groundColor writes, which fire on their own every few
    // frames with no user input at all — would repaint and re-freeze from
    // the current frame, wiping the dissolve's progress back to full.
    const { d, advance } = build()
    d.playReveal()
    advance(20)
    d.tick()
    d.onFrozen()
    d.playExit()
    advance(2)
    d.tick()
    expect(d.isExitPlaying()).toBe(true)
    expect(d.isHeld()).toBe(true)

    d.thaw()
    expect(d.isHeld()).toBe(true)
    expect(d.isExitPlaying()).toBe(true)
    expect(d.needsFreeze()).toBe(false)
  })

  it('dropHold discards the held copy and asks for a new one at the new size', () => {
    // A resize: what was held is the wrong size. The next repaint is the right
    // size, and a finished painting must be held again rather than repainted
    // on every frame from then on.
    const { d, advance } = build()
    d.playReveal()
    advance(20)
    d.tick()
    d.onFrozen()

    d.dropHold()
    expect(d.isHeld()).toBe(false)
    expect(d.needsFreeze()).toBe(true)
    d.onFrozen()
    expect(d.isHeld()).toBe(true)
  })

  it('dropHold mid-reveal leaves the hold to the reveal\'s own end', () => {
    const { d, advance } = build()
    d.playReveal()
    advance(0.5)
    d.tick()
    d.dropHold()
    expect(d.needsFreeze()).toBe(false)
  })
})

/**
 * The progress readouts.
 *
 * audio.js scores the painting off these — a dry brushed sweep while the
 * canvas tones, grains as the marks arrive, cracks through the dissolve — so
 * they have to be right at every transition and not merely at rest. The
 * uniform assertions above would not catch a stale getter, because the
 * uniforms are written from local variables rather than read back from these.
 */
describe('progress readouts', () => {
  it('rest reports a finished painting with nothing taken away', () => {
    const { d } = build()
    d.reset()
    expect(d.getPrimeProgress()).toBe(1)
    expect(d.getRevealProgress()).toBe(1)
    expect(d.getExitProgress()).toBe(0)
  })

  it('a starting reveal reports nothing painted yet', () => {
    const { d } = build()
    d.playReveal()
    expect(d.getPrimeProgress()).toBe(0)
    expect(d.getRevealProgress()).toBe(0)
    expect(d.getExitProgress()).toBe(0)
  })

  it('priming moves the prime readout while the marks stay at zero', () => {
    const { d, advance } = build()
    d.playReveal()
    advance(1)                       // half of the 2 s prime
    d.tick()
    expect(d.getPrimeProgress()).toBeGreaterThan(0)
    expect(d.getPrimeProgress()).toBeLessThan(1)
    expect(d.getRevealProgress()).toBe(0)
  })

  it('marks advance only once priming is over', () => {
    const { d, advance } = build()
    d.playReveal()
    advance(2 + 5)                   // prime done, half the 10 s paint
    d.tick()
    expect(d.getPrimeProgress()).toBe(1)
    expect(d.getRevealProgress()).toBeCloseTo(0.5, 2)
  })

  it('a completed reveal leaves both reveal readouts at 1', () => {
    const { d, advance } = build()
    d.playReveal()
    advance(20)
    d.tick()
    expect(d.getRevealProgress()).toBe(1)
    expect(d.getExitProgress()).toBe(0)
  })

  it('exit progress is zero the instant an exit starts, not stale from the last one', () => {
    // The bug this guards: _tickExit only runs from inside artPass.render(),
    // so between `unfreeze` and the next render the getter is read at least
    // once with no tick in between. Left unreset it reports the PREVIOUS
    // exit's 1 — "already fully dissolved" — right as the dissolve begins.
    const { d, advance } = build()
    d.playReveal(); advance(20); d.tick(); d.onFrozen()
    d.playExit(); advance(10); d.tick()
    expect(d.getExitProgress()).toBe(1)

    d.reset()
    d.playReveal(); advance(20); d.tick(); d.onFrozen()
    d.playExit()
    expect(d.getExitProgress()).toBe(0)        // before any tick
  })

  it('exit progress tracks the dissolve', () => {
    const { d, advance } = build()
    d.playReveal(); advance(20); d.tick(); d.onFrozen()
    d.playExit()
    advance(2)                       // half the 4 s exit
    d.tick()
    expect(d.getExitProgress()).toBeCloseTo(0.5, 2)
  })

  it('a reveal interrupting an exit clears the exit readout', () => {
    const { d, advance } = build()
    d.playReveal(); advance(20); d.tick(); d.onFrozen()
    d.playExit(); advance(2); d.tick()
    expect(d.getExitProgress()).toBeCloseTo(0.5, 2)

    d.playReveal()
    expect(d.getExitProgress()).toBe(0)
    expect(d.getRevealProgress()).toBe(0)
  })
})
