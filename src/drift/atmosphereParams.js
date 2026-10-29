/**
 * atmosphereParams.js — the weather as param rows (shared/paramSchema.js), held
 * by `atmosphere.params`:
 *
 *   settings   whether it runs and drifts, how fast, and the window on the
 *              overcast scalar over which the light turns grey;
 *   channels   `overcast` and `haze`, the two walked scalars (read every frame
 *              by the panel; exportState carries them with their walk targets);
 *   profiles   the two ends every driven parameter blends between, generated
 *              from WEATHER_PARAMS:
 *     heavy.<key>   the value at full overcast / haze; its default lives here.
 *     clear.<key>   the value at overcast = haze = 0, `mirrorOf` the live param
 *                   `<owner>.<key>`. While the weather is on it reads and
 *                   writes the captured clear value, while off the live param
 *                   itself (Atmosphere#_buildParams).
 *
 * Profile rows are not snapshotted as rows: exportState carries them as `clear`
 * and `heavy` objects keyed by the weather key, colours as 0xrrggbb (a row shows
 * '#rrggbb'). Each value is a field of the weather, whose setter refuses a
 * non-finite number, clamps the rest into range and, for the grey-light window,
 * re-applies the weather.
 */

/**
 * Every parameter the weather moves, in the order the Sky tab shows them.
 *   key         the weather's own name for it (the `clear`/`heavy` object key)
 *   ref         the live param it drives, 'owner.key'; null for a heavy-only
 *               colour (haze) that no param holds
 *   read        where to read the live value when it differs from `ref`
 *   stem        names both controls: ctrl-atmo-clear-<stem> / ctrl-atmo-heavy-<stem>
 *   clear/heavy the row's default, or absent when that end has no row; a clear
 *               value is the placeholder shown before the first capture. A
 *               colour is '#rrggbb'.
 *   side        which condition the heavy end belongs to: 'overcast' | 'haze'
 *   tint        'sky' | 'ground': how a colour blends (atmosphereMath.colourCurves)
 *   locks       false when the live param's own control must stay editable (the
 *               master is always on and would otherwise lock it)
 * Slider display (min, max, step, digits) and `label` are the Sky tab's.
 */
export const WEATHER_PARAMS = [
  // Contrast: lifts the dark endpoint toward the lit colour.
  { key: 'shadowValue', ref: 'terrain.shadowValue', stem: 'shadow', label: 'shadow floor',
    min: 0, max: 1, step: 0.01, digits: 2, clear: 0.05, heavy: 0.16, side: 'overcast' },
  // Level, a separate axis from the floor: a grey day is flatter and darker.
  // Far smaller than the real illuminance drop, on purpose: the viewer judges the
  // land against the sky in the same picture, so the relation must survive, not
  // its size. Applied before the aerial melt, so its reach over a pixel is that
  // pixel's land weight (1 - t) and shows mostly in the near and middle field.
  { key: 'lightLevel', ref: 'scene.lightLevel', stem: 'light', label: 'light level',
    min: 0, max: 1.5, step: 0.01, digits: 2, clear: 1.11, heavy: 0.64, side: 'overcast' },
  // Alpenglow, which a sun behind cloud cannot cast; the heavy end keeps a trace.
  { key: 'glow', ref: 'terrain.glow', stem: 'glow', label: 'alpenglow',
    min: 0, max: 1, step: 0.01, digits: 2, clear: 0.26, heavy: 0.12, side: 'overcast' },
  // The blue-violet push in the shadows. It rises (0.07 → 0.4), against the
  // physics: under a deck lit and shaded ground see the same grey dome and the
  // tint should go out, but a wholly neutral shadow under a cel ladder reads as a
  // rendering fault. 0 gives the literal reading. uShadowDesat is not driven (at
  // the clear floor the desaturated base is near-black), and neither is
  // uShadowHue toward a neutral: toShadow's normalisation turns that into a
  // second desaturation.
  { key: 'shadowHueAmt', ref: 'terrain.shadowHueAmt', stem: 'hue', label: 'shadow blue',
    min: 0, max: 1, step: 0.01, digits: 2, clear: 0.07, heavy: 0.4, side: 'overcast' },
  // Horizon, fog and background colour. Written through the horizon owner (sky,
  // fog, fog uniform, clouds) and read back from the sky, whose gradient texture
  // has no colour to read. It sets the tone of the whole frame, because fog melts
  // most of it toward this colour, and at the horizon an overcast sky is the
  // dimmer one, so the heavy end sits below the clear horizon in luma. A mid grey
  // would read as dusk: an overcast sky loses its blue more than its brightness.
  { key: 'skyHex', ref: 'horizon.hex', read: 'sky.horizonHex', stem: 'sky', label: 'sky colour',
    kind: 'colour', clear: '#c8ddf0', heavy: '#a1b4cd', side: 'overcast', tint: 'sky' },
  // The gradient's top end. Like the painting sky it travels to the horizon's
  // heavy colour, so a grey or hazy sky loses its gradient.
  { key: 'zenithSky', ref: 'sky.zenithHex', stem: 'zenith', label: 'zenith colour',
    kind: 'colour', clear: '#2a4d7a', tint: 'sky' },
  // The painting's sky: clear-only, travelling to the same heavy sky.
  { key: 'artSky', ref: 'artPass.colSky', stem: 'artsky', label: 'painting sky',
    kind: 'colour', clear: '#8fa8c4', tint: 'sky' },
  // Cloud amount as uCoverage, a threshold subtracted from density: lower means
  // more cloud, and clear (2.86) is an empty sky. uWeatherStrength cannot do this
  // job: it scales a zero-mean noise field, so it changes patchiness, not the
  // amount.
  { key: 'cloudCoverage', ref: 'clouds.coverage', stem: 'cloud', label: 'cloud cover',
    min: 0, max: 3, step: 0.005, digits: 3, clear: 2.86, heavy: 0.12, side: 'overcast' },
  // How far cloud colour is pulled toward the sky colour (cloudShade.glsl); the
  // cloud gradients depend on sun height alone, so without it a grey lid renders
  // in clear-day colours.
  { key: 'cloudGrey', ref: 'clouds.weatherGrey', stem: 'cloudgrey', label: 'cloud greying',
    min: 0, max: 1, step: 0.01, digits: 2, clear: 0, heavy: 0.2, side: 'overcast' },
  // Water: the sun glint goes out with the sun, and the mirror rises, because a
  // diffuse sky reflection is most of what is left on the surface.
  { key: 'specAmt', ref: 'water.specAmt', stem: 'spec', label: 'water glint',
    min: 0, max: 3, step: 0.01, digits: 2, clear: 0.8, heavy: 0.28, side: 'overcast' },
  { key: 'reflectAmt', ref: 'water.reflectAmt', stem: 'reflect', label: 'water mirror',
    min: 0, max: 2, step: 0.01, digits: 2, clear: 0.71, heavy: 1.67, side: 'overcast' },
  // Aerial ramp exponent. The heavy end is slightly above clear, which slightly
  // reduces haze (pow(t, c) with larger c lowers the ramp): a mild counter-shape
  // so the near field does not go soft as fast as the far one. The haze itself
  // is carried by fogNear.
  { key: 'fogCurve', ref: 'scene.fogCurve', stem: 'curve', label: 'haze reach',
    min: 0.1, max: 4, step: 0.01, digits: 2, clear: 0.6, heavy: 0.7, side: 'haze' },
  // How far distance washes local hue toward grey.
  { key: 'aerialDesat', ref: 'terrain.aerialDesat', stem: 'aerial', label: 'distance greying',
    min: 0, max: 1, step: 0.01, digits: 2, clear: 0.55, heavy: 1, side: 'haze' },
  // Where the ramp starts, world units. The ramp saturates at uFogFar, so a
  // curve-only haze runs out of gradient and leaves the far half one flat band;
  // pulling the start in gives thick haze the whole depth to happen across.
  { key: 'fogNear', ref: 'scene.fogNear', stem: 'near', label: 'haze starts at',
    min: 0, max: 800, step: 10, digits: 0, clear: 400, heavy: 0, side: 'haze' },
  // The post-curve ceiling. At the clear 0.9 the farthest terrain never reaches
  // the sky colour and leaves a seam at the horizon; 0.95 keeps a trace of the
  // farthest ridge rather than deleting it.
  { key: 'fogMaxAlpha', ref: 'scene.fogMaxAlpha', stem: 'max', label: 'haze ceiling',
    min: 0, max: 1, step: 0.01, digits: 2, clear: 0.9, heavy: 0.95, side: 'haze' },
  // The painting's solid ground: clear-only, edited on the art-pass tab (its
  // `clear.artGround` row), not locked. It is scaled by the light-level ratio
  // rather than blended toward a heavy colour: the land darkens, the sky does not.
  { key: 'artGround', ref: 'artPass.groundColor', label: 'solid colour',
    kind: 'colour', clear: '#84775a', tint: 'ground', locks: false },
  // The colour thick haze melts the distance into, blended over the sky after
  // it, whatever the cloud is doing. Heavy-only: at haze 0 none of it is mixed in.
  // Whitish and near-neutral, not the clear sky's blue: haze is aerosol with
  // near wavelength-independent scattering, and without this full haze would
  // dissolve the far ridges into saturated pale blue. uAerialDesat cannot cover
  // it, because at full fog the pixel is the fog colour itself. Brighter as well
  // as less saturated, because airlight adds radiance.
  { key: 'hazeSky', ref: null, stem: 'hazesky', label: 'haze colour',
    kind: 'colour', heavy: '#dfe3e6', side: 'haze' },
]

/** The two walked scalars, in the order the weather walks them. */
export const WEATHER_CHANNELS = ['overcast', 'haze']

/** A colour as the weather holds it (0xrrggbb) and as a row shows it ('#rrggbb'). */
export const hexToInt = hex => parseInt(hex.slice(1), 16)
export const intToHex = n => '#' + (n >>> 0).toString(16).padStart(6, '0')

export const isColourParam = e => e.kind === 'colour'

/** Keys of the driven parameters (those with a live param), in capture order. */
export const WEATHER_DRIVEN_KEYS = WEATHER_PARAMS.filter(e => e.ref).map(e => e.key)

/** The heavy profile's starting values, as the weather holds them (colours as ints). */
export const HEAVY_START = Object.fromEntries(WEATHER_PARAMS
  .filter(e => e.heavy !== undefined)
  .map(e => [e.key, isColourParam(e) ? hexToInt(e.heavy) : e.heavy]))

function profileRow(e, profile) {
  const base = {
    id: e.stem ? `ctrl-atmo-${profile}-${e.stem}` : `atmosphere.${profile}.${e.key}`,
    owner: 'atmosphere', key: `${profile}.${e.key}`,
    value: e[profile], label: e.label, persist: false,
    ...(profile === 'clear' && { mirrorOf: e.ref }),
  }
  if (isColourParam(e)) return { ...base, kind: e.stem ? 'colour' : 'hidden', encode: 'srgb' }
  return { ...base, kind: 'slider', encode: 'float', min: e.min, max: e.max, step: e.step, digits: e.digits }
}

/** The profile rows, heavy then clear, generated from WEATHER_PARAMS. */
export const WEATHER_PROFILE_ROWS = [
  ...WEATHER_PARAMS.filter(e => e.heavy !== undefined).map(e => profileRow(e, 'heavy')),
  ...WEATHER_PARAMS.filter(e => e.clear !== undefined).map(e => profileRow(e, 'clear')),
]

/**
 * The control ids of one profile in Sky-tab order (panelLayout.js). `side`
 * narrows the heavy profile to one condition's section.
 */
export function weatherProfileIds(profile, side) {
  return WEATHER_PARAMS
    .filter(e => e[profile] !== undefined && e.stem && (!side || e.side === side))
    .map(e => `ctrl-atmo-${profile}-${e.stem}`)
}

/** The walked scalars as rows: the walk moves them, so the panel re-reads them every frame. */
const CHANNEL_ROWS = [
  { id: 'ctrl-atmo-overcast', owner: 'atmosphere', key: 'overcast', kind: 'slider', encode: 'float',
    value: 0.12, min: 0, max: 1, step: 0.002, digits: 2, label: 'overcast', persist: false, live: true },
  { id: 'ctrl-atmo-haze', owner: 'atmosphere', key: 'haze', kind: 'slider', encode: 'float',
    value: 0.58, min: 0, max: 1, step: 0.002, digits: 2, label: 'haze', persist: false, live: true },
]

/** Control ids of the walked scalars: what the weather walk drives. */
export const weatherWalkIds = () => CHANNEL_ROWS.map(r => r.id)

export const ATMOSPHERE_PARAMS = [
  // Whether the weather writes to the scene at all; no control of its own. On,
  // because the clear cloud amount is an empty sky and the shipped picture is the
  // weather-driven one.
  { id: 'atmosphere.enabled', owner: 'atmosphere', key: 'enabled', kind: 'hidden', encode: 'bool',
    value: true, label: 'weather on' },
  // Whether the two scalars drift on their own; off leaves them hand-driven, the
  // tuning path. The drift tri-state box drives it with the form walker.
  { id: 'atmosphere.walking', owner: 'atmosphere', key: 'walking', kind: 'hidden', encode: 'bool',
    value: true, label: 'weather drifts' },
  // How far a fresh target may sit from the current position.
  { id: 'ctrl-atmo-spread', owner: 'atmosphere', key: 'spread', kind: 'slider', encode: 'float',
    value: 0.83, min: 0, max: 1, step: 0.01, digits: 2, label: 'drift range' },
  // Position units per second per unit of noiseSpeed; ten times slower than the
  // form walker, because weather that changes faster than the land reads as a
  // light show.
  { id: 'ctrl-atmo-rate', owner: 'atmosphere', key: 'rate', kind: 'slider', encode: 'float',
    value: 0.002, min: 0, max: 0.1, step: 0.001, digits: 3, label: 'drift speed' },
  // The window on the overcast scalar over which the light turns grey (cloud
  // amount follows the raw scalar). 0.50 holds the light back until about a
  // quarter of the cloud has gathered. Clamped into [0,1] to keep the endpoints
  // exact, not forced into order: onset above full is a legal hard step.
  { id: 'ctrl-atmo-onset', owner: 'atmosphere', key: 'onset', kind: 'slider', encode: 'float',
    value: 0.5, min: 0, max: 1, step: 0.01, digits: 2, label: 'grey light starts' },
  { id: 'ctrl-atmo-full', owner: 'atmosphere', key: 'full', kind: 'slider', encode: 'float',
    value: 1, min: 0, max: 1, step: 0.01, digits: 2, label: 'grey light complete' },
  ...CHANNEL_ROWS,
  ...WEATHER_PROFILE_ROWS,
]
