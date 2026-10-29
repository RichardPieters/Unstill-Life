/**
 * formDriver.js — the `form` owner: where the five macro dials' positions live
 * (ocean, mountains, snowline, cloud scatter, cloud density) and the writes
 * each makes on the scene. `form.params` is the accessor (formParams.js rows).
 *
 * TWO WRITE PATHS, one blend each:
 *   a row's setter    a hand-drag of one dial does that dial's share of the work.
 *   apply(positions)  the walker and main.js's freezeForm set every
 *                     held position, then run all the writes ONCE, so a tick
 *                     blends once per tick, not once per axis.
 *
 * apply stores all five positions, then writes: the ocean/mountains blend
 * (terrainForm.js), the snowline, the cloud dials (cloudDialsMath.js). The
 * density write sets absorption before calling onDensityEffect, which reads it
 * back. The sea band goes to water.withSeaSnap, never to uSeaLevel, which
 * main.js overwrites every frame from the water driver's smoothed level. A
 * hand-drag snaps that level to the band; the walker does not, because at 60 Hz
 * a snap would delete the waterline's drift.
 *
 * A hand-drag of one ocean/mountains dial runs the blend only.
 */
import { paramAccess } from '../shared/paramAccess.js'
import { TERRAIN_PARAMS } from '../terrain/terrainParams.js'
import { WATER_PARAMS } from '../water/waterParams.js'
import { CLOUD_PARAMS } from '../clouds/cloudParams.js'
import { FORM_PARAMS, snowPositionToValue, snowValueToPosition } from './formParams.js'
import { FORM_CORNERS, formTargets } from '../drift/terrainForm.js'
import {
  scatterToBaseFreq, densityToAbsorption, densityToRayScale, densityToShadowScale,
  densityToShadowDepth, densityToWeatherEffect, absorptionToDensity,
} from '../drift/cloudDialsMath.js'

const KEYS = FORM_PARAMS.map(r => r.key)

/**
 * The panel control ids the form walker overwrites: the blended keys' own
 * controls (terrain's and water's rows, found by key), the dials, and the two
 * cloud controls the cloud dials write through. The driven registry's source.
 */
export function formDrivenIds() {
  const idOf = (tables, key) => {
    const row = tables.flat().find(p => p.key === key)
    if (!row) throw new Error(`formDrivenIds: no row for "${key}"`)
    return row.id
  }
  return [
    ...Object.keys(FORM_CORNERS).map(key => idOf([TERRAIN_PARAMS, WATER_PARAMS], key)),
    idOf([TERRAIN_PARAMS], 'snowBase'),
    ...FORM_PARAMS.filter(r => r.kind !== 'hidden').map(r => r.id),
    idOf([CLOUD_PARAMS], 'baseFreq'), idOf([CLOUD_PARAMS], 'absorption'),
  ]
}

/**
 * @param {object} deps  the owners the dials write
 * @param {() => void} [deps.onDensityEffect]  called when the density dial
 *   changes the factor the weather's light curves are scaled by; with the
 *   weather walk off nothing else would push the new light strength to the
 *   scene, so the wiring re-applies the last weather state.
 */
export function createFormDriver({ terrain, water, clouds, godrays, sceneUniforms, onDensityEffect = () => {} }) {
  const held = Object.fromEntries(FORM_PARAMS.map(r => [r.key, r.value]))
  let holding = false        // setters store the position and write nothing: apply, a restore, and the listeners below
  let writing = false        // true during the form's own writes, so the absorption listener ignores them
  let lastDensityEffect = null

  const hold = fn => {
    const prev = holding
    holding = true
    try { fn() } finally { holding = prev }
  }
  const writeGuarded = fn => {
    const prev = writing
    writing = true
    try { fn() } finally { writing = prev }
  }

  /** Push the ocean/mountains blend onto terrain and the sea band onto water. */
  function writeBlend(snapSea) {
    const t = formTargets(held.ocean, held.mountains)
    const p = terrain.params
    p.set('fbm0Amp', t.fbm0Amp)
    p.set('fbm1Amp', t.fbm1Amp)
    p.set('fbm0Freq', t.fbm0Freq)
    p.set('fbm1Freq', t.fbm1Freq)

    p.set('ridgeAmt', t.ridgeAmt)
    p.set('ridgeRound', t.ridgeRound)
    p.set('bedrockOctaves', t.bedrockOctaves)

    p.set('mantleRelief', t.mantleRelief)
    p.set('mantleBias', t.mantleBias)

    p.set('rockRidge', t.rockRidge)
    p.set('rockPersist', t.rockPersist)
    p.set('rockAniso', t.rockAniso)

    p.set('gateAmt', t.gateAmt)
    // A pair (terrainParams.js): either order keeps gateLo <= gateHi.
    p.set('gateLo', t.gateLo)
    p.set('gateHi', t.gateHi)

    // Through withSeaSnap, so a requested snap sees both ends of the band.
    water.withSeaSnap(snapSea, () => {
      water.params.set('seaLow', t.seaLow)
      water.params.set('seaHigh', t.seaHigh)
    })
  }

  function writeSnowline(pos) {
    terrain.params.set('snowBase', snowPositionToValue(pos))
  }

  /**
   * Written continuously. `baseFreq` is a shape key, but a small step is
   * re-baked as a roll, a few layers per frame (its row's `roll` invalidation,
   * cloudParams.js), as long as the offset the layers' mixed frequencies imply
   * at the window's corner, extent·√½·(f_hi − f_lo)/f, stays under one cell
   * (`_rollStaysInvisible`).
   */
  function writeScatter() {
    clouds.params.set('baseFreq', scatterToBaseFreq(held.cloudScatter))
  }

  /**
   * Everything the cloud-density dial drives, in one place, so a consequence
   * added to the dial cannot end up wired into only one of the two paths.
   * The weather reads the density back off the live cloud absorption, so a
   * hand-dragged density and a walked one reach it the same way; it is
   * re-applied (onDensityEffect) whenever the effect factor changes.
   */
  function writeDensity() {
    const pos = held.cloudDensity
    clouds.params.set('absorption', densityToAbsorption(pos))
    godrays.params.set('intensityScale', densityToRayScale(pos))
    sceneUniforms.params.set('cloudShadowScale', densityToShadowScale(pos))
    sceneUniforms.params.set('cloudShadowAbs', densityToShadowDepth(pos))
    const effect = densityToWeatherEffect(pos)
    if (effect !== lastDensityEffect) {
      lastDensityEffect = effect
      onDensityEffect()
    }
  }

  const dial = (key, write) => ({
    get: () => held[key],
    set: v => {
      held[key] = v
      if (!holding) writeGuarded(write)
    },
  })

  const params = paramAccess({
    tables: [],
    rows: FORM_PARAMS,
    fields: {
      ocean: dial('ocean', () => writeBlend(true)),
      mountains: dial('mountains', () => writeBlend(true)),
      snowline: dial('snowline', () => writeSnowline(held.snowline)),
      cloudScatter: dial('cloudScatter', writeScatter),
      cloudDensity: dial('cloudDensity', writeDensity),
    },
  })

  // The snowline and cloud-density positions follow a write made by someone else
  // (a hand-drag of terrain's snow-base or the absorption slider, a restore), so
  // a held position never contradicts the scene. Scatter does not follow.
  terrain.params.onChange('snowBase', v => hold(() => params.set('snowline', snowValueToPosition(v))))
  clouds.params.onChange('absorption', v => {
    if (!writing) hold(() => params.set('cloudDensity', absorptionToDensity(v)))
  })

  return {
    params,

    /** The five positions, by key. */
    positions() {
      return Object.fromEntries(KEYS.map(k => [k, held[k]]))
    },

    /** The five positions, by key: the snapshot's `form` entry. */
    exportState() {
      return params.export()
    },

    /**
     * Restore the positions and write nothing: the owners' own restores already
     * put the scene at the values these positions produced, and a write here
     * would re-derive them from the dials.
     */
    importState(state) {
      let report
      hold(() => { report = params.import(state) })
      return { unknown: report.unknown, rejected: report.rejected }
    },

    /**
     * Set every given position and run the writes once, always (freezeForm
     * needs the writes even when a position equals the held one). A
     * position that is missing or not finite keeps its held value and, for a
     * cloud dial, is not rewritten (a caller may pass only the form dials).
     *
     * @param {Partial<Record<'ocean'|'mountains'|'snowline'|'cloudScatter'|'cloudDensity', number>>} positions
     * @param {object}  [opts]
     * @param {boolean} [opts.snapSea=false] true for a one-shot caller; the
     *   walker leaves it off (see the header)
     */
    apply(positions, { snapSea = false } = {}) {
      const given = key => Number.isFinite(positions[key])
      hold(() => { for (const key of KEYS) if (given(key)) params.set(key, positions[key]) })
      writeGuarded(() => {
        writeBlend(snapSea)
        writeSnowline(held.snowline)
        if (given('cloudScatter')) writeScatter()
        if (given('cloudDensity')) writeDensity()
      })
    },
  }
}
