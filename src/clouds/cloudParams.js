/**
 * cloudParams.js — the clouds' param rows (shared/paramSchema.js): every value
 * cloudsVolume.js can be set to, read back through `clouds.params`. The volume
 * seeds its uniforms from them and builds its accessor from them; the panel
 * binds the controls through panel/panelRows.js.
 *
 * DEFAULTS  `value` is the one default of each value. The two dial rows
 *   (`drivenBy: 'form'`: scale ← cloud scatter, absorption ← cloud density)
 *   are numbers a dial map produced, which is why they sit off their step
 *   grid; main.js's boot form.apply overwrites both before the first frame.
 *   Coverage is the weather's clear-weather start.
 *
 * INVALIDATES  what a change makes stale, handled by cloudsVolume.js:
 *   grid   re-derive the octave counts, detail tail and usable radius from
 *          the extent, frequencies and march step (_recomputeGrid)
 *   shape  re-bake the whole shape volume and relight (the field changed)
 *   roll   a smooth frequency step: re-bake a few shape layers per frame while
 *          the mixed layers stay within one cell of each other, else `shape`
 *   light  relight every layer (the sun's path or the density read changed)
 *   march  re-march the cloud target even while the world holds still
 *   The shape volume holds a raw, unthresholded field, so the density and
 *   coverage rows never touch it — they only change how that field is READ,
 *   which the light volume bakes in and the final march does live. Anything
 *   geometric moves the grid itself and invalidates both. A row lists `grid`
 *   before the bake class: the roll's budget reads the cell size the grid step
 *   just re-derived. Rows without `invalidates` (shading, march-time density)
 *   are read live by the march and composite.
 *
 * BACKING  a row that names a `uniform` writes it; uCloudSpeed and
 *   uWeatherSpeed live in a JS-only table (no shader reads them; they drive
 *   the wind and weather offsets). A row with neither is held by the accessor
 *   (the per-frame budgets, the incremental switch, the draw distance) or is a
 *   field of cloudsVolume.js: the on/off switch and the worley-octave ceiling.
 *   `coverage` and `baseFreq` are held rows whose uniforms (uCoverage, uBaseFreq)
 *   chase them frame by frame, an ease and a capped rate (_ease), so a jump in a
 *   slider is a ramp; a restore snaps them.
 */

import { PALETTE, hexString } from '../shared/palette.js'

const row = r => ({ owner: 'clouds', kind: 'slider', encode: 'float', ...r })
const hidden = r => row({ kind: 'hidden', id: `clouds.${r.key}`, ...r })
const toggle = r => row({ kind: 'toggle', encode: 'float01', value: true, ...r })

// The volume's layer count (cloudsVolume.js): a roll cannot re-bake more.
const LAYERS = 32

export const CLOUD_PARAMS = [
  // The switch: the composite pass's own `enabled`.
  row({ id: 'tog-clouds', label: 'volumetric clouds', key: 'enabled', kind: 'toggle', encode: 'bool', value: true }),

  // ── Cloud posterization (cloudShade.glsl): colour steps and opacity tiers
  // are independent axes ────────────────────────────────────────────────────
  row({ id: 'ctrl-cloud-color-steps', key: 'colorSteps', uniform: 'uCloudColorSteps',
    label: 'colour contrast', value: 9, min: 0, max: 20, step: 1, digits: 0 }),
  row({ id: 'ctrl-cloud-alpha-tiers', key: 'alphaTiers', uniform: 'uCloudAlphaTiers',
    label: 'opacity tiers', value: 5, min: 0, max: 10, step: 1, digits: 0 }),
  // ── Cloud shading tail (cloudCommon.glsl): on-off experiments over float
  // uniforms, and their numbers ─────────────────────────────────────────────
  toggle({ id: 'tog-cloud-sint', label: 'energy-conserving integration (Sint)', key: 'useSint', uniform: 'uUseSint' }),
  toggle({ id: 'tog-cloud-powder', label: 'powder edge darkening', key: 'powderEnabled', uniform: 'uPowderEnabled' }),
  row({ id: 'ctrl-cloud-powder-strength', key: 'powderStrength', uniform: 'uPowderStrength',
    label: 'powder strength', value: 2, min: 0, max: 10, step: 0.1, digits: 2 }),
  // ── Weather (cloudShade.glsl's blend toward the scene): the atmosphere
  // writes both; the sky is the scene's horizon colour (main.js applyHorizon) ─
  hidden({ key: 'weatherGrey', uniform: 'uCloudWeatherGrey', value: 0, drivenBy: 'weather' }),
  hidden({ key: 'weatherSky', uniform: 'uCloudWeatherSky', encode: 'srgb', value: hexString(PALETTE.sky.horizon),
    drivenBy: 'weather', invalidates: 'march' }),

  // ── Baked-volume clouds (cloudsVolume.js) ────────────────────────────────
  // How far from the camera clouds are drawn. The window's extent follows from
  // it (windowExtent), and the cell size, the octave count and the usable radius
  // follow from the extent (_recomputeGrid). A row with no uniform: the accessor
  // holds it.
  row({ id: 'ctrl-cvol-distance', key: 'drawDistance', invalidates: ['grid', 'shape'],
    label: 'draw distance', value: 1800, min: 500, max: 3600, step: 100, digits: 0 }),
  row({ id: 'ctrl-cvol-level', key: 'cloudLevel', uniform: 'uCloudLevel', invalidates: 'shape',
    label: 'shell level', value: 80, min: 0, max: 600, step: 10, digits: 0 }),
  row({ id: 'ctrl-cvol-height', key: 'cloudHeight', uniform: 'uCloudHeight', invalidates: 'shape',
    label: 'shell height', value: 140, min: 20, max: 500, step: 10, digits: 0 }),
  row({ id: 'ctrl-cvol-speed', key: 'cloudSpeed', uniform: 'uCloudSpeed',
    label: 'drift speed', value: 6, min: 0, max: 20, step: 0.5, digits: 2 }),
  // Held: uBaseFreq chases it at a capped rate (cloudsVolume.js's _ease).
  row({ id: 'ctrl-cvol-freq', key: 'baseFreq',
    label: 'cloud scale', value: 0.007134895266880415, min: 0.002, max: 0.02, step: 0.0005, digits: 4, drivenBy: 'form' }),
  // The fBM series' ratios, shared by the bake and the march's detail tail. No
  // panel control.
  hidden({ key: 'lacunarity', uniform: 'uLacunarity', value: 2, invalidates: ['grid', 'shape'] }),
  hidden({ key: 'gain', uniform: 'uGain', value: 0.5, invalidates: ['grid', 'shape'] }),
  row({ id: 'ctrl-cvol-density', key: 'densityScale', uniform: 'uDensityScale', invalidates: 'light',
    label: 'density bias', value: 5.9, min: 0.5, max: 12, step: 0.1, digits: 2 }),
  // Held: uCoverage eases toward it (cloudsVolume.js's _ease), so a jump in the
  // overcast slider is a ramp of this many seconds, not a pop.
  row({ id: 'ctrl-cvol-coverage', key: 'coverage',
    label: 'coverage', value: 2.86, min: 0, max: 3, step: 0.005, digits: 3, drivenBy: 'weather' }),
  row({ id: 'ctrl-cvol-coverage-ease', key: 'coverageEase',
    label: 'coverage ease', value: 0.8, min: 0, max: 5, step: 0.1, digits: 1 }),
  row({ id: 'ctrl-cvol-absorb', key: 'absorption', uniform: 'uAbsorption',
    label: 'absorption', value: 0.057594235669846, min: 0.001, max: 0.08, step: 0.001, digits: 3, drivenBy: 'form' }),
  row({ id: 'ctrl-cvol-aniso', key: 'scatteringAniso', uniform: 'uScatteringAniso',
    label: 'scattering aniso', value: 0.85, min: -0.95, max: 0.95, step: 0.05, digits: 2 }),
  row({ id: 'ctrl-cvol-steps', key: 'maxSteps', uniform: 'uMaxSteps', encode: 'int',
    label: 'raymarch steps', value: 96, min: 8, max: 96, step: 1, digits: 0 }),
  // The march step sets what detail is resolvable, so it re-derives the detail
  // octave count without touching either volume.
  row({ id: 'ctrl-cvol-step-size', key: 'marchStepSize', uniform: 'uMarchStepSize', invalidates: 'grid',
    label: 'step size', value: 6, min: 2, max: 64, step: 1, digits: 0 }),
  row({ id: 'ctrl-cvol-step-growth', key: 'stepGrowth', uniform: 'uStepGrowth',
    label: 'step growth', value: 0.03, min: 0, max: 0.3, step: 0.005, digits: 3 }),
  // 3.0, not 1.0 (an exact continuation of the baked series): a strict
  // continuation gives the first detail octave gain^4 = 3.3% of a unit field
  // (at 4 baked octaves), which measured as barely visible — 1.8% of pixels
  // moved. Two anchors, derived from the band amplitudes of the earlier
  // per-pixel fBM: 2.89 reproduces the weight its FINE band had, and 8.80
  // would replace every octave a 16 u grid cannot hold (29.3% of its total
  // amplitude). The default takes the conservative one — packing three bands'
  // worth of energy into a single octave reads as lumpy, not wispy — and the
  // slider reaches the other.
  row({ id: 'ctrl-cvol-detail', key: 'detailAmount', uniform: 'uDetailAmount',
    label: 'wisp detail', value: 3, min: 0, max: 10, step: 0.1, digits: 2 }),
  row({ id: 'ctrl-cvol-light-steps', key: 'lightSteps', uniform: 'uLightSteps', encode: 'int', invalidates: 'light',
    label: 'light steps', value: 24, min: 1, max: 48, step: 1, digits: 0 }),
  row({ id: 'ctrl-cvol-light-step-size', key: 'lightStepSize', uniform: 'uLightStepSize', invalidates: 'light',
    label: 'light step size', value: 17, min: 1, max: 60, step: 1, digits: 1 }),
  // The sun, copied from terrain every frame (main.js): every cell's sun path
  // changes with it.
  hidden({ key: 'sunAzimuth', uniform: 'uSunAzimuth', encode: 'vec2', value: [0.5, 0.4], invalidates: 'light' }),
  hidden({ key: 'sunElevation', uniform: 'uSunElevation', value: 0.5, invalidates: 'light' }),
  // How many light layers to relight per frame. Higher converges faster after
  // the field moves; lower spreads the cost. There is no analytically right
  // value — it trades a visible hitch against visibly stale shading — so it is
  // a slider rather than a constant.
  row({ id: 'ctrl-cvol-light-rate', key: 'lightLayersPerFrame', encode: 'int', clamp: [1, Infinity],
    label: 'light layers/frame', value: 1, min: 1, max: LAYERS, step: 1, digits: 0 }),
  // Seconds the ground shadow takes to follow a change in the sky (cloudsVolume.js's
  // _refreshGroundLayer): its smoothing against how far it lags. 0 follows every
  // frame. Not a uniform; read each frame.
  row({ id: 'ctrl-cvol-ground-ease', key: 'groundEase', clamp: true,
    label: 'shadow smoothing', value: 0.15, min: 0, max: 1, step: 0.01, digits: 2 }),
  // The same trade for the shape when the scatter dial drifts: how many of its
  // layers a roll re-bakes per frame.
  row({ id: 'ctrl-cvol-roll-rate', key: 'rollLayersPerFrame', encode: 'int', clamp: true,
    label: 'shape layers/frame', value: 4, min: 1, max: LAYERS, step: 1, digits: 0 }),
  // Scissored edge updates on a re-anchor (on), or sweeping both volumes whole
  // (off). Both must produce the identical image — that is the whole
  // correctness claim, and cloud_impl.spec.js asserts it by rendering the same
  // frame each way. Kept switchable so that assertion is possible at all, and
  // so a suspected rect bug can be bisected in one call.
  hidden({ key: 'incremental', encode: 'bool', value: true }),
  // Debug view of one baked stage — see cloudsVolume.frag's uDebugView. 0 = off.
  hidden({ key: 'debugView', uniform: 'uDebugView', value: 0 }),
  // Skip march work whose result is provably zero. Exact (on and off render the
  // same pixels); only a spec turns it off, so a snapshot never carries it.
  hidden({ key: 'emptySpaceSkip', uniform: 'uEmptySpaceSkip', encode: 'float01', value: true, persist: false }),

  // ── Weather map (cloudWeatherMap.js) — the coverage bias of the march and the light bake ────
  row({ id: 'ctrl-cvol-weather-strength', key: 'weatherStrength', uniform: 'uWeatherStrength', invalidates: ['light', 'march'],
    label: 'weather strength', value: 3.5, min: 0, max: 10, step: 0.05, digits: 2 }),
  row({ id: 'ctrl-cvol-weather-scale', key: 'weatherScale', uniform: 'uWeatherScale', invalidates: ['light', 'march'],
    label: 'weather scale', value: 2300, min: 500, max: 8000, step: 100, digits: 0 }),
  row({ id: 'ctrl-cvol-weather-speed', key: 'weatherSpeed', uniform: 'uWeatherSpeed',
    label: 'weather speed', value: 0.5, min: 0, max: 5, step: 0.05, digits: 2 }),

  // ── Curl-noise domain warp (cloudVolumeBake.frag) — bake-time only ───────
  row({ id: 'ctrl-cvol-curl-freq', key: 'curlFreq', uniform: 'uCurlFreq', invalidates: 'shape',
    label: 'curl scale', value: 0.004, min: 0.0005, max: 0.02, step: 0.0005, digits: 4 }),
  row({ id: 'ctrl-cvol-curl-strength', key: 'curlStrength', uniform: 'uCurlStrength', invalidates: 'shape',
    label: 'curl strength', value: 16, min: 0, max: 100, step: 1, digits: 1 }),

  // ── Worley erosion of the base noise (cloudVolumeBake.frag) — bake-time only ────
  row({ id: 'ctrl-cvol-worley-freq', key: 'worleyFreq', uniform: 'uWorleyFreq', invalidates: ['grid', 'roll'],
    label: 'worley scale', value: 0.02, min: 0.0005, max: 0.02, step: 0.0005, digits: 4 }),
  row({ id: 'ctrl-cvol-worley-amount', key: 'worleyAmount', uniform: 'uWorleyAmount', invalidates: 'shape',
    label: 'worley amount', value: 1, min: 0, max: 1, step: 0.05, digits: 2 }),
  row({ id: 'ctrl-cvol-worley-erosion', key: 'worleyErosion', uniform: 'uWorleyErosion', invalidates: 'shape',
    label: 'worley erosion', value: 0.85, min: 0, max: 1, step: 0.05, digits: 2 }),
  // A requested CEILING (a field of cloudsVolume.js): the bake's uWorleyOctaves
  // is this, clamped down to what the grid can carry (_recomputeGrid).
  row({ id: 'ctrl-cvol-worley-octaves', key: 'worleyOctaves', encode: 'int', invalidates: ['grid', 'shape'],
    label: 'worley octaves', value: 2, min: 1, max: 3, step: 1, digits: 0 }),

  // ── Horizon curvature droop (cloudsVolume.frag) — march-time only ────────
  row({ id: 'ctrl-cvol-planet-curve', key: 'planetCurve', uniform: 'uPlanetCurve',
    label: 'planet curve', value: 17100, min: 0, max: 20000, step: 100, digits: 0 }),
]

/**
 * Every cloud uniform no row backs, with its snapshot class
 * (shared/uniformSerialize.js). The grid-derived ones are written by
 * cloudsVolume.js's _recomputeGrid, which the restore runs.
 */
export const UNIFORM_CLASSES = {
  // The scrolling and anchoring state: where the window sits, the frequency it
  // was baked at, the phases that keep a frequency change continuous, and the
  // accumulated wind and weather offsets.
  uOriginCell:     'integrated',
  uFreqAnchor:     'integrated',
  uFreqPhase:      'integrated',
  uWorleyPhase:    'integrated',
  uWindOffset:     'integrated',
  uMidWindOffset:  'integrated',
  uFineWindOffset: 'integrated',
  uWeatherOffset:  'integrated',
  // The window size follows from the draw distance (_recomputeGrid).
  uExtent:         'derived',
  // The cloud amount and the cloud scale the passes use: they chase their rows
  // (coverage, baseFreq) frame by frame (_ease), and a restore snaps them.
  uCoverage:       'derived',
  uBaseFreq:       'derived',
  // The octave ceiling is a request the grid clamps: the row's field.
  uWorleyOctaves:  'row:worleyOctaves',
  // From the extent, frequencies and gain (_recomputeGrid).
  uCellSize:         'derived',
  uAmpNorm:          'derived',
  uOctaves:          'derived',
  uLastOctaveWeight: 'derived',
  uDetailOctaves:    'derived',
  uDetailFreq:       'derived',
  uDetailAmp:        'derived',
  uBoundaryFreq:     'derived',
  uBoundaryAmp:      'derived',
  uOctaveEdge:       'derived',
  // Per pass and per frame: the layer being baked, the textures, the camera.
  uLayer:            'frame',
  uCloudShape:       'frame',
  uLitRG:            'frame',   // the light fade's per-layer weights
  uCloudLit:         'frame',   // the volume's own light texture, not the scene set's
  uGroundHistory:    'frame',   // last frame's ground shadow, for the ease
  uGroundBlend:      'frame',   // from the ease and the frame time
  uDepthTexture:     'frame',
  uCameraNear:       'frame',
  uCameraFar:        'frame',
  uInverseProjection: 'frame',
  uInverseView:      'frame',
  uCameraPos:        'frame',
  uWeatherMap:       'frame',
  tDiffuse:          'frame',
  uCloudTex:         'frame',
  // Fixed at construction.
  uResolution:       'constant',   // the bake's layer size
  uLayers:           'constant',
  uMaxOpticalDepth:  'constant',
}
