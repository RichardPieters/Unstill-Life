/**
 * atmosphere.js — the scene's weather: two slow random walks and the clear and
 * heavy ends they blend between. Writes no uniforms itself.
 *
 * STATE    overcast [0,1]  how much sun the sky lets through (0 open sun, 1 grey lid)
 *          haze     [0,1]  moisture between camera and far ridges (0 crisp, 1 dissolved)
 *   Two independent walks: clear-but-hazy and overcast-but-crisp are both real
 *   weather and look nothing alike.
 *
 * THE WALK  One Walk (walk.js) holds the two channels; each tick this module
 *   gives both a step of rate × noiseSpeed × dt. Paced by noiseSpeed, so the
 *   weather stalls whenever the scene does: paused, frozen, or momentum 0 at
 *   full attention. dynamics.restlessness is not a pace source: it sits pinned
 *   at 1 whenever attention is below the unfreeze threshold (default 0.9), and
 *   above it is a one-way countdown into the painting.
 *
 * CLEAR / HEAVY  HEAVY is authored here (the `heavy.*` rows, atmosphereParams.js,
 *   edited on the Sky tab). CLEAR is captured from the live scene (`opts.live`)
 *   when the weather switches on and written back when it switches off, so the
 *   scene's own sliders define a clear day and switching off is exact. Scalar
 *   parameters are lerp(clear, heavy, weight) (atmosphereMath). The colours:
 *   horizon, painting sky and zenith each blend from their own clear end to the
 *   one heavy.skyHex, then toward heavy.hazeSky by haze on top; the painted
 *   ground is its clear colour scaled by the light-level ratio. Every write
 *   goes through `apply` (weatherDriver.applyWeather), the same path the panel
 *   sliders use,
 *   so no slider is left showing a stale value or has its edits overwritten.
 *   The `clear.*` rows are mirrors: while the weather is on they edit the
 *   captured clear value, while it is off the live param itself (_profileFields).
 *
 * SNAPSHOT  CLEAR is kept here because it has to survive a snapshot:
 *   captureScene records the uniforms as the weather has driven them, so a
 *   restore that re-captured clear would take the driven look as its clear day
 *   and apply the weather on top of it again.
 *
 * NOT TOUCHED  sun position (time of day, a separate axis); landform and
 *   snowline (formWalker.js — weather that reshapes land is climate). Cloud drift
 *   and ripple speed are not written here: animSpeed.js owns them and hurries
 *   both by weatherSpeedFactor(getOvercastShaped()), which main.js pushes it.
 */

import { clamp01 } from '../shared/mathUtils.js'
import { Walk } from './walk.js'
import { shapeOvercast } from './atmosphereMath.js'
import { paramAccess } from '../shared/paramAccess.js'
import {
  ATMOSPHERE_PARAMS, WEATHER_PARAMS, WEATHER_CHANNELS as CHANNELS, WEATHER_DRIVEN_KEYS, HEAVY_START,
  isColourParam, hexToInt, intToHex,
} from './atmosphereParams.js'

const HEAVY_KEYS = Object.keys(HEAVY_START)
const ROW_DEFAULTS = Object.fromEntries(ATMOSPHERE_PARAMS.map(r => [r.key, r.value]))

// Each scalar is seeded at its row's value (atmosphereParams.js), away from the
// ends, where a seeded walk would spend its first minutes folding off them. In
// the piece, main.js's start scene replaces the seed before the first frame.

export class Atmosphere {
  // ─── state ─────────────────────────────────────────────────────────────────

  /**
   * @param {EventTarget} dynamics  emits 'tick' { dt }
   * @param {object} opts
   * @param {(state:{overcast:number,haze:number,enabled:boolean,clear:object|null,heavy:object,shape:{onset:number,full:number}})=>void} opts.apply
   *   called whenever either scalar moves, on every enable/disable, on every
   *   importState, and on every edit to an endpoint or the window while enabled
   * @param {{get:(key:string)=>number, set:(key:string,v:number)=>void, onChange:(key:string,fn:()=>void)=>void}} opts.live
   *   the driven parameters by the weather's key (WEATHER_DRIVEN_KEYS), as ints
   *   for colours. Read to capture clear (at construction, on each enable edge,
   *   and in importState when an enabled snapshot carries no clear); written by a
   *   clear row while the weather is off; `onChange` follows a live value the
   *   clear rows mirror.
   * @param {() => number} opts.noiseSpeed  current noiseSpeed, read per tick
   * @param {() => number} [opts.random]    injectable for tests
   */
  constructor(dynamics, { apply, live, noiseSpeed, random = Math.random }) {
    this._apply       = apply
    this._live        = live
    this._noiseSpeed  = noiseSpeed

    // The live values every driven parameter had before the weather touched
    // them. Null exactly while the weather is off.
    this._clear = null

    // Master: whether the weather writes to the scene at all. No panel control.
    // On by default: the clear-weather cloud amount (uCoverage 2.86) is an empty
    // sky, so the shipped picture is the weather-driven one.
    const rows = ROW_DEFAULTS
    this._enabled = rows.enabled
    // Whether the two scalars drift on their own. Off leaves them hand-driven
    // from their sliders — the tuning path: walk off, drag overcast to 1 and look
    // at what full overcast does.
    this._walking = rows.walking

    this._spread = rows.spread
    this._rate   = rows.rate
    this._onset  = rows.onset
    this._full   = rows.full
    this._importing = false
    this.params = this._buildParams()
    // While the weather is off a clear row shows the live value, so it follows it.
    for (const e of WEATHER_PARAMS) {
      if (e.clear !== undefined) live.onChange(e.key, () => { if (!this._clear) this.params.notify(`clear.${e.key}`) })
    }
    this._heavy   = { ...HEAVY_START }

    this._walk = new Walk({
      channels: CHANNELS.map(key => ({ key })),
      spreadOf: () => this._spread,
      random,
    })
    for (const key of CHANNELS) this._walk.seed(key, rows[key])

    // Starting enabled, the clear capture of the toggle EDGE (_switch) happens
    // here: _switch returns early on an unchanged value, and applyWeather's
    // `if (!clear)` ignores every write while `_clear` is null.
    //
    // main.js builds this after applyPalette() and initDebugPanel(), so every
    // value the capture reads is already real, and this apply runs before
    // bindAtmosphere binds the weather's rows, which read their values when
    // they bind.
    if (this._enabled) {
      this._clear = this._captureClear()
      this._apply(this.getState())
    }

    dynamics.addEventListener('tick', e => this._onTick(e.detail.dt))
  }

  // ─── settings (params) ─────────────────────────────────────────────────────

  _buildParams() {
    // A setting that is not a finite number leaves the value alone: a NaN rate
    // would make every step NaN and stop the walk.
    const number = (prop, fix, push = false) => ({
      get: () => this[prop],
      set: v => {
        if (Number.isFinite(v)) this[prop] = fix(v)
        if (push) this._pushIfOn()
      },
    })
    return paramAccess({
      tables: [],
      rows: ATMOSPHERE_PARAMS,
      fields: {
        enabled: { get: () => this._enabled, set: on => this._switch(!!on) },
        walking: { get: () => this._walking, set: on => { this._walking = !!on } },
        spread: number('_spread', clamp01),
        rate: number('_rate', v => Math.max(0, v)),
        onset: number('_onset', clamp01, true),
        full: number('_full', clamp01, true),
        // The walked scalars: read every frame by the panel (their rows are
        // `live`), written by hand through setChannel.
        ...Object.fromEntries(CHANNELS.map(key => [key, {
          get: () => this._walk.position(key), set: v => this.setChannel(key, v),
        }])),
        ...this._profileFields(),
      },
    })
  }

  /**
   * The profile rows' fields (atmosphereParams.js), one pair per WEATHER_PARAMS
   * entry. A colour is a '#rrggbb' string at the row and an int in the tables.
   *
   * heavy.<key>  the held heavy value; a write re-applies the weather if it is on.
   *
   * clear.<key>  the row is `mirrorOf` the live param, and the weather decides
   *   which is the truth. ON: the captured clear value (`_clear`), so a write
   *   here authors the clear day and re-applies the weather, while the live
   *   param keeps showing the blend. OFF: the live param itself, because then
   *   the scene IS the clear day (one truth, so these rows cannot drift from
   *   the Colour tab's own controls for the same params). Exact reversal
   *   survives: the enable edge re-captures from the live scene (so tuning done
   *   while off is picked up), and switching off restores whatever clear now
   *   says, an authored clear day rather than the one up at enable time.
   *   This module writes no uniforms itself: the live write goes through
   *   `opts.live`.
   */
  _profileFields() {
    const out = {}
    const row = (e, n) => (isColourParam(e) ? intToHex(n) : n)
    const num = (e, v) => {
      const n = typeof v === 'string' ? hexToInt(v) : v
      return Number.isFinite(n) ? n : null
    }
    for (const e of WEATHER_PARAMS) {
      if (e.heavy !== undefined) {
        out[`heavy.${e.key}`] = {
          get: () => row(e, this._heavy[e.key]),
          set: v => {
            const n = num(e, v)
            if (n === null) return
            this._heavy[e.key] = n
            this._pushIfOn()
          },
        }
      }
      if (e.clear !== undefined) {
        out[`clear.${e.key}`] = {
          get: () => row(e, this._clear ? this._clear[e.key] : this._live.get(e.key)),
          set: v => {
            const n = num(e, v)
            if (n === null) return
            if (this._clear) {
              this._clear[e.key] = n
              this._apply(this.getState())
            } else {
              this._live.set(e.key, n)
            }
          },
        }
      }
    }
    return out
  }

  /** Tell the panel the profile rows' values moved behind the accessor (an import). */
  _notifyProfiles() {
    for (const e of WEATHER_PARAMS) {
      if (e.heavy !== undefined) this.params.notify(`heavy.${e.key}`)
      if (e.clear !== undefined) this.params.notify(`clear.${e.key}`)
    }
  }

  /** The live value of every driven parameter: the clear day, while the weather is off. */
  _captureClear() {
    return Object.fromEntries(WEATHER_DRIVEN_KEYS.map(key => [key, this._live.get(key)]))
  }

  /**
   * Whether the weather writes to the scene. Toggling pushes one apply().
   * Going ON captures clear first; going OFF hands the apply the clear it is
   * about to drop, so the write path has something to restore from, and only
   * then clears it.
   */
  _switch(next) {
    if (next === this._enabled) return
    if (next) this._clear = this._captureClear()
    this._enabled = next
    this._apply(this.getState())
    if (!next) this._clear = null
  }

  /** Hand-set one scalar; the walk resumes from there (Walk#setPosition). */
  setChannel(key, v) {
    if (!CHANNELS.includes(key)) return
    this._walk.setPosition(key, v)
    this._pushIfOn()
  }

  /**
   * Snapshot (sceneSnapshot.js). The latents and their in-flight targets (the
   * Walk's state), so a restored walk keeps heading for the target it had. The
   * clear end rides along so a restore does not re-derive it from an
   * already-driven scene (see the header).
   */
  exportState() {
    return {
      ...this._walk.exportState(),
      ...this.params.export(),
      clear: this._clear ? { ...this._clear } : null,
      heavy: { ...this._heavy },
    }
  }

  importState(state = {}) {
    const unknown = []
    const known = ['u', 'target', 'enabled', 'walking', 'spread', 'rate', 'onset', 'full', 'clear', 'heavy']
    for (const k of Object.keys(state)) if (!known.includes(k)) unknown.push(`atmosphere.${k}`)

    this._walk.importState(state)
    for (const key of HEAVY_KEYS) {
      if (Number.isFinite(state.heavy?.[key])) this._heavy[key] = state.heavy[key]
    }
    // The settings reach their fields without the grey-light window's own
    // apply (`_importing`), and `enabled` is assigned without _switch's
    // capture: the restore below owns the clear and ends with one apply.
    const { spread, rate, onset, full, walking, enabled } = state
    this._importing = true
    this.params.import({
      ...(spread != null && { spread }), ...(rate != null && { rate }),
      ...(onset != null && { onset }), ...(full != null && { full }),
      ...(typeof walking === 'boolean' && { walking }),
    })
    this._importing = false
    const wasEnabled = this._enabled
    if (typeof enabled === 'boolean') this._enabled = enabled

    // The snapshot's clear end, not a fresh capture: applyScene has already
    // restored the terrain uniforms to the snapshot's driven values, so a
    // capture would read the weather back in on top of itself. A snapshot
    // without a `clear` field leaves an enabled restore to capture. A
    // weather-off snapshot drops the clear end, so the running session's clear
    // is not written over the values the snapshot has just restored.
    if (state.clear && typeof state.clear === 'object') {
      this._clear = { ...state.clear }
    } else if (this._enabled && !this._clear) {
      this._clear = this._captureClear()
    } else if (!this._enabled) {
      this._clear = null
    }

    // Unconditional: a restore that lands on the same `enabled` value still has
    // to push the restored scalars at the scene.
    this._apply(this.getState())
    // Rows whose values moved behind the accessor: the profiles, and `enabled`
    // (assigned, not set, so the panel's dimming hears of it).
    this._notifyProfiles()
    if (this._enabled !== wasEnabled) this.params.notify('enabled')
    return { unknown }
  }

  // ─── outputs ───────────────────────────────────────────────────────────────

  /** The raw walk positions. */
  getOvercast() { return this._walk.position('overcast') }
  getHaze()     { return this._walk.position('haze') }

  /**
   * Overcast as the PICTURE has it: the raw walk through the light's window
   * (shapeOvercast, onset/full). The two disagree across the bottom of the walk
   * — the start scene's 0.31 lies below the 0.50 onset, so the opening has a
   * raw value above zero while its light is exactly clear. Anything that has
   * to agree with what is visible reads this (main.js → animSpeed, audio).
   */
  getOvercastShaped() {
    return shapeOvercast(this._walk.position('overcast'), { onset: this._onset, full: this._full })
  }

  /** What `apply` receives: the two scalars, both ends of every parameter, and the light's window. */
  getState() {
    return {
      overcast: this._walk.position('overcast'),
      haze:     this._walk.position('haze'),
      enabled:  this._enabled,
      clear:     this._clear ? { ...this._clear } : null,
      heavy:     { ...this._heavy },
      shape:    { onset: this._onset, full: this._full },
    }
  }

  // ─── lifecycle ('tick' listener) ───────────────────────────────────────────

  _onTick(dt) {
    if (!this._enabled || !this._walking) return
    // `!(step > 0)` also bails on a NaN dt or noiseSpeed.
    const step = this._rate * this._noiseSpeed() * dt
    if (!(step > 0)) return

    let moved = false
    for (const key of CHANNELS) {
      if (this._walk.step(key, step)) moved = true
    }
    // `apply` rewrites every driven parameter across terrain, water, clouds, sky
    // and the art pass — not worth doing every frame for no change.
    if (moved) this._apply(this.getState())
  }

  _pushIfOn() { if (this._enabled && !this._importing) this._apply(this.getState()) }
}
