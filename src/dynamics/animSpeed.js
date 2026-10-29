/**
 * animSpeed.js — how fast water ripples and cloud drift move: the cycle's
 * second pace, next to momentum (which sets how fast the terrain reshapes).
 *
 *   speed = target × restlessness        target: slider, default 0.6
 *
 *   FADE     Tracked directly every frame, so water and clouds slow with
 *            restlessness and stop exactly as the freeze lands.
 *   HOLD     While a painting holds the scene, speed is 0. Holding = the art
 *            pass is on and not exiting, or its exit is a random one, which
 *            keeps the world still while it plays (`holdsSceneStill()`).
 *   RESUME   When a hold ends, restlessness is usually already back at 1, so
 *            tracking would jump to full speed. Instead speed eases toward
 *            target × restlessness with the art pass's `exitResumeEase` as time
 *            constant, then tracks directly again.
 *   WEATHER  Water and clouds read speed × `weatherSpeedFactor`: a grey sky
 *            hurries the waves (gain 0.25) and the clouds (gain 0.65).
 *
 * Reads artPass (`enabled`, `isExitPlaying()`, `holdsSceneStill()`,
 * `params.get('exitResumeEase')`) and `dynamics.restlessness`. main.js pushes the
 * visible overcast and calls update() each rendered frame, with dt 0 while paused.
 */

import { clamp01 } from '../shared/mathUtils.js'
import { paramAccess } from '../shared/paramAccess.js'
import { ANIM_SPEED_PARAMS } from './dynamicsParams.js'

// Closer than this to its target, the resume ease hands back to direct
// tracking, so the next fade follows restlessness without the ease's lag.
const RESUME_CONVERGED_EPS = 1e-4

/**
 * How much faster the ambient motion runs under a grey sky: `1 + gain × drive`.
 * A multiplier that is exactly 1 under a clear sky (drive 0), so the weather
 * only ever adds to the pace. Linear because the drive is already the SHAPED
 * overcast, the curve every visible overcast effect goes through.
 *
 * @param drive [0,1] shaped overcast — how grey the sky visibly is
 * @param gain  how much faster at full overcast; 0 disables, 1 doubles
 * @returns the multiplier, >= 1
 */
export function weatherSpeedFactor(drive, gain) {
  const d = clamp01(drive)
  const g = Number.isFinite(gain) ? Math.max(0, gain) : 0
  return 1 + g * d
}

export class AnimSpeed {
  // ─── state ─────────────────────────────────────────────────────────────────

  /**
   * @param {{ enabled: boolean, isExitPlaying(): boolean, holdsSceneStill(): boolean, params: { get(key: string): number } }} artPass
   * @param {{ restlessness: number }} dynamics
   * @param {number} [speed] initial target, in place of the row's default
   */
  constructor(artPass, dynamics, speed) {
    this._artPass  = artPass
    this._dynamics = dynamics

    const rows = Object.fromEntries(ANIM_SPEED_PARAMS.map(r => [r.key, r.value]))
    this._target       = Math.max(0, speed ?? rows.targetSpeed)
    this._waveWeather  = rows.waveWeatherGain
    this._cloudWeather = rows.cloudWeatherGain
    // A setting that is not a finite number leaves the value alone; the
    // slider range is the panel's, not a limit here, except the floor of 0.
    const field = prop => ({
      get: () => this[prop],
      set: v => { if (Number.isFinite(v)) this[prop] = Math.max(0, v) },
    })
    this.params = paramAccess({
      tables: [],
      rows: ANIM_SPEED_PARAMS,
      fields: { targetSpeed: field('_target'), waveWeatherGain: field('_waveWeather'), cloudWeatherGain: field('_cloudWeather') },
    })

    this._speed        = this._target
    this._weatherDrive = 0
    this._wasHolding   = false
    this._resuming     = false
  }

  /** Snapshot (sceneSnapshot.js): the three settings. The live speed is
   *  re-derived from restlessness and the art pass on the next update(). */
  exportState() { return this.params.export() }

  importState(state) { this.params.import(state) }

  // ─── per-frame input ───────────────────────────────────────────────────────

  /**
   * How grey the sky visibly is, [0,1]: atmosphere.getOvercastShaped(), pushed
   * by main.js before update(). Not the raw walk, which is a third into the
   * weather while the sky on screen is still clear.
   */
  setWeatherDrive(v) { if (Number.isFinite(v)) this._weatherDrive = clamp01(v) }

  // ─── outputs ───────────────────────────────────────────────────────────────

  /** The pace before the weather factor; exactly 0 while a painting holds. Audio reads it. */
  getSpeed() { return this._speed }

  /** What the water reads: the pace hurried by the visible weather. */
  getWaveSpeed()  { return this._speed * weatherSpeedFactor(this._weatherDrive, this._waveWeather) }
  /** What cloud drift reads. Same shape, its own gain. */
  getCloudSpeed() { return this._speed * weatherSpeedFactor(this._weatherDrive, this._cloudWeather) }

  // ─── lifecycle ─────────────────────────────────────────────────────────────

  /** Advance one frame. `dt` in real seconds, used only by the resume ease. */
  update(dt) {
    const holding = this._isHolding()
    if (holding) {
      this._resuming = false
      this._speed = 0
    } else {
      if (this._wasHolding) this._resuming = true   // the hold ended this frame
      this._stepSpeed(dt)
    }
    this._wasHolding = holding
  }

  // ─── update() steps ────────────────────────────────────────────────────────

  /**
   * A drift exit is not a hold: it dissolves each stroke against how far the
   * live scene has moved, so it needs motion from its first frame. A random
   * exit holds for its whole run.
   */
  _isHolding() {
    const a = this._artPass
    return a.enabled && (!a.isExitPlaying() || a.holdsSceneStill())
  }

  /**
   * Track target × restlessness directly, or ease toward it while resuming.
   * `1 − exp(−dt/tau)` is the exact step of an exponential ease, so the climb is
   * frame-rate independent; tau = 0 snaps.
   */
  _stepSpeed(dt) {
    const tracked = this._target * clamp01(this._dynamics.restlessness)
    if (!this._resuming) {
      this._speed = tracked
      return
    }
    const tau = this._artPass.params.get('exitResumeEase')
    const approach = tau > 0 ? 1 - Math.exp(-dt / tau) : 1
    this._speed += (tracked - this._speed) * approach
    if (Math.abs(this._speed - tracked) < RESUME_CONVERGED_EPS) this._resuming = false
  }
}
