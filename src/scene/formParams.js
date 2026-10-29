/**
 * formParams.js — the five macro dials as param rows (shared/paramSchema.js),
 * held by `form.params` (formDriver.js). A row's value is the dial's POSITION in
 * [0,1], the one place a position lives; the walker (drift/formWalker.js)
 * moves them and the panel's dial sliders are these rows.
 *
 * The values are where the dials stand at construction: one landmass with tall
 * mountains, the snowline wherever terrain's own snow-base default sits. The
 * piece opens on the start scene's positions instead (main.js,
 * scene/startScene.json), restored before the first frame.
 *
 * The snowline has no slider of its own: terrain's snow-base slider
 * (`ctrl-snow-base`) is its dial, so the row is hidden (no control is built).
 */
import { TERRAIN_PARAMS } from '../terrain/terrainParams.js'

const SNOW_BASE_ROW = TERRAIN_PARAMS.find(p => p.key === 'snowBase')

/** Slider position [0,1] <-> terrain's snow-base value, across that slider's own range. */
export const snowPositionToValue = pos => SNOW_BASE_ROW.min + pos * (SNOW_BASE_ROW.max - SNOW_BASE_ROW.min)
export const snowValueToPosition = v => (v - SNOW_BASE_ROW.min) / (SNOW_BASE_ROW.max - SNOW_BASE_ROW.min)

const dial = (id, key, label, value) => ({
  id, owner: 'form', key, kind: 'slider', encode: 'float',
  value, min: 0, max: 1, step: 0.01, digits: 2, label, drivenBy: 'form',
})

export const FORM_PARAMS = [
  dial('ctrl-form-ocean', 'ocean', 'ocean', 0),
  dial('ctrl-form-mountains', 'mountains', 'mountains', 1),
  { id: 'form.snowline', owner: 'form', key: 'snowline', kind: 'hidden', encode: 'float',
    value: snowValueToPosition(SNOW_BASE_ROW.value), min: 0, max: 1, label: 'snowline', drivenBy: 'form' },
  dial('ctrl-cdial-scatter', 'cloudScatter', 'scatter', 0.45),
  dial('ctrl-cdial-density', 'cloudDensity', 'cloud density', 0.26),
]
