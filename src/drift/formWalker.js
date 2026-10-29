/**
 * formWalker.js — the unattended wander of the five macro dials: ocean,
 * mountains, snowline, cloud scatter and cloud density.
 *
 * THE WALK    One Walk (walk.js) holds the five channels. Each tick this module
 *             gives every channel a step of rate × noiseSpeed × dt, so the
 *             attention that sets how fast the terrain evolves also sets how
 *             fast its form and sky wander. No ticks arrive while the scene is
 *             frozen, so the walk stops with it.
 * POSITIONS   A dial is a slider position in [0,1]. The walker knows nothing about
 *             what a dial does: the `apply` callback (scene/formDriver.js) turns
 *             positions into real settings.
 * TIME SHARE  The walk moves a hidden value u evenly; the dial's position is
 *             warp(u). Four dials use the identity. The snowline bends it, so it
 *             sits high most of the time and rarely low.
 * GROUPS      The form dials (ocean, mountains, snowline) walk at this module's
 *             own range and speed, the "Form drift" sliders. The cloud dials walk
 *             at the weather's "Cloud & sky drift" settings, so they drift with
 *             the weather.
 * SNAPSHOT    The hidden values, the current targets, the on switch and both
 *             settings.
 */

import { Walk } from './walk.js'
import { paramAccess } from '../shared/paramAccess.js'
import { FORM_WALKER_PARAMS } from './formWalkerParams.js'

/**
 * Snowline bias: position = u ** 0.35. A uniform u then exceeds position 0.6
 * about 77% of the time and falls below 0.2 about 1% of the time, so a low
 * snowline (a white cap swallowing the range) is rare but reachable.
 */
const SNOW_BIAS_POW = 0.35

/** Readout warps and their inverses: latent u → slider position, and back. */
const FLAT = { warp: u => u, unwarp: pos => pos }
const SNOW = { warp: u => u ** SNOW_BIAS_POW, unwarp: pos => pos ** (1 / SNOW_BIAS_POW) }

/** The walked channels, in the order `apply` receives them; `group` picks the range and speed a channel walks at. */
const CHANNELS = [
  { key: 'ocean',        ...FLAT, group: 'form' },
  { key: 'mountains',    ...FLAT, group: 'form' },
  { key: 'snowline',     ...SNOW, group: 'form' },
  { key: 'cloudScatter', ...FLAT, group: 'cloud' },
  { key: 'cloudDensity', ...FLAT, group: 'cloud' },
]

const GROUP_OF = Object.fromEntries(CHANNELS.map(c => [c.key, c.group]))

export class FormWalker {
  // ─── state ─────────────────────────────────────────────────────────────────

  /**
   * @param {EventTarget} dynamics  emits 'tick' { dt }
   * @param {object}   opts
   * @param {(pos:{ocean:number,mountains:number,snowline:number,cloudScatter:number,cloudDensity:number})=>void} opts.apply
   *   receives normalised [0,1] slider positions whenever they move
   * @param {() => number} opts.noiseSpeed  current noiseSpeed, read per tick
   * @param {() => number} [opts.random]    injectable for tests
   * @param {() => number} opts.cloudSpread  the cloud group's spread, read per draw
   * @param {() => number} opts.cloudRate    the cloud group's rate, read per tick
   * @param {object} [opts.start]  initial positions, normalised; a missing or
   *   non-finite one starts at 0.5. main.js passes none: the start scene's
   *   snapshot sets the positions and targets (importState).
   */
  constructor(dynamics, {
    apply, noiseSpeed, cloudSpread, cloudRate, random = Math.random,
    start = {},
  }) {
    this._apply       = apply
    this._noiseSpeed  = noiseSpeed

    const rows = Object.fromEntries(FORM_WALKER_PARAMS.map(r => [r.key, r.value]))
    this._enabled    = rows.enabled
    this._calmSpread = rows.calmSpread
    this._followRate = rows.followRate
    // A setting that is not a finite number leaves the value alone.
    const number = prop => ({
      get: () => this[prop],
      set: v => { if (Number.isFinite(v)) this[prop] = Math.max(0, v) },
    })
    this.params = paramAccess({
      tables: [],
      rows: FORM_WALKER_PARAMS,
      fields: {
        enabled: { get: () => this._enabled, set: on => { this._enabled = !!on } },
        calmSpread: number('_calmSpread'),
        followRate: number('_followRate'),
      },
    })

    // Where each group reads its range and speed, per draw and per tick: the form
    // group's are this walker's own settings, the cloud group's are given.
    this._groups = {
      form:  { spread: () => this._calmSpread, rate: () => this._followRate },
      cloud: { spread: cloudSpread, rate: cloudRate },
    }

    this._walk = new Walk({
      channels: CHANNELS,
      spreadOf: key => this._groupSpread(GROUP_OF[key]),
      random,
    })
    for (const { key } of CHANNELS) this._walk.seed(key, start[key])

    dynamics.addEventListener('tick', e => this._onTick(e.detail.dt))
  }

  /**
   * Snapshot (sceneSnapshot.js): the latents and their in-flight targets, not
   * the positions, so a restored walk keeps heading for the target it had.
   */
  exportState() {
    return {
      ...this._walk.exportState(),
      ...this.params.export(),
    }
  }

  importState(state = {}) {
    const known = ['u', 'target', 'enabled', 'calmSpread', 'followRate']
    const unknown = Object.keys(state).filter(k => !known.includes(k)).map(k => `formWalker.${k}`)
    this._walk.importState(state)
    const { enabled, calmSpread, followRate } = state
    this.params.import({
      ...(typeof enabled === 'boolean' && { enabled }),
      ...(calmSpread != null && { calmSpread }),
      ...(followRate != null && { followRate }),
    })
    return { unknown }
  }

  // ─── outputs ───────────────────────────────────────────────────────────────

  /** Current normalised positions — what `apply` was last handed. */
  getPositions() {
    return this._walk.positions()
  }

  // ─── tick ──────────────────────────────────────────────────────────────────

  /**
   * One walk step per channel. The step is rate × noiseSpeed × dt, so the walk
   * slows as the scene settles toward a painting; a zero or NaN step leaves the
   * channel untouched. Rates are read fresh each tick, so a drift slider takes
   * effect at once. `apply` runs only when something moved: it rewrites the
   * scene's form settings, not worth doing each frame for no change.
   */
  _onTick(dt) {
    if (!this._enabled) return
    let moved = false
    for (const { key, group } of CHANNELS) {
      const step = this._groupRate(group) * this._noiseSpeed() * dt
      if (this._walk.step(key, step)) moved = true
    }
    if (moved) this._apply(this.getPositions())
  }

  /** The spread and rate a channel's group walks at (see GROUPS in the header). */
  _groupSpread(group) { return this._groups[group].spread() }
  _groupRate(group)   { return this._groups[group].rate() }
}
