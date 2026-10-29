import { computeHeightMax, driftAngleStep, nonNegDelta, mantleDcCoefficient, hNormFor } from './terrainMath.js'
import { TERRAIN_PARAMS } from './terrainParams.js'

/**
 * terrainDriver.js — the terrain's per-frame animation driver.
 *
 * STATE     two drift-angle random walks (one per fBM instance), and
 *           `settings`: the base speeds, the drift switch and the test-only
 *           freeze. Their defaults are
 *           terrainParams.js rows; Terrain exposes them as `terrain.params`
 *           fields.
 * EACH TICK (dynamics 'tick' { dt, momentum, noiseTime }):
 *   1. range   uHeightMax (amps + erosion margin) and uMantleDC, from the live
 *              sliders, so biome bands never drift from the amp/persistence knobs
 *   2. drift   turn each heading on a slow sinusoid scaled by momentum, then set
 *              the DriftX/Z velocity uniforms
 *   3. offset  integrate velocity into the DriftOffset uniforms; write uTime
 *
 * Owned privately by Terrain and constructed last, after both materials exist.
 * It writes `.value` on the given uniform objects only — never reassigns one:
 * the heightmap and derive passes share the fBM/drift uniform objects by
 * reference, and a reassignment would desync them. The pure maps live in
 * terrainMath.js.
 */

// ── Constants used only by the driver ────────────────────────────────────────
const DRIFT_ANGULAR_SPEED  = 0.20  // rad/s amplitude — direction can increase or decrease

// ── Constants shared with terrain.js's initial uniform values (exported) ─────
export const DRIFT_INITIAL_ANGLE_0 = 0.0            // instance 0 starts pointing right
export const DRIFT_INITIAL_ANGLE_1 = Math.PI * 0.65 // instance 1 starts ~117° — parallax

/** The driver's settings, by their terrainParams.js keys. */
export const DRIVER_SETTINGS = ['baseSpeed0', 'baseSpeed1', 'driftEnabled', 'frozen']

/** The settings' defaults, from their rows. */
export function driverDefaults() {
  return Object.fromEntries(DRIVER_SETTINGS.map(k => [k, TERRAIN_PARAMS.find(r => r.key === k).value]))
}

export class TerrainDriver {
  /**
   * @param {EventTarget} dynamics  emits 'tick' { dt, momentum, noiseTime }
   * @param {object} uniforms       terrain material uniforms (by reference)
   * @param {object} heightmapUniforms  heightmap material uniforms (by reference)
   */
  constructor(dynamics, uniforms, heightmapUniforms) {
    this._u    = uniforms
    this._hu   = heightmapUniforms

    // baseSpeed0/1     drift magnitude per instance, world units per noiseTime unit
    // driftEnabled     the direction random walk
    // frozen           test-only: early-returns the whole tick so a probe can
    //                  hold the driver still for a deterministic readback
    this.settings = driverDefaults()

    this._driftAngle0 = DRIFT_INITIAL_ANGLE_0
    this._driftAngle1 = DRIFT_INITIAL_ANGLE_1

    dynamics.addEventListener('tick', e => this._onTick(e.detail))
  }

  // ─── readouts and snapshot ─────────────────────────────────────────────────

  /** Current drift angle (radians) for one instance — for debug display. */
  getDriftAngle(instance) { return instance === 0 ? this._driftAngle0 : this._driftAngle1 }

  /**
   * The drift headings a snapshot needs to resume. The offsets and velocities
   * are integrated uniforms and the settings are rows, captured by Terrain.
   */
  exportState() {
    return { driftAngle0: this._driftAngle0, driftAngle1: this._driftAngle1 }
  }

  /**
   * Restore from exportState(); a key a snapshot lacks leaves that field as it
   * is.
   */
  importState(s) {
    if (Number.isFinite(s.driftAngle0)) this._driftAngle0 = s.driftAngle0
    if (Number.isFinite(s.driftAngle1)) this._driftAngle1 = s.driftAngle1
  }

  /**
   * Recompute the derived ranges (uHeightMax, uMantleDC) from the live rows, as
   * a tick does. A restore calls it: the sim is paused, so no tick would.
   */
  applyRange() { this._stepRange() }

  // ─── private ───────────────────────────────────────────────────────────────

  _onTick({ dt, noiseTime, momentum }) {
    if (this.settings.frozen) return
    this._stepRange()
    // dt is the tick payload's, clamped so a frame stall can't jump the angle.
    // Advancing on it keeps drift in lockstep with noiseTime.
    this._stepDrift(Math.min(dt, 0.1), momentum, noiseTime)
    // Δ on the noiseTime axis since the last tick, measured against uTime (the
    // last noiseTime this driver wrote). Reading the uniform rather than a
    // private copy means a snapshot restore, which writes uTime and
    // dynamics.noiseTime together, resumes with Δ = 0 instead of a jump.
    // Clamped ≥ 0 so a noiseTime reset never rewinds drift.
    this._stepDriftOffset(nonNegDelta(noiseTime, this._u.uTime.value))
    this._u.uTime.value = noiseTime
  }

  /**
   * uHeightMax = fBM amplitude sum + erosion margin, and uMantleDC (the mean lift
   * max(bedrock, mantle) adds). The DC depends on persistence, a live slider, so
   * it is recomputed every tick: a baked constant would slide the biome bands
   * against it.
   */
  _stepRange() {
    const u  = this._u
    const hu = this._hu
    u.uHeightMax.value = computeHeightMax(
      u.uFBM0Amp.value, u.uFBM1Amp.value,
      hu.uErosionEnabled.value, hu.uErosionStrength.value, hu.uErosionScale.value,
      hNormFor(u.uFBM0Amp.value, u.uFBM1Amp.value))
    u.uMantleDC.value = mantleDcCoefficient(
      u.uFBM0Amp.value, u.uFBM0Persistence.value,
      u.uFBM1Amp.value, u.uFBM1Persistence.value,
      Math.max(u.uFBM0Octaves.value, u.uFBM1Octaves.value),
      u.uBedrockOctaves.value, u.uMantleRelief.value, u.uRockPersist.value)
  }

  /** Turn each heading and set the DriftX/Z velocity uniforms. */
  _stepDrift(driftDt, momentum, noiseTime) {
    const u = this._u
    const s = this.settings
    if (s.driftEnabled) {
      // Low-frequency sinusoids — smooth direction reversals, no abrupt stops.
      // Different frequencies keep the two instances drifting independently.
      const ang0noise = Math.sin(noiseTime * 0.031 + 1.2)  // period 2π/0.031 ≈ 203 noiseTime units
      const ang1noise = Math.sin(noiseTime * 0.026 + 3.1)  // period 2π/0.026 ≈ 242 noiseTime units
      this._driftAngle0 = driftAngleStep(this._driftAngle0, driftDt, momentum, ang0noise, DRIFT_ANGULAR_SPEED)
      this._driftAngle1 = driftAngleStep(this._driftAngle1, driftDt, momentum, ang1noise, DRIFT_ANGULAR_SPEED)
      u.uFBM0DriftX.value = Math.cos(this._driftAngle0) * s.baseSpeed0
      u.uFBM0DriftZ.value = Math.sin(this._driftAngle0) * s.baseSpeed0
      u.uFBM1DriftX.value = Math.cos(this._driftAngle1) * s.baseSpeed1
      u.uFBM1DriftZ.value = Math.sin(this._driftAngle1) * s.baseSpeed1
    } else {
      u.uFBM0DriftX.value = 0
      u.uFBM0DriftZ.value = 0
      u.uFBM1DriftX.value = 0
      u.uFBM1DriftZ.value = 0
    }
  }

  /**
   * Integrate velocity into the offset: position = ∫velocity dNoiseTime,
   * accumulated each tick, so a direction change only affects future motion
   * (velocity × total time would rewrite all past drift and jump the sample
   * positions).
   */
  _stepDriftOffset(dNoiseTime) {
    const u = this._u
    u.uFBM0DriftOffset.value.x += u.uFBM0DriftX.value * dNoiseTime
    u.uFBM0DriftOffset.value.y += u.uFBM0DriftZ.value * dNoiseTime
    u.uFBM1DriftOffset.value.x += u.uFBM1DriftX.value * dNoiseTime
    u.uFBM1DriftOffset.value.y += u.uFBM1DriftZ.value * dNoiseTime
  }
}
