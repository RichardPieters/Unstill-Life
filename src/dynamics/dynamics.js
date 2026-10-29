/**
 * dynamics.js — the scene's state machine: how attention turns into motion,
 * and when the moving landscape settles into a painting.
 *
 * STATE
 *   momentum      [0,1]  scene energy; eases toward 1 − attention (capped 0.95)
 *   noiseSpeed           2.5 × momentum — how fast the landscape evolves
 *   noiseTime            position on the noise time axis, advanced by noiseSpeed
 *   restlessness  [0,1]  countdown to the painting; 0 = frozen
 *
 * THE CYCLE
 *   1. Attention above the threshold (default 0.9): restlessness falls, faster
 *      at low momentum. Below it: restlessness climbs back toward 1.
 *   2. Restlessness 0: frozen. update() stops advancing and stops sending
 *      'tick'; 'freeze' fires and main.js paints the frame. The reveal is the
 *      point of no return: main.js does not call update() while it plays, so
 *      attention is not read until the painting is complete.
 *   3. Attention below the threshold: 'unfreeze', restlessness back to 1;
 *      main.js dissolves the painting.
 *
 * Momentum is 0 while frozen and eases up from 0 after each unfreeze. Below
 * restlessness 0.1 the published value fades with restlessness, reaching 0 as
 * the freeze lands.
 *
 * A painting the cycle did not cause (debug checkbox, snapshot restore) is
 * covered by `hold()`: a silent freeze attention cannot wake, released by
 * `wake()`. A painting therefore always means frozen.
 *
 * A new instance starts frozen with momentum 0, like every other painting (the
 * piece opens as one); pass `restlessness > 0` for a running one. main.js calls
 * `broadcastState()` once after wiring, so listeners take the starting noiseTime.
 *
 * EVENTS  'tick' { dt, momentum, restlessness, noiseTime } · 'freeze' · 'unfreeze'
 */

import { clamp, clamp01 } from '../shared/mathUtils.js'
import { paramAccess } from '../shared/paramAccess.js'
import { DYNAMICS_PARAMS } from './dynamicsParams.js'

// Momentum's target is capped below 1: at exactly 1 the `(1 − momentum)` decay
// gate is zero and restlessness would never fall again.
const MOMENTUM_TARGET_MAX = 0.95

// noiseSpeed at momentum 1 (debugPanel reads this for the bar scale).
export const NOISE_SPEED_MAX = 2.5

// Restlessness's resting-full value.
const RESTLESSNESS_RESET = 1.0

// Below this restlessness, the published momentum is faded toward 0.
const RESTLESS_FADE_WINDOW = 0.1

// Stand-in for a non-finite attention reading (a stalled mic): neither pushes
// the scene toward the painting nor wakes it.
const NEUTRAL_ATTENTION = 0.5

export class Dynamics extends EventTarget {
  // ─── state ─────────────────────────────────────────────────────────────────

  constructor({ momentum = 0, restlessness = 0, noiseTime = 6, noiseSpeed = 0 } = {}) {
    super()
    this._momentum     = momentum   // eased value; `momentum` publishes it with the fade
    this.restlessness  = restlessness
    this.noiseTime     = noiseTime
    this.noiseSpeed    = noiseSpeed

    const rows = Object.fromEntries(DYNAMICS_PARAMS.map(r => [r.key, r.value]))
    this._momentumTau = rows.momentumTau
    this._settleIntervalAtMaxAttention = rows.settleIntervalAtMaxAttention
    this._unfreezeAttention = rows.unfreezeAttention
    // The setters keep what the arithmetic needs: a finite tau >= 0, a settle
    // interval > 0, a finite threshold; anything else leaves the value alone.
    this.params = paramAccess({
      tables: [],
      rows: DYNAMICS_PARAMS,
      fields: {
        momentumTau: {
          get: () => this._momentumTau,
          set: v => { if (Number.isFinite(v)) this._momentumTau = Math.max(0, v) },
        },
        settleIntervalAtMaxAttention: {
          get: () => this._settleIntervalAtMaxAttention,
          set: v => { if (Number.isFinite(v) && v > 0) this._settleIntervalAtMaxAttention = v },
        },
        unfreezeAttention: {
          get: () => this._unfreezeAttention,
          set: v => { if (Number.isFinite(v)) this._unfreezeAttention = v },
        },
      },
    })

    this._frozen = this.restlessness <= 0
    this._held = false
  }

  /** Scene energy as the rest of the system sees it: the eased value, faded
   *  toward 0 over the last RESTLESS_FADE_WINDOW of restlessness. */
  get momentum() {
    if (this._frozen) return this._momentum
    const r = this.restlessness
    return r < RESTLESS_FADE_WINDOW ? this._momentum * Math.max(0, r) / RESTLESS_FADE_WINDOW : this._momentum
  }
  set momentum(v) { this._momentum = v }

  /** True while restlessness is at 0 and the sim is holding (update() sends no 'tick'). */
  isFrozen() { return this._frozen }
  /** True while frozen by hold(): attention cannot unfreeze it, only wake(). */
  isHeld() { return this._held }

  /**
   * Snapshot (sceneSnapshot.js): the three settings plus noiseTime, so a
   * restored scene resumes from the snapshot's landscape instead of jumping to
   * wherever the live noiseTime was. Momentum, restlessness and the frozen flag
   * are left out: a restore pauses, and the attention input re-derives them.
   */
  exportState() {
    return { ...this.params.export(), noiseTime: this.noiseTime }
  }

  importState(state) {
    this.params.import(state)
    if (Number.isFinite(state.noiseTime)) this.noiseTime = state.noiseTime
  }

  // ─── lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Dispatch one 'tick' (dt = 0) carrying the current state, so listeners that
   * subscribed after construction take the starting noiseTime. Changes no
   * dynamics state and fires no 'freeze'/'unfreeze'. Call once, after every
   * listener is wired: listeners that smooth per tick (the sea level) still
   * take one step, so it is not a free re-sync.
   */
  broadcastState() {
    this._dispatchTick(0)
  }

  /**
   * Freeze silently for a painting the cycle did not cause (debug checkbox,
   * snapshot restore, test hook). Fires no 'freeze' — the painting is already
   * there — and attention cannot unfreeze it; only wake() releases it.
   */
  hold() {
    this._enterFrozen()
    this._held = true
  }

  /**
   * Back to full restlessness and running. For a painting that went away
   * without an unfreeze: switched off by hand, or the exit dissolve finishing
   * while attention had already pushed restlessness down again. Fires
   * 'unfreeze' if the sim was frozen, so its listeners see the transition.
   */
  wake() {
    this.restlessness = RESTLESSNESS_RESET
    this._held = false
    if (this._frozen) {
      this._frozen = false
      this._momentum = 0
      this.dispatchEvent(new CustomEvent('unfreeze'))
    }
  }

  /**
   * Advance state one frame and dispatch 'tick'. The steps run in a fixed
   * order: each reads what the one before it wrote.
   * @param {number} dt              - delta time in seconds
   * @param {number} attentionLevel  - [0,1] from interaction.js
   */
  update(dt, attentionLevel) {
    // A NaN or out-of-range reading must never reach momentum, or it poisons
    // noiseTime and every uniform downstream.
    const attention = Number.isFinite(attentionLevel) ? clamp01(attentionLevel) : NEUTRAL_ATTENTION

    if (this._frozen && !this._tryUnfreeze(attention)) return

    // Heading toward a freeze this frame (true) or climbing back toward 1.
    const decaying = attention > this._unfreezeAttention

    this._stepMomentum(dt, attention)
    this._stepNoise(dt)
    this._stepRestlessness(dt, decaying)
    this._freezeIfSettled()
    this._dispatchTick(dt)   // also on the freezing frame
  }

  // ─── update() steps ────────────────────────────────────────────────────────

  /** While frozen: unfreeze if attention dropped below the threshold (never while held). Returns whether the sim runs this frame. */
  _tryUnfreeze(attention) {
    if (this._held || attention >= this._unfreezeAttention) return false
    this._frozen = false
    this.restlessness = RESTLESSNESS_RESET
    this._momentum = 0
    this.dispatchEvent(new CustomEvent('unfreeze'))
    return true
  }

  /**
   * Attention picks the momentum level (high attention → low momentum → faster
   * freeze). `1 − exp(−dt/tau)` is the exact solution of dm/dt = (target − m)/tau
   * over the step, so the ease is frame-rate independent and stable for any dt.
   * tau = 0 snaps (and avoids 0/0 when three's Clock returns dt = 0 on its
   * first call).
   */
  _stepMomentum(dt, attention) {
    const target = clamp(1 - attention, 0, MOMENTUM_TARGET_MAX)
    const approach = this._momentumTau > 0 ? 1 - Math.exp(-dt / this._momentumTau) : 1
    this._momentum += (target - this._momentum) * approach
  }

  /** noiseSpeed proportional to the published (faded) momentum; advance noiseTime. */
  _stepNoise(dt) {
    this.noiseSpeed = NOISE_SPEED_MAX * this.momentum
    this.noiseTime += this.noiseSpeed * dt
  }

  /**
   * Decays while attention is above the threshold (lower momentum → faster),
   * otherwise rises linearly back to 1. Both at 1 / settleInterval.
   */
  _stepRestlessness(dt, decaying) {
    const rate = 1 / this._settleIntervalAtMaxAttention
    if (decaying) {
      const decayFactor = 1 - this.momentum
      this.restlessness -= rate * decayFactor * dt
    } else {
      this.restlessness = Math.min(RESTLESSNESS_RESET, this.restlessness + rate * dt)
    }
  }

  /** Restlessness reached 0: freeze in place. */
  _freezeIfSettled() {
    if (this.restlessness > 0) return
    this._enterFrozen()
    this.dispatchEvent(new CustomEvent('freeze'))
  }

  _enterFrozen() {
    this.restlessness = 0
    this._momentum = 0
    this.noiseSpeed = 0
    this._frozen = true
  }

  _dispatchTick(dt) {
    this.dispatchEvent(new CustomEvent('tick', {
      detail: {
        dt,
        momentum:     this.momentum,
        restlessness: this.restlessness,
        noiseTime:    this.noiseTime,
      },
    }))
  }
}
