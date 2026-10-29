/**
 * waterParams.js — the water's param rows (shared/paramSchema.js): every value
 * the water can be set to, read back through `water.params`. water.js seeds its
 * uniforms from them and builds its accessor from them; the panel binds the
 * controls through panel/panelRows.js.
 *
 * DEFAULTS  `value` is the one default of each value. The two weather rows
 *   (`drivenBy: 'weather'`) are the clear-weather start the weather blends from;
 *   the colour rows take shared/palette.js's values; the
 *   sea band is replaced by the start scene at boot.
 *
 * BACKING  a row that names a `uniform` writes it. A row without one is a field
 *   of water.js: the driver's settings (the sea band, the foam and deep-colour
 *   shares and the sparkle cutoff, which the driver turns into uniforms every
 *   tick, so the panel sets the setting, never the uniform), the mirror
 *   resolution (reallocates a render target), the art-data switch (also flips
 *   depthWrite) and the plane's visibility.
 */

import { PALETTE, hexString } from '../shared/palette.js'

const row = r => ({ owner: 'water', kind: 'slider', encode: 'float', ...r })
const hidden = r => row({ kind: 'hidden', id: `water.${r.key}`, ...r })
const colour = r => row({ kind: 'colour', encode: 'srgb', ...r })

export const WATER_PARAMS = [
  // ── Sea band ──────────────────────────────────────────────────────────────
  // `low` is the waterline at restlessness 1 (calm), `high` at 0 (settled); the
  // smoothed level eases toward low + (high - low) × (1 - restlessness). A
  // deliberate write snaps the level to the new target (water.js withSeaSnap
  // turns that off for a per-tick writer). The defaults are the band of a
  // captured scene; main.js's boot form.apply replaces them from the form dials.
  row({ id: 'ctrl-sea-low', key: 'seaLow', label: 'sea · calm', drivenBy: 'form',
    value: -8.482189797048935, min: -40, max: 20, step: 1, digits: 0,
    pair: { with: 'seaHigh', order: 'lo' } }),
  row({ id: 'ctrl-sea-high', key: 'seaHigh', label: 'sea · settled', drivenBy: 'form',
    value: 3.859451496388601, min: -20, max: 40, step: 1, digits: 0,
    pair: { with: 'seaLow', order: 'hi' } }),

  // ── Surface ───────────────────────────────────────────────────────────────
  row({ id: 'ctrl-ripple', key: 'rippleAmp', uniform: 'uRippleAmp',
    label: 'ripple', value: 3, min: 0, max: 5, step: 0.05, digits: 2 }),
  row({ id: 'ctrl-water-bands', key: 'waterBands', uniform: 'uWaterBands',
    label: 'water bands', value: 4, min: 0, max: 8, step: 1, digits: 0 }),
  row({ id: 'ctrl-water-reflect', key: 'reflectAmt', uniform: 'uReflectAmt',
    label: 'reflect amt', value: 0.71, min: 0, max: 2, step: 0.05, digits: 2, drivenBy: 'weather' }),
  row({ id: 'ctrl-water-spec', key: 'specAmt', uniform: 'uSpecAmt',
    label: 'spec amt', value: 0.8, min: 0, max: 3, step: 0.05, digits: 2, drivenBy: 'weather' }),
  // Shore-foam reach as a share of the water's available depth
  // (waterMath.depthShare); momentum widens it.
  row({ id: 'ctrl-foam-width', key: 'foamShare',
    label: 'foam reach', value: 0.21, min: 0, max: 0.8, step: 0.01, digits: 2 }),
  // Spec cutoff of the glitter — lower = denser.
  row({ id: 'ctrl-water-sparkle', key: 'sparkleThreshold',
    label: 'sparkle thresh', value: 0.15, min: 0.02, max: 0.6, step: 0.01, digits: 2 }),
  // Depth at which the water is fully deep-coloured, as a share of the water's
  // available depth (waterMath.depthShare). Too low and most of the visible
  // ocean saturates to solid deep colour within a few units of the shore
  // (near-flat black); check a screenshot when retuning.
  row({ id: 'ctrl-water-depth', key: 'deepShare',
    label: 'deep at', value: 0.56, min: 0.1, max: 2, step: 0.01, digits: 2 }),
  // Posterize foam into N bands; < 2 = smooth.
  row({ id: 'ctrl-foam-tiers', key: 'foamTiers', uniform: 'uFoamTiers',
    label: 'foam tiers', value: 3, min: 0, max: 5, step: 1, digits: 0 }),
  // Foam blend strength.
  row({ id: 'ctrl-foam-amt', key: 'foamAmt', uniform: 'uFoamAmt',
    label: 'foam amt', value: 1.5, min: 0, max: 2.5, step: 0.05, digits: 2 }),
  // 0 = clean band, 1 = ragged/clumped froth.
  row({ id: 'ctrl-foam-noise', key: 'foamNoiseAmt', uniform: 'uFoamNoiseAmt',
    label: 'foam noise', value: 0.65, min: 0, max: 1.5, step: 0.05, digits: 2 }),
  // 0 = pure sine swell, 1 = pure 3D-noise detail.
  row({ id: 'ctrl-wave-noise', key: 'waveNoiseMix', uniform: 'uWaveNoiseMix',
    label: 'wave noise mix', value: 0.2, min: 0, max: 1, step: 0.05, digits: 2 }),

  // ── Planar terrain reflection (water.js reflectionPrePass) ───────────────
  // Ripple-driven UV wobble on the mirror sample.
  row({ id: 'ctrl-reflect-distort', key: 'reflectDistort', uniform: 'uReflectDistort',
    label: 'reflect distort', value: 0.12, min: 0, max: 0.2, step: 0.005, digits: 2 }),
  // 0 = flat sky-reflection colour, 1 = full mirrored terrain.
  row({ id: 'ctrl-reflect-terrain', key: 'reflectTerrainAmt', uniform: 'uReflectTerrainAmt',
    label: 'reflect terrain', value: 0.55, min: 0, max: 1, step: 0.05, digits: 2 }),
  // Posterize the fresnel mask into N sheets; < 2 = smooth.
  row({ id: 'ctrl-reflect-tiers', key: 'reflectTiers', uniform: 'uReflectTiers',
    label: 'reflect tiers', value: 8, min: 0, max: 8, step: 1, digits: 0 }),
  // Facet the mirror wobble into N steps; < 1 = smooth.
  row({ id: 'ctrl-distort-steps', key: 'distortSteps', uniform: 'uDistortSteps',
    label: 'distort steps', value: 29, min: 0, max: 32, step: 1, digits: 0 }),
  // Mirror-pass resolution as a fraction of the canvas (a field: a change
  // reallocates the target). Below 1 the pass, a full scene redraw, gets cheaper
  // and the reflection softer.
  row({ id: 'ctrl-reflect-res', key: 'reflectScale', clamp: true,
    label: 'mirror resolution', value: 0.5, min: 0.05, max: 1, step: 0.05, digits: 2 }),

  // ── Colours (shared/palette.js's values; the panel's colour pickers) ────────────
  colour({ id: 'col-water-deep', key: 'waterDeep', uniform: 'uWaterDeep', value: hexString(PALETTE.water.deep), label: 'water deep' }),
  colour({ id: 'col-water-shallow', key: 'waterShallow', uniform: 'uWaterShallow', value: hexString(PALETTE.water.shallow), label: 'water shallow' }),
  colour({ id: 'col-glint', key: 'waterSpec', uniform: 'uWaterSpec', value: hexString(PALETTE.water.spec), label: 'glint' }),
  // The flat sky colour the reflection falls back to: the palette's horizon.
  hidden({ key: 'skyReflect', uniform: 'uSkyReflect', encode: 'srgb', value: hexString(PALETTE.sky.horizon) }),

  // ── Switches (no panel control) ──────────────────────────────────────────
  // Art pass: emit its G-buffer, not the surface (artGBuffer.js). A field: it
  // also flips depthWrite. The surface normally writes no depth, so the depth
  // buffer at a water pixel holds the seabed behind it, tens of units further
  // away. The art pass reads depth for stroke size, aerial thinning and its
  // occlusion-edge test, and would draw a phantom depth cliff along the whole
  // shoreline. Writing depth is safe because that pass has its own target.
  hidden({ key: 'artData', encode: 'bool', value: false, persist: false }),
  // Show/hide the plane; the pre-passes honour it. Test-only
  // (terrain_reactive.spec.js isolates the terrain with it).
  hidden({ key: 'enabled', encode: 'bool', value: true, persist: false }),
]

/**
 * Every water uniform no row backs, with its snapshot class
 * (shared/uniformSerialize.js). The scene-wide ones (fog, light, cloud shadow)
 * are the scene set's.
 */
export const UNIFORM_CLASSES = {
  // The ripple clock, and the last tick's foam width, sparkle cutoff and
  // deep-colour depth: each is its base row scaled by that tick's momentum,
  // terrain scale and sea level, which no snapshot holds.
  uTime:             'integrated',
  uFoamWidth:        'integrated',
  uSparkleThreshold: 'integrated',
  uDepthMax:         'integrated',
  // The `artData` row's field.
  uArtData:          'row:artData',
  // Per frame: the depth and mirror passes and the canvas size.
  uDepthTexture:     'frame',
  uResolution:       'frame',
  uCameraNear:       'frame',
  uCameraFar:        'frame',
  uReflectionTex:    'frame',
  uReflectionMatrix: 'frame',
  // Fixed at construction.
  uRippleScale:      'constant',
  uOpacity:          'constant',
}
