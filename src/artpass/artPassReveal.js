import { revealPhase, groundBeatProgress, exitFade, smoothstep01 } from './artPassMath.js'

/**
 * artPassReveal.js — the art pass's entrance/exit state machine.
 *
 * The part of the art pass with real logic rather than plumbing: every
 * transition, including the ones cut short by the opposite transition arriving
 * mid-flight. It owns no GPU resources and writes nothing: what it asks of the
 * picture is `values`, which the pass applies, and time comes through `now`, so
 * the whole machine runs in a vitest unit spec with a hand-advanced clock.
 *
 * WHY A WALL CLOCK AT ALL, rather than the loop's dt: this pass is expensive
 * enough that a slow machine must not play the reveal in slow motion and a fast
 * one must not race through it, and the animation deliberately keeps running
 * while the SIMULATION is paused — the landscape holds still while its own
 * portrait is painted over it.
 *
 * THE LIFECYCLE, and who moves it:
 *
 *   rest ──playReveal()──> revealing ──(progress 1)──> needsFreeze
 *                                                          │
 *                                        render() takes the hold: onFrozen()
 *                                                          ↓
 *                                                        held
 *                                                          │
 *                           playExit() ───────────────────┘
 *                                ↓
 *                            exiting ──(progress 1)──> finished ──> rest
 *
 * `held` means "stop repainting this picture, it is done" — render() then
 * serves a frozen copy instead of repainting, which is what makes
 * a finished painting cheap. Every arrow above can also be cut short by the
 * opposite transition arriving mid-flight; see playReveal/playExit.
 */
/**
 * The values at REST: fully painted, nothing animating, nothing taken away.
 * `exitFade` multiplies the canvas weave, the crevice shading and the high-key
 * lift in artFinish.frag, so 1 is the only value those three see outside an
 * exit. `lighten` is not listed: a finished painting rests with the canvas
 * toned at the priming ceiling (`revealPrimeLighten`), the same wash a played
 * reveal ends on, so it follows that setting (see `tick`).
 */
const REST_VALUES = { spawn: 1, ground: 1, weave: 1, relief: 1, exitFade: 1, exitProgress: 0 }

export class RevealDirector {
  /**
   * @param {object}   deps
   * @param {()=>object} deps.getState  the pass's params by key (durations, modes)
   * @param {()=>number} [deps.now]     ms clock; injectable so tests need no waiting
   */
  constructor({ getState, now = () => performance.now() }) {
    this._getState = getState
    this._now = now

    this._values = { ...REST_VALUES, lighten: getState().revealPrimeLighten }
    this._revealPlaying = false
    this._exitPlaying = false
    this._held = false
    this._freezeRequested = false
    this._exitFinished = false
    this._growthNeedsBuild = false
    // Strokes have birth times: true from playReveal() until the picture is held.
    this._gateBirths = false
    this._revealStart = 0
    this._exitStart = 0
  }

  /**
   * What the animation asks of the picture right now, one number each (the
   * director owns no GPU resources, so the pass applies them):
   *
   *   spawn         how many marks have arrived, [0,1]; 1 at rest
   *   ground        0 the live frame … 1 the configured ground
   *   weave         how far the canvas weave has arrived, [0,1]
   *   lighten       the wash toward the ground colour; the priming ceiling at rest
   *   relief        how much of the paint's thickness is lit
   *   exitFade      how present the canvas surface still is, 1 at rest
   *   exitProgress  how far the dissolve has run; 0 outside an exit
   *
   * The same object is updated in place: read it, do not keep it.
   */
  get values() { return this._values }

  /** Replace the clock, `now: () => ms`: tests that step time by hand. */
  setClock(now) { this._now = now }

  // ─── queries ───────────────────────────────────────────────────────────────

  /** Mid-entrance. The render loop keeps drawing frames while this is true. */
  isRevealPlaying() { return this._revealPlaying }

  /** Mid-exit. Same reason the loop watches it: a wall-clock animation needs
   *  frames to keep coming, whatever the simulation is doing. */
  isExitPlaying() { return this._exitPlaying }

  /** Finished and holding a frozen copy — render() skips the repaint. */
  isHeld() { return this._held }

  /** The exit has played its last frame and the pass can switch itself off. */
  isFinished() { return this._exitFinished }

  /** render() should take its hold of the picture after this frame's paint. */
  needsFreeze() { return this._freezeRequested }

  /** Strokes have birth times: a reveal is playing, or was cut short and has
   *  not yet been held. At rest every stroke is simply born. */
  gatesBirths() { return this._gateBirths }

  /** render() should solve the growth field before the next paint. */
  needsGrowthBuild() { return this._growthNeedsBuild }

  /** How far the canvas toning has arrived, [0,1]. 1 once painting begins. */
  getPrimeProgress() { return this._values.weave }

  /** How far the MARKS have arrived, [0,1] — 0 for the whole priming phase,
   *  then 0→1 across the paint. The reveal's own `p`. */
  getRevealProgress() { return this._values.spawn }

  /** How far the dissolve has run, [0,1]. 0 whenever no exit is in flight. */
  getExitProgress() { return this._values.exitProgress }

  // ─── transitions ───────────────────────────────────────────────────────────

  /**
   * Back to the REST state: fully painted, nothing animating, repainting live.
   *
   * Rest is LIVE, not held — everything that snaps the pass on rather than
   * playing it in (tests, snapshot restore, the panel checkbox) must land on a
   * pass that repaints every frame. Only a reveal running to completion starts
   * holding.
   */
  reset() {
    this._revealPlaying = false
    this._exitPlaying = false
    this._held = false
    this._freezeRequested = false
    this._exitFinished = false
    this._gateBirths = false
    Object.assign(this._values, REST_VALUES)
    this._values.lighten = this._getState().revealPrimeLighten
  }

  /**
   * Start the entrance: the picture is painted in rather than appearing whole.
   *
   * Takes over from an exit still in flight. Attention is a live signal, so it
   * can cross back over the threshold at any moment, including halfway through
   * a dissolve, and this is what that arrives as. The takeover is required: if
   * both animations ran, the exit would advance to the end and switch the pass
   * off under the new reveal, while its hold made render() skip the repaint,
   * so the reveal would never be drawn — sim frozen, nothing painted, and no
   * further 'freeze' coming because dynamics only fires that on the crossing it
   * has already made.
   */
  playReveal() {
    this._revealStart = this._now()
    this._revealPlaying = true
    this._exitPlaying = false
    this._exitFinished = false
    this._values.exitProgress = 0
    this._values.exitFade = 1
    // Back to painting live: an entrance repaints as strokes arrive, and an
    // interrupted exit leaves the picture held, which would otherwise keep
    // serving the frozen copy the dissolve was eating.
    this._held = false
    this._freezeRequested = false
    // The growth field is a snapshot of the frame at the moment growth starts,
    // not something recomputed continuously — rebuilding it every frame would
    // spend a whole extra jump-flood chain's worth of GPU work on an animation
    // that only needs to solve it once. render() does the actual GPU work the
    // next time it runs, since building it needs the composited frame.
    this._growthNeedsBuild = true
    this._gateBirths = true

    this._values.spawn = 0
    this._values.ground = 0
    this._values.relief = 0
    this._values.weave = 0
    this._values.lighten = 0
  }

  /**
   * Start the exit: the painting comes apart as the landscape resumes.
   *
   * The strokes are already a still image by this point — a completed reveal
   * leaves the lattice held — so they simply do not track the landscape moving
   * underneath them. This is what then takes them away: each stroke leaves once
   * the live frame has drifted far enough from the one it was painted from,
   * with a closing sweep to guarantee the picture ends empty (artDissolve.frag).
   *
   * @returns {boolean} whether an exit actually started
   */
  playExit() {
    // Already leaving. Restarting would snap the progress back to 0, putting
    // the whole painting back at full strength for the viewer to watch dissolve
    // a second time — a visible stutter rather than a continuation. The exit
    // owns its own completion; let it finish.
    if (this._exitPlaying) return false
    this._exitStart = this._now()
    this._exitPlaying = true
    this._revealPlaying = false
    // Reset the readout alongside the uniform. _tickExit only runs from inside
    // artPass.render(), so without this the frames before the next art-pass
    // render would report the PREVIOUS exit's progress — 1 after a completed
    // one, i.e. "already fully dissolved" as the dissolve begins.
    this._values.exitProgress = 0
    // A pass switched on directly rather than revealed has nothing held yet, so
    // the exit takes its own hold on the way out. Either way what the dissolve
    // measures against is the frame as it was when the picture stopped being
    // repainted.
    if (!this._held) this._freezeRequested = true
    return true
  }

  /** render() has taken its hold of the finished picture. */
  onFrozen() {
    this._held = true
    this._freezeRequested = false
    this._gateBirths = false
  }

  /** render() has solved the growth field for the reveal now running. */
  onGrowthBuilt() { this._growthNeedsBuild = false }

  /** Whatever was baked is the wrong size — solve it again before the next
   *  paint. A resize is the caller. Only an entrance reads the field, and
   *  playReveal() asks for a fresh one, so at rest or while held there is
   *  nothing to redo (the solve reads back from the GPU). */
  markGrowthStale() { if (this._revealPlaying) this._growthNeedsBuild = true }

  /**
   * Let go of the held copy, which is the wrong size.
   *
   * A resize throws the held picture away outright — it was rendered at the old
   * size — so the next frame repaints at the new size instead of stretching it,
   * and, outside a reveal, takes a new hold of that repaint. Without the new
   * hold a finished painting would be repainted on every frame from then on.
   */
  dropHold() {
    this._held = false
    this._freezeRequested = !this._revealPlaying
  }

  /**
   * Go back to painting live, because something changed what the picture should
   * look like. A held pass would otherwise appear dead to the panel: dragging
   * `stroke size` would move a slider and change nothing on screen.
   *
   * The next frame repaints and, since the reveal is over, immediately holds
   * again — so the painting stays a still image and stays editable at once.
   *
   * Suppressed while an exit is in flight. `isHeld()` stays true for the whole
   * exit (the dissolve reads straight through the held buffers), so without
   * this an exit is indistinguishable from a picture at rest — any colour,
   * ground-mode or toggle change, including the ones the ambient weather walk
   * fires on its own every few frames as overcast/haze drift, would repaint
   * and re-freeze from the CURRENT frame, wiping the dissolve's ratchet memory
   * back to full. The painting would keep snapping back to full strength and
   * redissolving until the exit's clock finally ran out from underneath it —
   * exactly what this guards against. The exit owns its own completion (see
   * playExit); nothing should perturb it mid-flight, whoever asks.
   */
  thaw() {
    if (!this._held || this._exitPlaying) return
    this._held = false
    this._freezeRequested = !this._revealPlaying
  }

  // ─── per-frame ─────────────────────────────────────────────────────────────

  /** Advance whichever animation is live. Call once per rendered frame. */
  tick() {
    if (this._revealPlaying) this._tickReveal()
    // Outside a reveal the canvas stays toned at the ceiling, wherever the
    // slider currently is.
    else this._values.lighten = this._getState().revealPrimeLighten
    if (this._exitPlaying) this._tickExit()
  }

  _tickReveal() {
    const s = this._getState()
    const elapsed = (this._now() - this._revealStart) / 1000
    const phase = revealPhase(elapsed, s.revealPrimeDuration, s.revealDuration)

    if (phase.priming) {
      this._values.weave = phase.primeProgress
      this._values.lighten = phase.primeProgress * s.revealPrimeLighten
      // Nothing else has started yet.
      this._values.spawn = 0
      this._values.relief = 0
      this._values.ground = 0
      return
    }

    // Priming is over: the canvas holds at its settled state — weave fully
    // arrived, the wash pinned at its ceiling — for the rest of the reveal, the
    // way a real primed canvas stays toned once painting begins rather than
    // reverting the moment the first mark lands.
    this._values.weave = 1
    this._values.lighten = s.revealPrimeLighten

    const p = phase.progress
    this._values.spawn = p
    // Relief trails the marks: coverage completes, THEN the paint visibly
    // thickens under the lamp, instead of gaining depth the instant it lands.
    this._values.relief = smoothstep01(0.25, 1, p)
    this._values.ground = groundBeatProgress(p, s.revealGroundBeat, s.revealUnderpaintFirst)

    if (p >= 1) {
      this._revealPlaying = false
      // The picture is finished, so stop repainting it. render() performs the
      // copy, because holding the lattice means copying the target the paint
      // pass has just written, and that only exists there.
      this._freezeRequested = true
    }
  }

  _tickExit() {
    const s = this._getState()
    const elapsed = (this._now() - this._exitStart) / 1000
    const p = Math.min(elapsed / Math.max(s.exitDuration, 0.05), 1)
    this._values.exitProgress = p
    this._values.exitFade = exitFade(p, { random: s.exitRandom, sweep: s.exitSweep })
    // Note what this does NOT do: switch the pass off. The frame that reaches
    // progress 1 is the one where the closing sweep has finally taken
    // everything, and it still has to be DRAWN — tearing down here instead
    // skips the dissolve on that frame and puts the whole painting back at full
    // strength for exactly one frame before the pass goes quiet, which on a
    // paused scene is then the frame left on screen. render() finishes the job
    // after the draw.
    if (p >= 1) this._exitFinished = true
  }
}
