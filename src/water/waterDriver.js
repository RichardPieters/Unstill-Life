/**
 * waterDriver.js — the water surface's per-frame animation: the reactive sea
 * level, the ripple clock and the foam/sparkle/deep-colour reactions.
 *
 * STATE
 *   seaLevel     smoothed waterline, eased each tick toward the band target
 *                low + (high − low) × (1 − restlessness)
 *   rippleTime   the swell's clock (uTime): dt × wave speed × a momentum pace
 *   settings     the sea band (seaLow, seaHigh), the foam and deep-colour
 *                shares of the water's depth and the sparkle cutoff; each tick
 *                derives the live uniforms from them. water.params writes them
 *                (waterParams.js rows); a band write snaps via snapSeaLevel()
 *
 * THE TICK  (dynamics 'tick', so it holds still while the scene is frozen; dt
 *   is sim-scaled, so ripples keep step with the terrain)
 *   1. sea level eases toward the band target, applied to the mesh
 *   2. ripple clock advances
 *   3. foam reach and deep-colour depth scale to the water depth available;
 *      momentum widens the foam and tightens the sparkle cutoff
 *
 * Owned by Water, which hands in its material uniforms by reference and a
 * callback that moves the mesh, and reads and writes `settings`. Writes `.value`
 * on those uniforms, never replaces one. The pure maps are in waterMath.js.
 */

import {
  seaLevelStep, rippleAdvance, foamWidthForMomentum, sparkleForMomentum,
  depthShare,
} from './waterMath.js'
import { WATER_PARAMS } from './waterParams.js'
import { rowDefaults } from '../shared/paramSchema.js'

// The sea band in force until main.js's boot form.apply() replaces it from the
// form dials (drift/terrainForm.js): the rows' defaults. main.js pushes
// getSeaLevel() into the terrain's `seaLevel` param every frame, so this band,
// not the terrain's uSeaLevel default, sets the waterline.
const DEFAULT = rowDefaults(WATER_PARAMS)

// How fast the waterline closes on the band target, per second of sim time: it
// drifts rather than snaps (90% of a step takes about 2 s).
const SEA_EASE_RATE = 1.2

// Ripple pace at momentum 0 and 1 (calm crawls, agitated churns).
const RIPPLE_SPEED_MIN = 0.4
const RIPPLE_SPEED_MAX = 1.8

// How far momentum 1 lowers the sparkle cutoff (denser glitter).
const SPARKLE_MOMENTUM_RANGE = 0.10

// Foam-reach factor at momentum 0 and 1 (thin lapping edge → surf).
const FOAM_WIDTH_MOMENTUM_LO = 0.6
const FOAM_WIDTH_MOMENTUM_HI = 1.5

// Terrain amp sum until main.js's first setTerrainScale(), which it pushes
// before the boot tick (dynamics.broadcastState).
const TERRAIN_SCALE_INIT = 249.5

export class WaterDriver {
  // ─── state ─────────────────────────────────────────────────────────────────

  /**
   * @param {EventTarget} dynamics       emits 'tick' { dt, momentum, restlessness }
   * @param {object} uniforms            the water material's uniforms (by reference)
   * @param {(y:number)=>void} applySeaLevel  moves the mesh to the smoothed sea level
   */
  constructor(dynamics, uniforms, applySeaLevel) {
    this._u = uniforms
    this._applySeaLevel = applySeaLevel

    // The bases start at the rows' defaults (the glint cutoff, at its uniform's seed).
    this.settings = {
      seaLow:           DEFAULT.seaLow,
      seaHigh:          DEFAULT.seaHigh,
      foamShare:        DEFAULT.foamShare,
      sparkleThreshold: uniforms.uSparkleThreshold.value,
      deepShare:        DEFAULT.deepShare,
    }
    this._seaLevel = DEFAULT.seaLow
    // Last restlessness a tick reported, so a band snap can find the target.
    // Assumed calm (1, target = low) until the first tick. The start scene's
    // restore (main.js) sets the level itself.
    this._lastRestlessness = 1.0
    this._applySeaLevel(this._seaLevel)

    this._rippleTime    = 0

    this._terrainScale = TERRAIN_SCALE_INIT
    // Wave speed (animSpeed), pushed by main.js each frame; 1 = the momentum
    // pace alone. A tick uses whatever was last pushed.
    this._animSpeed = 1

    dynamics.addEventListener('tick', e => {
      const { dt, restlessness, momentum } = e.detail
      this._lastRestlessness = restlessness
      this._stepSeaLevel(restlessness, dt)
      this._stepRipple(dt, momentum)
      this._stepReactiveUniforms(momentum)
    })
    this._stepReactiveUniforms(0)
  }

  // ─── sea band ──────────────────────────────────────────────────────────────

  /**
   * Jump the smoothed level straight to the band's current target. A deliberate
   * band write calls this, for two reasons:
   *  · the easing needs about 2 s for 90% of a step, so a drag showed nothing;
   *  · `high` reaches the target only in proportion to (1 − restlessness), so
   *    near restlessness 1 (say 0.99) a 20-unit drag on `high` moves it 0.2.
   * A caller that writes the band every tick (the form walker) must not: snapping
   * at frame rate would pin the level to the target and remove the smoothing
   * entirely (water.js withSeaSnap).
   */
  snapSeaLevel() {
    const { seaLow, seaHigh } = this.settings
    // smooth = 1 → seaLevelStep returns the target outright.
    this._seaLevel = seaLevelStep(this._seaLevel, seaLow, seaHigh, this._lastRestlessness, 1.0)
    this._applySeaLevel(this._seaLevel)
  }

  /**
   * Snapshot (sceneSnapshot.js via Water): the smoothed sea level, the one
   * driver state no uniform or row holds. The band and the three bases are
   * `settings`, captured as water.params rows.
   */
  exportState() {
    return { seaLevel: this._seaLevel }
  }

  /**
   * Restore a snapshot; applies the sea level to the mesh at once. The ripple
   * clock is not a key here: water.js restores uTime (integrated) first, and the
   * driver resumes from it, as terrain's driver does, so the next tick does not
   * step the swell back to the live clock.
   */
  importState(s) {
    if (s.seaLevel != null) { this._seaLevel = s.seaLevel; this._applySeaLevel(this._seaLevel) }
    this._rippleTime = this._u.uTime.value
  }

  // ─── per-frame inputs (pushed by main.js) ──────────────────────────────────

  /** The terrain's fBM amplitude sum. Pushed every frame, so it follows the
   *  amps whichever control moves them. */
  setTerrainScale(ampSum) { this._terrainScale = ampSum }

  /** Wave speed multiplier on the ripple clock (animSpeed.getWaveSpeed()). */
  setAnimSpeed(v) { this._animSpeed = v }

  // ─── outputs ───────────────────────────────────────────────────────────────

  /** The smoothed sea level; main.js passes it on to terrain each frame. */
  getSeaLevel() { return this._seaLevel }

  /** The ripple clock, the uTime water.frag's swell()/wave() read. audio.js
   *  times surf breaks to it: the same field the foam is computed from, not a
   *  separate oscillator that would drift out of sync. */
  getRippleTime() { return this._rippleTime }

  // ─── tick steps ────────────────────────────────────────────────────────────

  _stepSeaLevel(restlessness, dt) {
    const { seaLow, seaHigh } = this.settings
    const smooth = 1 - Math.exp(-SEA_EASE_RATE * dt)
    this._seaLevel = seaLevelStep(this._seaLevel, seaLow, seaHigh, restlessness, smooth)
    this._applySeaLevel(this._seaLevel)
  }

  _stepRipple(dt, momentum) {
    this._rippleTime = rippleAdvance(this._rippleTime, dt * this._animSpeed, momentum, RIPPLE_SPEED_MIN, RIPPLE_SPEED_MAX)
    this._u.uTime.value = this._rippleTime
  }

  /** Foam reach and deep-colour depth are shares of the depth available
   *  (waterMath's depth-scaling note), in world units for the shader. */
  _stepReactiveUniforms(momentum) {
    const { foamShare, deepShare, sparkleThreshold } = this.settings
    this._u.uFoamWidth.value = foamWidthForMomentum(
      depthShare(foamShare, this._terrainScale, this._seaLevel),
      momentum, FOAM_WIDTH_MOMENTUM_LO, FOAM_WIDTH_MOMENTUM_HI)
    this._u.uDepthMax.value =
      depthShare(deepShare, this._terrainScale, this._seaLevel)
    this._u.uSparkleThreshold.value =
      sparkleForMomentum(sparkleThreshold, momentum, SPARKLE_MOMENTUM_RANGE)
  }
}
