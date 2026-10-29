/**
 * cloudsVolume.js — the cloud renderer. Clouds are a density field baked into
 * 3D textures; every pixel then marches through the bake instead of through
 * noise.
 *
 * THREE PASSES
 *   1. BAKE   the signed fBM (fractal noise) of the field, one horizontal layer
 *             per draw, into the shape volume (256² x 32 texels).
 *   2. LIGHT  per cell, the optical depth toward the sun through the shape
 *             volume, into the lit volume. Refreshed `lightLayersPerFrame`
 *             layers per frame; the ground shadow every frame.
 *   3. MARCH  the per-pixel raymarch through the lit volume, one texture fetch
 *             per step, into a cached cloud target. A composite pass blends that
 *             target over the scene every frame.
 *   Against a per-pixel noise march this is one to two orders of magnitude
 *   cheaper. The price: no octave finer than two cells fits the grid, so the
 *   march resumes the same fBM series analytically for those (detail octaves).
 *
 * ROLLING WINDOW. The volume is a torus: texel t holds cell index t mod
 * resolution, which is what RepeatWrapping addresses. The field is static in
 * cloud space (world space shifted by the accumulated wind); drift is the
 * sampling window moving through it. The window is placed around what is read
 * (the view cone out to the draw distance, the ground shadow's footprint and
 * the light bake's reach, each toward the sun), not around the camera, and it
 * moves once that region leaves it by its margin. Only the cells that entered
 * are re-baked: the bake draws each layer through a scissor (a rectangle outside
 * which the GPU writes nothing), once per strip, so every other texel keeps
 * its value. The light volume's strips are widened downsun, since the cells
 * lit through the entering ones change too. When the strips cover half the
 * volume, the whole volume is re-baked instead.
 *
 * Two limits are accepted. A camera turn far enough to move the window redraws
 * large strips in one frame (a hitch; the installation's camera does not turn,
 * the debug fly camera does). With the sun below elevation 0.2 the far shadow
 * footprints no longer fit the window and read wrapped cells.
 *
 * EASED VALUES. The cloud amount (`coverage`) and the cloud scale (`baseFreq`)
 * are held rows; the uniforms the passes use chase them frame by frame
 * (`_ease`). The amount eases over `coverageEase` seconds, so a slider step is a
 * ramp, not a pop the light layers cannot follow. The scale moves at most
 * `rollStepLimit` per frame, so a roll always passes its one-cell test and never
 * falls back to a whole re-bake. A restore snaps both.
 *
 * LIGHT FADE. A relight refreshes one layer of 32 per frame, so without care
 * each layer's light would jump when its turn came. Each lit layer therefore
 * stores its light twice (RG and BA). A relight overwrites the copy the march is
 * not showing (a colour mask keeps the other), and the layer's weight then moves
 * from the old copy to the new over one relight cycle (32 frames at one layer
 * per frame): every layer's light changes a little each frame, never in a step.
 * The march mixes the two layers around a sample by hand with each layer's own
 * weight (`litAt`). Strips and whole re-bakes write both copies.
 *
 * GROUND SHADOW. What terrain, water and the shafts read is not the volume but
 * `_ground`, a 2-D target pair holding the optical depth of the whole column at
 * each cell, redone every frame by the same light shader (layer 0's draw). It
 * reads last frame's value and writes an exponential ease toward the new one
 * (`groundEase`), which a layer of the volume could not do: it cannot be read
 * while it is written. It wraps like the volume, so a window shift writes only
 * the entering strips fresh.
 *
 * STALENESS. Each row names what its change makes stale (`invalidates`, see
 * cloudParams.js) and `_invalidate` does it: the grid is re-derived, the shape
 * re-baked (a smooth frequency step rolls the re-bake over a few layers per
 * frame), the light recomputed, or the march re-run. While the world holds
 * still (`setSceneStatic`) all owed work finishes at once, and once nothing is
 * owed `renderClouds` skips every stage and keeps the cached target.
 *
 * Both volumes are RGBA half-float, 16.8 MB each. On a GPU without
 * float-renderable 3D targets the clouds do not render.
 *
 * Other surface: `clouds.params` (every cloudParams.js row, plus the switch and
 * the worley-octave ceiling as fields), `getShadowFrame()` (the sun-shadow
 * field terrain, water and godrays read), `passes` (the composer pass), the
 * grid readouts and snapshot state.
 */

import * as THREE from 'three'
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js'
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js'
import noiseGlsl from '../shared/shaders/noise.glsl?raw'
import cloudCommonGlsl from './shaders/includes/cloudCommon.glsl?raw'
import cloudShadeGlsl from './shaders/includes/cloudShade.glsl?raw'
import bakeFragSrc from './shaders/cloudVolumeBake.frag?raw'
import lightFragSrc from './shaders/cloudVolumeLight.frag?raw'
import volumeFragSrc from './shaders/cloudsVolume.frag?raw'
import { inject } from '../shared/shaderCompose.js'
import { paramAccess } from '../shared/paramAccess.js'
import { CLOUD_PARAMS, UNIFORM_CLASSES } from './cloudParams.js'
import { uniformsFor, rowDefaults } from '../shared/paramSchema.js'
import {
  applyUniforms, captureUniforms, namesOfClass, STATE_FORMAT,
} from '../shared/uniformSerialize.js'
import { bakeWeatherMap } from './cloudWeatherMap.js'
import {
  cellSize, safeOctaveCount, amplitudeNormFractional, windOffset, windVector,
  nextLightLayer, stepLitWeights, weatherRelightDistance, rollStepLimit, ROLL_MAX_SHIFT_CELLS,
  refreshRects, lightPad, shouldFullRebake, REANCHOR_MARGIN,
  detailOctaveCount, detailStartAmp, detailStartFreq,
  safeWorleyOctaveCount, maxSafeFrequency, octaveEdgeCloseness,
  windowCentre, windowExtent, windowCapacity, frustumHalfAngle, viewRegion,
  windowContains, windowOriginForBox,
} from './cloudVolumeMath.js'
import { PLANE_SIZE } from '../shared/sceneConfig.js'

const VERT = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`

// Composite: blend the cached cloud RT over whatever the composer produced.
// Cheap, runs every frame regardless of how often the march behind it re-runs.
const COMPOSITE_FRAG = `
uniform sampler2D tDiffuse;
uniform sampler2D uCloudTex;
varying vec2 vUv;
void main() {
  vec4 c = texture2D(uCloudTex, vUv);
  gl_FragColor = vec4(mix(texture2D(tDiffuse, vUv).rgb, c.rgb, c.a), 1.0);
}
`

const SRC = {
  noise:  noiseGlsl,
  common: cloudCommonGlsl,
  shade:  cloudShadeGlsl,
  bake:   bakeFragSrc,
  light:  lightFragSrc,
  volume: volumeFragSrc,
}
const composeBake   = () => inject(SRC.bake,   [['// noise.glsl injected by cloudsVolume.js', SRC.noise]])
const composeLight  = () => SRC.light
const composeVolume = () => inject(SRC.volume, [
  ['// noise.glsl injected by cloudsVolume.js',       SRC.noise],
  ['// cloudCommon.glsl injected by cloudsVolume.js', SRC.common],
  ['// cloudShade.glsl injected by cloudsVolume.js',  SRC.shade],
])
const composeComposite = () => COMPOSITE_FRAG

// Grid shape. Resolution and layer count are structural (changing them
// reallocates the volumes), so they are constructor-level rather than sliders;
// the draw distance is a slider: it sets the window's extent, which trades draw
// distance against detail without touching allocation.
const RESOLUTION = 256
const LAYERS     = 32
const ALL_LAYERS = Array.from({ length: LAYERS }, (_, i) => i)

// The coverage eases to within this of its row, then lands on it.
const COVERAGE_SNAP = 1e-4

// Every row's default, by key.
const DEFAULT = rowDefaults(CLOUD_PARAMS)
// How uniformsFor builds the rows it cannot seed with a number: the weather
// sky (a colour-managed THREE.Color) and the sun's azimuth (a Vector2).
const MAKE = {
  srgb: hex => new THREE.Color(hex),
  vec2: ([x, y]) => new THREE.Vector2(x, y),
}

/** The cloud renderer; `main.js` creates it as `clouds`. See the file header. */
export class VolumeClouds {
  /**
   * @param {import('../shared/sceneUniforms.js').SceneUniforms} sceneUniforms
   *   the scene-wide set; this volume owns and writes its uUsableRadius, which
   *   godrays reads
   */
  constructor(sceneUniforms) {
    // The row-backed uniforms, one object each, seeded from cloudParams.js's
    // rows; the tables below mount each into every pass that reads it.
    const fromRows = uniformsFor(CLOUD_PARAMS, () => true, MAKE)
    // Seeded for the default draw distance here; _recomputeGrid rewrites both.
    const usable = sceneUniforms.mount(['uUsableRadius']).uUsableRadius

    usable.value = DEFAULT.drawDistance
    // Shared by REFERENCE across the three materials (the terrain.js pattern):
    // one write reaches every pass that reads the value, so the bake, the light
    // march and the per-pixel march can never disagree about the grid or the
    // field. Never reassign these objects — only their .value.
    const shared = {
      uOriginCell:   { value: new THREE.Vector2() },
      uResolution:   { value: RESOLUTION },
      uLayers:       { value: LAYERS },
      uCellSize:     { value: 0 },
      uExtent:       { value: windowExtent(DEFAULT.drawDistance) },
      uCloudLevel:   fromRows.uCloudLevel,
      uCloudHeight:  fromRows.uCloudHeight,
      uDensityScale: fromRows.uDensityScale,
      uCoverage:     { value: DEFAULT.coverage },
      uSunAzimuth:   fromRows.uSunAzimuth,
      uSunElevation: fromRows.uSunElevation,
      // The fBM series' ratios: the bake sums its octaves with them and the
      // march resumes the same series past the grid's limit (detailFbm), so
      // both read one object.
      uLacunarity:          fromRows.uLacunarity,
      uGain:                fromRows.uGain,
    }
    this._shared = shared

    this._bakeMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uOriginCell:  shared.uOriginCell,
        uResolution:  shared.uResolution,
        uLayers:      shared.uLayers,
        uCellSize:    shared.uCellSize,
        uCloudLevel:  shared.uCloudLevel,
        uCloudHeight: shared.uCloudHeight,
        uLayer:       { value: 0 },
        // The frequency-rescale anchor and the phases that keep the field
        // still when it moves — see cloudVolumeBake.frag. Written only by
        // _moveAnchor, which keeps the three consistent.
        uFreqAnchor:  { value: new THREE.Vector2() },
        uFreqPhase:   { value: new THREE.Vector2() },
        uWorleyPhase: { value: new THREE.Vector2() },
        uBaseFreq:    { value: DEFAULT.baseFreq },
        uLacunarity:  shared.uLacunarity,
        uGain:        shared.uGain,
        uAmpNorm:     { value: 1.0 },
        uOctaves:     { value: 4 },
        // Fades OUT the last octave the bake loop runs, as it nears this
        // grid's Nyquist limit — see octaveEdgeCloseness's doc in
        // cloudVolumeMath.js and _recomputeGrid's use of it. 1 = full weight
        // (the last octave is comfortably inside the limit).
        uLastOctaveWeight: { value: 1.0 },
        // Curl-noise domain warp — see cloudVolumeBake.frag's own doc for the
        // Nyquist constraint.
        uCurlFreq:     fromRows.uCurlFreq,
        uCurlStrength: fromRows.uCurlStrength,
        // Worley erosion of the base noise — see cloudVolumeBake.frag's own doc.
        uWorleyFreq:    fromRows.uWorleyFreq,
        uWorleyAmount:  fromRows.uWorleyAmount,
        uWorleyErosion: fromRows.uWorleyErosion,
        // The requested ceiling clamped to what this grid can carry
        // (_recomputeGrid); the request itself is the `worleyOctaves` field.
        uWorleyOctaves: { value: DEFAULT.worleyOctaves },
      },
      vertexShader:   VERT,
      fragmentShader: composeBake(),
    })

    // Read by the light bake and the march alike, so the shadow and the drawn
    // cloud take the same weather bias at the same world point.
    const biasUniforms = {
      uWindOffset:    { value: new THREE.Vector2() },
      uWeatherOffset: { value: new THREE.Vector2() },
      uWeatherMap:    { value: null },
    }

    this._lightMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uCloudShape:      { value: null },
        uOriginCell:      shared.uOriginCell,
        uResolution:      shared.uResolution,
        uLayers:          shared.uLayers,
        uCellSize:        shared.uCellSize,
        uExtent:          shared.uExtent,
        uCloudLevel:      shared.uCloudLevel,
        uCloudHeight:     shared.uCloudHeight,
        uDensityScale:    shared.uDensityScale,
        uCoverage:        shared.uCoverage,
        uSunAzimuth:      shared.uSunAzimuth,
        uSunElevation:    shared.uSunElevation,
        uLayer:           { value: 0 },
        uLightSteps:      fromRows.uLightSteps,
        uLightStepSize:   fromRows.uLightStepSize,
        uMaxOpticalDepth: { value: 4096.0 },
        uGroundHistory:   { value: null },
        uGroundBlend:     { value: 1 },
        uWindOffset:      biasUniforms.uWindOffset,
        uWeatherOffset:   biasUniforms.uWeatherOffset,
        uWeatherMap:      biasUniforms.uWeatherMap,
        uWeatherScale:    fromRows.uWeatherScale,
        uWeatherStrength: fromRows.uWeatherStrength,
      },
      vertexShader:   VERT,
      fragmentShader: composeLight(),
    })

    // The light fade's per-layer state (LIGHT FADE in the header): the weight
    // the march puts on each layer's RG copy, and the copy its last relight wrote.
    this._litWeight = new Float32Array(LAYERS).fill(1)
    this._litTarget = new Float32Array(LAYERS).fill(1)
    this._litFading = false
    // The ground shadow lives apart from the volume: the optical depth of the whole
    // column at each cell, in a 2-D target pair used in turn. The light shader
    // blends this frame's value with the last one (an exponential ease), which a
    // layer of the volume could not do: it cannot be read while it is written.
    this._ground = [null, null]
    this._groundCur = 0          // the one written last, which the readers sample
    this._groundValid = false    // false: nothing to blend from yet
    this._dt = undefined         // the frame time update() was given
    this._time = 0               // the clouds' own clock; the wind offsets are its function
    this.groundDraws = 0         // ground relights so far, for the probes

    this._marchMaterial = new THREE.ShaderMaterial({
      defines: { LIT_LAYERS: LAYERS },
      uniforms: {
        uDepthTexture:      { value: null },
        uCloudLit:          { value: null },
        uLitRG:             { value: this._litWeight },
        uCameraNear:        { value: 0.1 },
        uCameraFar:         { value: 3000.0 },
        uInverseProjection: { value: new THREE.Matrix4() },
        uInverseView:       { value: new THREE.Matrix4() },
        uCameraPos:         { value: new THREE.Vector3() },
        uWindOffset:        biasUniforms.uWindOffset,
        // Multi-band differential drift (detail tail only) — see
        // detailFbm's own doc in cloudsVolume.frag for why these are NOT
        // derived from uWindOffset.
        uMidWindOffset:     { value: new THREE.Vector2() },
        uFineWindOffset:    { value: new THREE.Vector2() },
        uExtent:            shared.uExtent,
        // The scene-wide object: godrays fades its beams at the same radius.
        uUsableRadius:      usable,
        uCloudLevel:        shared.uCloudLevel,
        uCloudHeight:       shared.uCloudHeight,
        // Horizon curvature droop — see cloudsVolume.frag's own doc. 0 = off
        // (flat shell).
        uPlanetCurve:       fromRows.uPlanetCurve,
        uDensityScale:      shared.uDensityScale,
        uCoverage:          shared.uCoverage,
        uSunAzimuth:        shared.uSunAzimuth,
        uSunElevation:      shared.uSunElevation,
        uAbsorption:        fromRows.uAbsorption,
        uScatteringAniso:   fromRows.uScatteringAniso,
        // The analytic detail below is bounded by the MARCH step, not the grid:
        // at a 16 u step (the grid's own cell size) there is nothing it could
        // add. A step finer than the cell is what turns detailFbm's octaves on,
        // and the extra steps are what that detail costs per frame.
        uMaxSteps:          fromRows.uMaxSteps,
        uMarchStepSize:     fromRows.uMarchStepSize,
        uDebugView:         fromRows.uDebugView,
        // Skip march work whose result is provably zero (cloudsVolume.frag's
        // detailBound and the out-of-shell test). Exact: on and off render the
        // same pixels, which cloud_impl.spec.js asserts; only a test turns it off.
        uEmptySpaceSkip:    fromRows.uEmptySpaceSkip,
        // Step widening per step, so the march keeps its reach at a fine
        // starting step. 0 = uniform steps (and a march that stops short).
        uStepGrowth:        fromRows.uStepGrowth,
        // Analytic high-frequency detail — the baked series resumed at march
        // time. Octaves/freq/amp are DERIVED in _recomputeGrid; only the
        // amount is authored, 1.0 meaning an exact continuation (its default's
        // reasoning is on the cloudParams.js row).
        uDetailAmount:      fromRows.uDetailAmount,
        uDetailOctaves:     { value: 0 },
        uDetailFreq:        { value: 0.096 },
        uDetailAmp:         { value: 0.0625 },
        // The boundary-octave crossfade's marched half — see
        // uLastOctaveWeight above and cloudsVolume.frag's detailFbm. Same
        // frequency as whatever octave the bake is currently fading out;
        // amplitude 0 (the common case) when that octave is comfortably
        // inside the grid's Nyquist limit and nothing needs standing in.
        uBoundaryFreq:      { value: 0.096 },
        uBoundaryAmp:       { value: 0.0 },
        // Same progress variable as uLastOctaveWeight's complement (1 - edge)
        // above, just handed to the march material too — see detailFbm's use
        // of it. Drives a POSITIONAL crossfade, not an amplitude one: as an
        // octave-count drop nears, every marched octave is about to slide down
        // one drift-speed band (boundary -> mid, mid -> fine), and the two
        // ends of that slide sample different offsets even when their
        // amplitudes already agree (see detailFbm's own comment on why this
        // exists).
        uOctaveEdge:        { value: 0.0 },
        uLacunarity:        shared.uLacunarity,
        uGain:              shared.uGain,
        // Weather map — the coverage bias, also applied in the light bake.
        // Texture assigned once _ensureVolumes bakes it.
        uWeatherMap:        biasUniforms.uWeatherMap,
        uWeatherOffset:     biasUniforms.uWeatherOffset,
        uWeatherScale:      fromRows.uWeatherScale,
        uWeatherStrength:   fromRows.uWeatherStrength,
        // Shading tail (cloudShade.glsl). Shared with _compositeMaterial (see
        // `shared` above).
        uCloudColorSteps:   fromRows.uCloudColorSteps,
        uCloudAlphaTiers:   fromRows.uCloudAlphaTiers,
        uCloudWeatherSky:   fromRows.uCloudWeatherSky,
        uCloudWeatherGrey:  fromRows.uCloudWeatherGrey,
        // Shading-tail experiments (cloudCommon.glsl): on-off toggles as 1/0.
        uUseSint:           fromRows.uUseSint,
        uPowderEnabled:     fromRows.uPowderEnabled,
        uPowderStrength:    fromRows.uPowderStrength,
      },
      vertexShader:   VERT,
      fragmentShader: composeVolume(),
    })

    this._bakeQuad  = new FullScreenQuad(this._bakeMaterial)
    this._lightQuad = new FullScreenQuad(this._lightMaterial)
    this._marchQuad = new FullScreenQuad(this._marchMaterial)

    // Params with no shader behind them, kept as { value } objects so the
    // accessor and the snapshot sweep treat them like any uniform.
    this._jsUniforms = {
      uCloudSpeed:      fromRows.uCloudSpeed,   // drives the wind offset
      uWeatherSpeed:    fromRows.uWeatherSpeed,   // drives uWeatherOffset
    }

    this._compositeMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse:  { value: null },
        uCloudTex: { value: null },
      },
      vertexShader:   VERT,
      fragmentShader: composeComposite(),
    })
    this.pass = new ShaderPass(this._compositeMaterial)
    this.pass.enabled = DEFAULT.enabled   // the `enabled` param

    this._cloudRT   = null
    this._canvasW   = 0
    this._canvasH   = 0
    this._shapeRT   = null
    this._litRT     = null
    this._supported = null             // resolved on the first render
    this._lightLayer   = 0
    this._lightPending = 0             // light layers still owing a re-bake
    this._shapeDirty   = true
    // Set by main.js each frame: may this volume coast on what it already has?
    // See renderClouds for what it actually gates — never the bookkeeping, only
    // the GPU work whose result would come out identical.
    this._sceneStatic  = false
    // Forces one march regardless of _sceneStatic. _cloudRT is allocated BLANK,
    // so whoever replaces it (a resize, a render-scale change) must say so or a
    // frozen world would coast forever on an empty sky.
    this._marchDirty   = true
    this._origin = { x: NaN, z: NaN }  // forces a first bake
    // The origin the CONTENT currently reflects, as opposed to the one the
    // window wants. null means "no usable content" and forces a full sweep;
    // otherwise the difference between the two is exactly what needs re-baking.
    // Kept separate from _origin so that frames where renderClouds is skipped
    // (paused, or holding still) accumulate correctly instead of losing track
    // of what is stale.
    this._bakedOrigin = null
    // Where the weather map sat against the cloud field (its offset minus the
    // wind's) when the light was last baked; null until the first update.
    this._biasBaked = null
    this._lastRects = 0
    this._reanchorMargin = REANCHOR_MARGIN
    this._dir = new THREE.Vector3()
    this._regionFits = true            // the last region read fits the window

    // Rolling shape re-bake (a `roll` invalidation): layers still owing a
    // re-bake, the cursor through the layers, and which base / Worley frequency each
    // layer was last baked at — the spread between those is what decides
    // whether another roll is still invisible.
    this._shapePending = 0
    this._shapeCursor  = 0
    this._layerBaseFreq   = new Array(LAYERS).fill(NaN)
    this._layerWorleyFreq = new Array(LAYERS).fill(NaN)

    // The worley-octaves SLIDER is a requested ceiling (1-3); the uniform the
    // shader actually reads is clamped down to whatever's Nyquist-safe on the
    // current grid — see _recomputeGrid's worley section. Kept separate so a
    // later grid change (draw distance, worley scale) can recover octaves the
    // request never lost, instead of ratcheting the ceiling down permanently.
    this._worleyOctavesRequested = DEFAULT.worleyOctaves

    // The one accessor over every cloud value: the rows of cloudParams.js, over
    // every table (a uniform several passes read is one shared object, so the
    // first table that has it is the right one to write). Callers read and
    // write through it: `clouds.params.set(key, v)`.
    //
    // Its change guard (an equal value does nothing) is load-bearing here:
    // coverage moves every frame under the weather and the sun is copied in
    // every frame, both light invalidations. A per-frame write of the value
    // already held would pin _lightPending at LAYERS and bake a full 256²
    // light layer every frame, each at a different coverage from its
    // neighbours.
    const bu = this._bakeMaterial.uniforms
    this.params = paramAccess({
      tables: this._uniformTables(),
      rows:   CLOUD_PARAMS,
      fields: {
        enabled: { get: () => this.pass.enabled, set: v => { this.pass.enabled = v } },
        // Reads back the CLAMPED uniform, so a request equal to what the grid
        // already carries is a no-op that leaves the ceiling where it was.
        worleyOctaves: {
          get: () => bu.uWorleyOctaves.value,
          set: v => { this._worleyOctavesRequested = v; bu.uWorleyOctaves.value = v },
        },
      },
      onInvalidate: cls => this._invalidate(cls),
    })

    this._recomputeGrid()
  }

  /**
   * What a param change makes stale, by its row's `invalidates` class
   * (cloudParams.js). A row lists `grid` first, so `roll` reads the re-derived
   * cell size.
   */
  _invalidate(cls) {
    switch (cls) {
      case 'grid':  this._recomputeGrid(); break
      case 'shape': this._invalidateShape(); break
      case 'roll':
        // A small frequency step (the form walker moves the scatter dial a
        // little every tick): re-bake a few layers per frame instead of the
        // whole volume. The window content stays valid, so _bakedOrigin is kept.
        if (this._rollStaysInvisible()) this._shapePending = LAYERS
        else this._invalidateShape()
        break
      case 'light':  this._invalidateLight(); break
      case 'march':  this._marchDirty = true; break
      default: throw new Error(`clouds: unknown invalidation "${cls}"`)
    }
  }

  /** The field itself changed: re-bake the whole shape (not a shift) and relight. */
  _invalidateShape() {
    this._shapeDirty = true
    this._bakedOrigin = null
  }

  // ─── Grid derivation ───────────────────────────────────────────────────────

  /**
   * Recompute everything that follows from the grid: the cell size, and with it
   * the octaves the bake can carry (a grid resolves frequencies only up to
   * kMax = maxSafeFrequency(cell)), the analytic detail tail the march adds for
   * the octaves it cannot, and the usable radius. The extent follows from the
   * draw distance and the octave count from the cell size: both are derived,
   * never authored, and a longer draw distance costs octaves.
   */
  _recomputeGrid() {
    const drawDistance = this.params.get('drawDistance')
    const extent = windowExtent(drawDistance)
    this._shared.uExtent.value = extent
    const cell = cellSize(extent, RESOLUTION)
    const bu = this._bakeMaterial.uniforms
    const baseFreq = bu.uBaseFreq.value
    const lac = bu.uLacunarity.value
    const gain = bu.uGain.value
    const octaves = Math.max(1, safeOctaveCount(baseFreq, lac, cell))

    // The last baked octave sits near kMax, where trilinear reconstruction
    // blurs it unpredictably. `edge` (0..1) fades its baked weight out while a
    // marched copy of the same frequency fades in, so dropping it is no jump.
    const kMax = maxSafeFrequency(cell)
    const lastFreq = baseFreq * Math.pow(lac, Math.max(0, octaves - 1))
    const edge = octaveEdgeCloseness(lastFreq, kMax)

    this._shared.uCellSize.value = cell
    bu.uOctaves.value = octaves
    bu.uAmpNorm.value = amplitudeNormFractional(octaves, gain, edge)
    bu.uLastOctaveWeight.value = 1 - edge

    // The detail tail continues the same fBM series where the bake stopped; how
    // many octaves of it are usable is set by the march step, not the grid. The
    // marched boundary term is the faded-out part of the last baked octave.
    const mu = this._marchMaterial.uniforms
    mu.uDetailFreq.value  = detailStartFreq(baseFreq, lac, octaves)
    mu.uDetailAmp.value   = detailStartAmp(gain, octaves) * bu.uAmpNorm.value
    mu.uDetailOctaves.value = detailOctaveCount(
      baseFreq, lac, octaves, mu.uMarchStepSize.value)
    mu.uBoundaryFreq.value = lastFreq
    mu.uBoundaryAmp.value  = Math.pow(gain, Math.max(0, octaves - 1)) * bu.uAmpNorm.value * edge
    mu.uOctaveEdge.value   = edge
    mu.uUsableRadius.value = drawDistance

    // The Worley ceiling has its own Nyquist limit; 0 octaves means the bake
    // skips Worley.
    bu.uWorleyOctaves.value = Math.min(
      this._worleyOctavesRequested, safeWorleyOctaveCount(bu.uWorleyFreq.value, cell))
  }

  /** Octaves the current grid actually bakes, for the debug readout. */
  getOctaves() { return this._bakeMaterial.uniforms.uOctaves.value }
  /** Extra octaves the per-pixel march resolves on top of those. */
  getDetailOctaves() { return this._marchMaterial.uniforms.uDetailOctaves.value }
  /** World units per horizontal cell — the resolution limit, in plain units. */
  getCellSize() { return this._shared.uCellSize.value }

  // ─── Public surface ────────────────────────────────────────────────────────

  /** For postprocessing.js to add to the composer. */
  get passes() { return [this.pass] }

  setDepthTexture(tex) { this._marchMaterial.uniforms.uDepthTexture.value = tex }

  /**
   * The cloud shadow, as plain values for main.js to push into the scene
   * uniforms, where terrain, water and godrays read it: the ground shadow's
   * texture, the normalised sun, the shell's level, height and extent, the wind
   * offset and the planet curve. `ground` is null until the volume is built.
   *
   * The ground texture's G channel is the optical depth toward the sun,
   * integrated through the whole shell, so it is valid for any point under the
   * deck.
   */
  getShadowFrame() {
    const m = this._marchMaterial.uniforms
    const az = this._shared.uSunAzimuth.value
    const el = this._shared.uSunElevation.value
    const sl = Math.hypot(az.x, el, az.y) || 1
    return {
      ground: this._ground[this._groundCur] ? this._ground[this._groundCur].texture : null,
      // Normalised here so every consumer reads the SAME sun vector: the
      // terrain's shadows and the water's shadows and glint.
      sunX: az.x / sl, sunY: el / sl, sunZ: az.y / sl,
      level:  this._shared.uCloudLevel.value,
      height: this._shared.uCloudHeight.value,
      extent: this._shared.uExtent.value,
      windX:  m.uWindOffset.value.x,
      windZ:  m.uWindOffset.value.y,
      curve:  m.uPlanetCurve.value,
    }
  }

  /** Draw distance the current margin leaves, in world units. */
  getUsableRadius() { return this._marchMaterial.uniforms.uUsableRadius.value }

  /**
   * False when the GPU cannot render to a half-float 3D target (the clouds then
   * do not render).
   *
   * Tri-state behind it: null until the first renderClouds() has had a renderer
   * to probe with, so "not yet known" reads as supported. Callers that need
   * certainty must look after a frame has rendered.
   */
  isSupported() { return this._supported !== false }

  /** Pipeline state, for the headless probes and the debug console. */
  getDiagnostics() {
    return {
      supported:    this._supported,
      hasVolumes:   !!this._shapeRT && !!this._litRT,
      hasCloudRT:   !!this._cloudRT,
      enabled:      this.pass.enabled,
      shapeDirty:   this._shapeDirty,
      lightPending: this._lightPending,
      shapePending: this._shapePending,
      cellSize:     this.getCellSize(),
      octaves:      this.getOctaves(),
      originCell:   { x: this._origin.x, z: this._origin.z },
      bakedOrigin:  this._bakedOrigin && { ...this._bakedOrigin },
      lastRects:    this._lastRects,
      regionFits:   this._regionFits,
    }
  }

  setSize(w, h) {
    this._canvasW = w
    this._canvasH = h
    this._allocateCloudRT()
  }

  /** (Re)allocate the 2D cloud RT at the canvas size. */
  _allocateCloudRT() {
    if (!this._canvasW || !this._canvasH) return
    if (this._cloudRT) this._cloudRT.dispose()
    this._cloudRT = new THREE.WebGLRenderTarget(this._canvasW, this._canvasH)
    this._compositeMaterial.uniforms.uCloudTex.value = this._cloudRT.texture
    // The new target is empty. Nothing else would fill it while the world is
    // holding still, so claim one march no matter what renderClouds decides.
    this._marchDirty = true
  }

  /**
   * Per-frame: ease the cloud amount and scale toward their rows, advance cloud
   * time, refresh the camera-ray uniforms, and move the sampling window. `dt` is
   * the frame time in seconds; without it the eased values snap. A re-anchor is what makes the shape volume stale —
   * drift within a cell is carried by the sample coordinate and costs nothing.
   *
   * `advance` moves the clouds' own clock, which every wind offset is a
   * function of. main.js passes dt times animSpeed's cloud pace, so the drift
   * stops under a painting. The clock lives here so a restore can set it
   * (importState), rather than the offsets being recomputed from a clock the
   * snapshot never saw.
   */
  update(camera, advance, dt) {
    this._dt = dt
    this._time += advance
    const time = this._time
    // While the world holds still the eased values land on their rows now: the
    // held picture is the settled one, and a tail of ease would keep re-baking it.
    this._ease(this._sceneStatic ? undefined : dt)
    const u = this._marchMaterial.uniforms
    u.uInverseProjection.value.copy(camera.projectionMatrixInverse)
    u.uInverseView.value.copy(camera.matrixWorld)
    u.uCameraPos.value.copy(camera.position)
    u.uCameraNear.value = camera.near
    u.uCameraFar.value  = camera.far

    const cloudSpeed = this._jsUniforms.uCloudSpeed.value
    const off = windOffset(cloudSpeed, time)
    u.uWindOffset.value.set(off.x, off.z)

    // Multi-band differential drift: base/mid/fine at 1x/0.75x/0.375x of the
    // same wind (see cloudVolumeMath.js's windVector doc). Each band's offset is
    // its OWN independent windOffset() call at a scaled speed, never derived
    // from uWindOffset — see detailFbm's doc in cloudsVolume.frag for why.
    const midOff = windOffset(cloudSpeed * 0.75, time)
    u.uMidWindOffset.value.set(midOff.x, midOff.z)
    const fineOff = windOffset(cloudSpeed * 0.375, time)
    u.uFineWindOffset.value.set(fineOff.x, fineOff.z)

    // Independent of the density field's own wind — see cloudsVolume.frag's
    // weatherBias doc. Reuses windOffset's formula with its own speed; there's
    // nothing wind-specific about it, just a steady translation over time.
    const wOff = windOffset(this._jsUniforms.uWeatherSpeed.value, time)
    u.uWeatherOffset.value.set(wOff.x, wOff.z)
    this._trackWeatherBias(off, wOff)

    // The window follows what is read, not the camera (cloudVolumeMath.js's
    // "Window placement"). Nothing in the stored field depends on where the
    // camera is, so it only moves once the region leaves it (with its margin),
    // and then only if that changes its origin: a region wider than the window
    // (a grazing sun) would otherwise re-anchor every frame.
    const extent = this._shared.uExtent.value
    const box = this._readRegion(camera, off, extent)
    if (Number.isNaN(this._origin.x) ||
        !windowContains(this._origin, extent, RESOLUTION, box, this._reanchorMargin)) {
      const origin = windowOriginForBox(box, extent, RESOLUTION)
      if (Number.isNaN(this._origin.x) || origin.x !== this._origin.x || origin.z !== this._origin.z) {
        this._origin = origin
        this._shared.uOriginCell.value.set(origin.x, origin.z)
        // Keep the anchor on the window, so a frequency change can never slide
        // the clouds by more than the window's own size. Field-preserving (see
        // _moveAnchor), so the incremental path below stays consistent.
        const c = windowCentre(origin, extent, RESOLUTION)
        this._moveAnchor(c.x, c.z)
        this._shapeDirty = true
      }
    }
  }

  /**
   * Move the two eased uniforms toward their rows. The rows are what the weather,
   * the sliders and the form dials write; a jump in one would otherwise reach
   * every cloud pixel in one frame.
   *
   * - coverage: an exponential ease of `coverageEase` seconds. The light is
   *   re-baked layer by layer, so the ramp has to be a ramp, not a step.
   * - baseFreq: at most rollStepLimit per frame, so a roll (a few layers per
   *   frame) always passes its one-cell test and never falls back to a full
   *   re-bake in one frame. A bigger move simply takes more frames.
   *
   * `dt` undefined snaps both (a restore, the tests). dt 0 (paused) holds.
   */
  _ease(dt) {
    if (dt === 0) return
    const coverage = this._shared.uCoverage
    const wantCoverage = this.params.get('coverage')
    if (coverage.value !== wantCoverage) {
      const tau = this.params.get('coverageEase')
      let next = wantCoverage
      if (dt !== undefined && tau > 0) {
        next = coverage.value + (wantCoverage - coverage.value) * (1 - Math.exp(-dt / tau))
        if (Math.abs(wantCoverage - next) < COVERAGE_SNAP) next = wantCoverage
      }
      coverage.value = next
      this._invalidateLight()
    }
    const freq = this._bakeMaterial.uniforms.uBaseFreq
    const wantFreq = this.params.get('baseFreq')
    if (freq.value !== wantFreq) {
      let next = wantFreq
      if (dt !== undefined) {
        const step = freq.value * rollStepLimit(RESOLUTION, LAYERS, this.params.get('rollLayersPerFrame'))
        const diff = wantFreq - freq.value
        // Lands on the row exactly: `freq + (want - freq)` can miss it by a rounding
        // step and would then roll again every frame, a world that never holds still.
        next = Math.abs(diff) <= step ? wantFreq : freq.value + Math.sign(diff) * step
      }
      freq.value = next
      this._recomputeGrid()
      this._invalidate('roll')
    }
  }

  /**
   * The light bake takes the weather bias at each sample's world position, and
   * in cloud space the map moves by (its own offset - the wind offset). Once it
   * has moved a weatherRelightDistance since the last bake, the light is
   * stale. The ground shadow is redone every frame regardless.
   */
  _trackWeatherBias(wind, weather) {
    const x = weather.x - wind.x, z = weather.z - wind.z
    const b = this._biasBaked
    if (b && Math.hypot(x - b.x, z - b.z) < weatherRelightDistance(this.params.get('weatherScale'))) return
    this._biasBaked = { x, z }
    if (b && this.params.get('weatherStrength') > 0) this._invalidateLight()
  }

  /** Bring the eased uniforms to their rows now (what a snapshot restore does). */
  snapEases() { this._ease() }

  /**
   * The horizontal region of cloud space that is read this frame (see
   * viewRegion): the view cone out to the draw distance, the terrain plane's
   * shadow footprint and the light bake's reach, each toward the sun. `off` is
   * the wind offset that takes world space to cloud space.
   */
  _readRegion(camera, off, extent) {
    const dir = camera.getWorldDirection(this._dir)
    const horizontal = Math.hypot(dir.x, dir.z)
    const pitch = Math.asin(Math.max(-1, Math.min(1, dir.y)))
    // Looking straight up or down: no heading, every direction is in view.
    const halfAngle = horizontal < 1e-3 ? Math.PI : frustumHalfAngle(camera.fov, camera.aspect, pitch)
    const az = this._shared.uSunAzimuth.value
    const lu = this._lightMaterial.uniforms
    const cell = cellSize(extent, RESOLUTION)
    const capacity = windowCapacity(extent, RESOLUTION, this._reanchorMargin)
    const box = viewRegion({
      cam: { x: camera.position.x + off.x, z: camera.position.z + off.z },
      heading: Math.atan2(dir.z, dir.x),
      halfAngle,
      distance: this.params.get('drawDistance'),
      plane: { x: off.x, z: off.z, half: PLANE_SIZE / 2 },
      sun: { x: az.x, y: this._shared.uSunElevation.value, z: az.y },
      level: this._shared.uCloudLevel.value,
      height: this._shared.uCloudHeight.value,
      reach: lu.uLightSteps.value * lu.uLightStepSize.value,
      cell,
      capacity,
    })
    this._regionFits = box.maxX - box.minX <= capacity + 2 * cell &&
                       box.maxZ - box.minZ <= capacity + 2 * cell
    return box
  }

  /**
   * Mark every cell's baked light stale.
   *
   * Deliberately does NOT reset the layer cursor: resetting it would
   * re-bake the low layers over and over when invalidations arrive faster than
   * a refresh cycle completes, never reaching the high ones, so most of the
   * volume would keep light belonging to whatever cell previously occupied that
   * texel. Leaving the cursor where it is makes the sweep clear.
   */
  _invalidateLight() {
    this._lightPending = LAYERS
  }

  _ensureVolumes(renderer) {
    if (this._shapeRT || this._supported === false) return
    if (!renderer.extensions.has('EXT_color_buffer_float') &&
        !renderer.extensions.has('EXT_color_buffer_half_float')) {
      console.warn('[clouds] volume implementation unavailable: no float-renderable target support')
      this._supported = false
      return
    }
    this._shapeRT = new THREE.WebGL3DRenderTarget(RESOLUTION, RESOLUTION, LAYERS)
    this._litRT   = new THREE.WebGL3DRenderTarget(RESOLUTION, RESOLUTION, LAYERS)
    for (const rt of [this._shapeRT, this._litRT]) {
      // Configured AFTER construction on purpose: WebGL3DRenderTarget replaces
      // this.texture with a fresh Data3DTexture *after* calling super(), so
      // anything passed through the constructor's options is discarded.
      // Data3DTexture's defaults do not fit either: Nearest filters (the
      // design rests on hardware trilinear) and UnsignedByte.
      const t = rt.texture
      t.type      = THREE.HalfFloatType     // filterable in WebGL2 core, unlike full float
      t.format    = THREE.RGBAFormat        // universally colour-renderable; R16F/RG16F would
                                            // halve the memory but adds a support question
                                            // that buys nothing at this size (34 MB total)
      t.minFilter = THREE.LinearFilter
      t.magFilter = THREE.LinearFilter
      t.wrapS     = THREE.RepeatWrapping    // the horizontal roll IS this wrap mode
      t.wrapT     = THREE.RepeatWrapping
      t.wrapR     = THREE.ClampToEdgeWrapping   // height does not roll
      rt.depthBuffer   = false
      rt.stencilBuffer = false
    }
    this._ground = [0, 1].map(() => new THREE.WebGLRenderTarget(RESOLUTION, RESOLUTION, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.RepeatWrapping,
      wrapT: THREE.RepeatWrapping,
      depthBuffer: false,
      stencilBuffer: false,
    }))
    this._groundValid = false
    this._lightMaterial.uniforms.uCloudShape.value = this._shapeRT.texture
    this._marchMaterial.uniforms.uCloudLit.value   = this._litRT.texture

    // One-time bake — see cloudWeatherMap.js's doc. Never re-baked; the weather
    // drifts by uWeatherOffset scrolling this same texture.
    this._weatherRT = bakeWeatherMap(renderer)
    this._marchMaterial.uniforms.uWeatherMap.value = this._weatherRT.texture   // shared with the light bake

    this._supported = true
    this._shapeDirty = true
  }

  /**
   * Draw every layer of the 3D target `rt` (or just `layers`), each layer one
   * full-screen quad through `draw`.
   *
   * With `rects`, each draw is restricted by a SCISSOR: a rectangle of the
   * layer's texels outside which the GPU discards every pixel the quad would
   * write. The texels outside keep what they held. That is how only the
   * strips that entered the window get re-baked, instead of the whole layer
   * (`rects` is null: the scissor is off and the whole layer is drawn). Each
   * rect costs one draw per layer.
   *
   * The scissor is set on the render target, not through renderer.setScissor:
   * setRenderTarget copies the target's own scissor into the GL state when it
   * binds, overwriting anything set on the renderer. autoClear is off so the
   * texels outside the rects are not cleared either.
   */
  _renderLayers(renderer, rt, rects, draw, layers = null) {
    const prevAutoClear = renderer.autoClear
    renderer.autoClear = false
    const list = (rects && rects.length) ? rects : [null]
    for (const layer of layers || ALL_LAYERS) {
      for (const r of list) {
        if (r) { rt.scissorTest = true; rt.scissor.set(r.x, r.y, r.w, r.h) }
        else   { rt.scissorTest = false }
        renderer.setRenderTarget(rt, layer)
        draw(layer)
      }
    }
    rt.scissorTest = false
    renderer.autoClear = prevAutoClear
  }

  _bakeShape(renderer, rects = null, layers = null) {
    const u = this._bakeMaterial.uniforms
    this._renderLayers(renderer, this._shapeRT, rects, layer => {
      u.uLayer.value = layer
      this._bakeQuad.render(renderer)
      // A WHOLE layer now holds this frequency. A rect bake only refreshes the
      // entering cells, so the layer keeps its older record — the roll check
      // counts the current frequency in any case.
      if (!rects) {
        this._layerBaseFreq[layer]   = u.uBaseFreq.value
        this._layerWorleyFreq[layer] = u.uWorleyFreq.value
      }
    }, layers)
  }

  /**
   * Re-light every layer, restricted to `rects`, writing both copies. A relight
   * of the cells outside `rects` that is still owed stays owed.
   */
  _bakeLightRects(renderer, rects) {
    const u = this._lightMaterial.uniforms
    this._renderLayers(renderer, this._litRT, rects, layer => {
      u.uLayer.value = layer
      this._lightQuad.render(renderer)
    })
    this._drawGroundRects(renderer, rects)
  }

  /** Sun direction in world space — same convention as the shaders. */
  _sunDir() {
    const az = this._shared.uSunAzimuth.value
    return { x: az.x, y: this._shared.uSunElevation.value, z: az.y }
  }

  /**
   * Relight the ground shadow every frame, eased toward the sky.
   *
   * The ground shadow and the shafts read the optical depth of the whole column
   * at each cell, in `_ground`. The coverage moves every frame as the weather
   * walks and the shape rolls a few layers a frame, so the value is redone every
   * frame and blended with the last one by `1 - exp(-dt / groundEase)`: a
   * continuous ease, with no steps at a relight. Skipped while the scene is
   * static (renderClouds writes it whole then).
   */
  _refreshGroundLayer(renderer) {
    if (this._sceneStatic) return
    const ease = this.params.get('groundEase')
    const blend = (this._groundValid && ease > 0 && this._dt > 0) ? 1 - Math.exp(-this._dt / ease) : 1
    this._drawGround(renderer, blend)
  }

  /**
   * Relight the ground shadow into the target that is not the last one written,
   * mixing `blend` of the new value with the last one (1: the new value alone),
   * and make it the last one written.
   */
  _drawGround(renderer, blend) {
    const u = this._lightMaterial.uniforms
    const history = this._ground[this._groundCur]
    const next = this._ground[1 - this._groundCur]
    u.uLayer.value = 0
    u.uGroundHistory.value = history.texture
    u.uGroundBlend.value = blend
    renderer.setRenderTarget(next)
    this._lightQuad.render(renderer)
    u.uGroundBlend.value = 1
    this._groundCur = 1 - this._groundCur
    this._groundValid = true
    this.groundDraws++
  }

  /** The ground shadow of the cells that entered the window, written fresh into the last one written. */
  _drawGroundRects(renderer, rects) {
    const u = this._lightMaterial.uniforms
    const latest = this._ground[this._groundCur]
    u.uLayer.value = 0
    u.uGroundHistory.value = this._ground[1 - this._groundCur].texture
    u.uGroundBlend.value = 1
    const prevAutoClear = renderer.autoClear
    renderer.autoClear = false
    for (const r of rects) {
      latest.scissorTest = true
      latest.scissor.set(r.x, r.y, r.w, r.h)
      renderer.setRenderTarget(latest)
      this._lightQuad.render(renderer)
    }
    latest.scissorTest = false
    renderer.autoClear = prevAutoClear
  }

  /**
   * Relight the next `count` layers of the pending sweep. A layer other than 0
   * overwrites its hidden copy only and starts fading to it; `whole` writes both
   * copies and no fade (a full re-bake).
   */
  _bakeLightLayers(renderer, count, whole = false) {
    const u = this._lightMaterial.uniforms
    const gl = renderer.getContext()
    for (let i = 0; i < count && this._lightPending > 0; i++) {
      const layer = this._lightLayer
      u.uLayer.value = layer
      renderer.setRenderTarget(this._litRT, layer)
      if (whole) {
        this._lightQuad.render(renderer)
        this._litWeight[layer] = 1
        this._litTarget[layer] = 1
      } else {
        // The target copy is the one now shown; the other is free to overwrite.
        const toRG = this._litTarget[layer] === 0
        gl.colorMask(toRG, toRG, !toRG, !toRG)
        this._lightQuad.render(renderer)
        gl.colorMask(true, true, true, true)
        this._litTarget[layer] = toRG ? 1 : 0
      }
      this._lightLayer = nextLightLayer(this._lightLayer, LAYERS)
      this._lightPending--
    }
  }

  /**
   * Move every layer's weight one frame toward its target. A layer fades over
   * one relight cycle, so it has settled when its next relight arrives and the
   * copy that relight overwrites is no longer shown.
   */
  _advanceFades() {
    const rate = Math.max(this.params.get('lightLayersPerFrame'), 1) / LAYERS
    this._litFading = stepLitWeights(this._litWeight, this._litTarget, rate)
  }

  /**
   * Move the frequency anchor WITHOUT moving the field: the bake samples
   * `(p - A) * f + phase`, so shifting A by Δ and the phase by Δ * f leaves
   * every sample where it was. The only place the anchor is written.
   */
  _moveAnchor(ax, az) {
    const u = this._bakeMaterial.uniforms
    const a = u.uFreqAnchor.value
    const dx = ax - a.x, dz = az - a.y
    if (dx === 0 && dz === 0) return
    u.uFreqPhase.value.x   += dx * u.uBaseFreq.value
    u.uFreqPhase.value.y   += dz * u.uBaseFreq.value
    u.uWorleyPhase.value.x += dx * u.uWorleyFreq.value
    u.uWorleyPhase.value.y += dz * u.uWorleyFreq.value
    a.set(ax, az)
  }

  /**
   * Can a gradual re-bake (`roll`) run without tearing the clouds?
   *
   * While it runs, layers baked at different frequencies sit side by side. A
   * feature at distance r from the frequency anchor (the window's centre) lands
   * r * (1 - f_old / f_new) apart between two such layers, and the march blends
   * them. The worst case is the window's corner, so the corner distance times
   * the relative frequency spread across all layers must stay under one cell,
   * the smallest offset the grid can draw. If not, the caller re-bakes
   * everything at once.
   */
  _rollStaysInvisible() {
    if (!this._shapeRT || !this._bakedOrigin) return false
    const u = this._bakeMaterial.uniforms
    const extent = this._shared.uExtent.value
    const corner = extent * Math.SQRT1_2
    const spread = (layers, now) => {
      let lo = now, hi = now
      for (const f of layers) {
        if (!Number.isFinite(f)) return Infinity
        lo = Math.min(lo, f); hi = Math.max(hi, f)
      }
      return (hi - lo) / Math.max(now, 1e-12)
    }
    const rel = Math.max(spread(this._layerBaseFreq, u.uBaseFreq.value),
                         spread(this._layerWorleyFreq, u.uWorleyFreq.value))
    return corner * rel < ROLL_MAX_SHIFT_CELLS * this._shared.uCellSize.value
  }

  /** Re-bake the next `count` shape layers, in nextLightLayer's order. */
  _rollShape(renderer, count) {
    const n = Math.min(count, this._shapePending)
    const layers = []
    for (let i = 0; i < n; i++) {
      layers.push(this._shapeCursor)
      this._shapeCursor = nextLightLayer(this._shapeCursor, LAYERS)
    }
    this._bakeShape(renderer, null, layers)
    this._shapePending -= n
  }

  /** Re-bake the whole shape and light volume, synchronously. */
  _fullRebake(renderer) {
    // Recentre the anchor on THIS window (a first bake, a snapshot restore).
    // Field-preserving, so it is safe here and anywhere else — see _moveAnchor.
    const anchor = windowCentre(this._origin, this._shared.uExtent.value, RESOLUTION)
    this._moveAnchor(anchor.x, anchor.z)
    this._bakeShape(renderer)
    this._invalidateLight()
    this._bakeLightLayers(renderer, LAYERS, true)
    this._drawGround(renderer, 1)
    this._lastRects = 0
    this._shapePending = 0
  }

  /**
   * Bring both volumes back in step with the current window.
   *
   * Only the cells that newly entered the window are stale — everything still
   * inside stands for the same cloud-space cell as before and its baked value
   * is still right. So a shift re-bakes two thin bands rather than the whole
   * volume, scissored to exactly those texels.
   *
   * The LIGHT volume needs more than that. A cell's stored value is the
   * optical depth along its ray toward the sun, so the entering cells
   * invalidate everything DOWNSUN of them — the bands widened by the sun ray's
   * horizontal travel over the light march's reach. At a low sun that is an
   * order of magnitude more than the shape needs; at a high sun, almost
   * nothing.
   *
   * Past roughly half the volume the rectangles stop paying: each one costs a
   * draw call per layer, and a single full-viewport draw per layer is simply
   * cheaper than many partial ones. shouldFullRebake draws that line.
   */
  _refreshVolumes(renderer) {
    const full = () => this._fullRebake(renderer)

    if (!this._bakedOrigin || !this.params.get('incremental')) {
      full()
      this._bakedOrigin = { ...this._origin }
      return
    }

    const shapeRects = refreshRects(this._bakedOrigin, this._origin, RESOLUTION)
    if (!shapeRects.length) { this._bakedOrigin = { ...this._origin }; return }

    const cell = this._shared.uCellSize.value
    const lu = this._lightMaterial.uniforms
    const reach = lu.uLightSteps.value * lu.uLightStepSize.value
    const pad = lightPad(this._sunDir(), reach, cell)
    const lightRects = refreshRects(this._bakedOrigin, this._origin, RESOLUTION, pad.x, pad.z)

    if (shouldFullRebake(lightRects, RESOLUTION)) {
      full()
    } else {
      this._bakeShape(renderer, shapeRects)
      this._bakeLightRects(renderer, lightRects)
      this._lastRects = shapeRects.length + lightRects.length
    }
    this._bakedOrigin = { ...this._origin }
  }

  /**
   * Refresh whatever is stale, then re-march the cached cloud RT. Call BEFORE
   * postprocessing.render().
   * @param {THREE.WebGLRenderer} renderer
   */
  renderClouds(renderer) {
    if (!this.pass.enabled || !this._cloudRT) return
    this._ensureVolumes(renderer)
    if (this._supported === false) return

    // Nothing is moving and nothing is owed: every stage below would re-derive
    // the image already in _cloudRT, so keep it (the march alone is ~14 ms of a
    // ~46 ms frame during a reveal). Owed work stays owed and resumes when the
    // world moves; the whole method pauses together so a half-relit volume is
    // never marched.
    if (this._sceneStatic && !this._marchDirty && !this._shapeDirty &&
        this._shapePending === 0 && this._lightPending === 0 && !this._litFading) return

    const prevTarget = renderer.getRenderTarget()

    if (this._shapeDirty) {
      this._refreshVolumes(renderer)
      this._shapeDirty = false
    }
    // A rolling re-bake (a `roll` invalidation), after the window's strips.
    // While holding still, finish the whole roll now — the frames that would
    // carry the rest are about to stop happening, and a painting must not
    // freeze a volume baked half at one frequency.
    if (this._shapePending > 0) {
      this._rollShape(renderer,
        this._sceneStatic ? this._shapePending : this.params.get('rollLayersPerFrame'))
      this._invalidateLight()
    }
    // Amortised light refresh (a moving sun, a density or coverage retune).
    // While the world holds still the whole backlog is retired in this frame:
    // the frames that would carry the rest are about to stop happening.
    //
    // Fade first, then relight: a layer's relight leaves its shown weight
    // untouched, so the image does not change on the frame it is written.
    this._advanceFades()
    // Holding still: every layer written to both copies.
    this._bakeLightLayers(renderer, this._sceneStatic ? LAYERS : this.params.get('lightLayersPerFrame'), this._sceneStatic)
    if (this._sceneStatic) {
      this._litWeight.set(this._litTarget)
      this._litFading = false
    }
    if (this._sceneStatic) this._drawGround(renderer, 1)
    else this._refreshGroundLayer(renderer)

    renderer.setRenderTarget(this._cloudRT)
    this._marchQuad.render(renderer)
    this._marchDirty = false

    renderer.setRenderTarget(prevTarget)
  }

  /**
   * main.js's `worldHolding`: frozen or paused, camera still, no control
   * touched. While it is true and nothing is owed, `renderClouds` skips every
   * stage and keeps the cached cloud target. It never forces a skip: work that
   * is already flagged (a dirty shape, pending layers, a requested march)
   * still runs, and while it is true that work finishes in one frame.
   */
  setSceneStatic(isStatic) { this._sceneStatic = !!isStatic }

  /** Every uniform table the snapshot sweep and the key accessor cover — kept in one place. */
  _uniformTables() {
    return [
      this._bakeMaterial.uniforms, this._lightMaterial.uniforms,
      this._marchMaterial.uniforms, this._compositeMaterial.uniforms,
      // uCloudSpeed and uWeatherSpeed live ONLY here, on no ShaderMaterial,
      // so they would be silently missed without this table.
      this._jsUniforms,
    ]
  }

  /**
   * Serialize for a scene snapshot (sceneSnapshot.js): { format, params,
   * integrated }. `params` is every row by key (the switch, the per-frame
   * budgets and the JS-only speeds among them); `integrated`
   * the scrolling state by name: the window origin, the frequency anchor and
   * phases, the wind and weather offsets. The grid-derived uniforms (cell size,
   * octave counts, detail frequency and amplitude) are not captured: the
   * restore's _recomputeGrid() derives them from the restored rows.
   */
  exportState() {
    return {
      format: STATE_FORMAT,
      params: this.params.export(),
      integrated: captureUniforms(this._uniformTables(), namesOfClass(UNIFORM_CLASSES, 'integrated')),
    }
  }

  /**
   * Restore exportState(). Returns { unknown, rejected }.
   */
  importState(state) {
    if (state.format !== STATE_FORMAT) return { unknown: [`clouds.format ${state.format}`], rejected: [] }
    // Rows first (they re-derive and invalidate), then the integrated state
    // over whatever those wrote.
    const rows = this.params.import(state.params || {})
    const integrated = applyUniforms(this._uniformTables(), state.integrated || {})
    this._settleRestore()
    return {
      unknown: [...rows.unknown, ...integrated.unknown],
      rejected: [...rows.rejected, ...integrated.rejected],
    }
  }

  /**
   * The clock the restored wind offsets were computed from (offset = wind
   * vector × time, windOffset). Read back off the field's wind, or off the
   * weather map's when the field's speed is 0; with both at 0 every offset is
   * 0 whatever the clock, so it is kept. A snapshot taken after a speed was
   * changed while paused holds offsets from the old speed, so the clouds move
   * once on the first frame after its restore.
   */
  _restoredTime() {
    const js = this._jsUniforms
    const u = this._marchMaterial.uniforms
    const fromWind = (speed, offset) => offset.x / windVector(speed).x
    if (js.uCloudSpeed.value !== 0) return fromWind(js.uCloudSpeed.value, u.uWindOffset.value)
    if (js.uWeatherSpeed.value !== 0) return fromWind(js.uWeatherSpeed.value, u.uWeatherOffset.value)
    return this._time
  }

  /**
   * After a restore: sync the JS-side copies of what was written straight into
   * a uniform, and force a full shape+light rebake — the restored grid/shape
   * parameters mean whatever the volume currently holds no longer matches
   * them, and there is no cheaper incremental path FROM an arbitrary prior
   * state.
   */
  _settleRestore() {
    // The integrated state wrote the window origin straight into the shared
    // uOriginCell Vector2 (by reference): sync the JS-side tracking copy too,
    // or the next update() sees them disagree and reanchors once for no reason
    // before settling (harmless, but avoidable).
    this._origin = { x: this._shared.uOriginCell.value.x, z: this._shared.uOriginCell.value.y }
    this._time = this._restoredTime()
    // Roll bookkeeping is derived from the bake, never restored: the full
    // re-bake forced below re-records it.
    this._shapePending = 0
    this._layerBaseFreq.fill(NaN)
    this._layerWorleyFreq.fill(NaN)
    // The eased values land on their restored rows.
    this._shared.uCoverage.value = this.params.get('coverage')
    this._bakeMaterial.uniforms.uBaseFreq.value = this.params.get('baseFreq')
    // A row that did not change reallocated nothing: size the cloud target for
    // what was restored.
    this._allocateCloudRT()
    // Re-derive everything from the just-restored drawDistance/baseFreq/lacunarity/
    // gain/marchStepSize.
    this._recomputeGrid()
    this._shapeDirty = true
    this._bakedOrigin = null
    this._biasBaked = null
    this._groundValid = false
    this._invalidateLight()
  }

  rebuildShaders() {
    this._bakeMaterial.fragmentShader  = composeBake()
    this._lightMaterial.fragmentShader = composeLight()
    this._marchMaterial.fragmentShader = composeVolume()
    this._compositeMaterial.fragmentShader = composeComposite()
    this._bakeMaterial.needsUpdate  = true
    this._lightMaterial.needsUpdate = true
    this._marchMaterial.needsUpdate = true
    this._compositeMaterial.needsUpdate = true
    this._shapeDirty = true
    this._invalidateLight()
  }
}

// ─── Dev-only shader hot-reload ─────────────────────────────────────────────
// Same pattern as terrain.js/water.js: swap the changed source, then rebuild
// the materials in place through window.__d.clouds.
if (import.meta.hot) {
  import.meta.hot.accept(
    [
      '../shared/shaders/noise.glsl?raw',
      './shaders/includes/cloudCommon.glsl?raw',
      './shaders/includes/cloudShade.glsl?raw',
      './shaders/cloudVolumeBake.frag?raw',
      './shaders/cloudVolumeLight.frag?raw',
      './shaders/cloudsVolume.frag?raw',
    ],
    ([n, cc, cs, b, l, v]) => {
      if (n)  SRC.noise  = n.default
      if (cc) SRC.common = cc.default
      if (cs) SRC.shade  = cs.default
      if (b)  SRC.bake   = b.default
      if (l)  SRC.light  = l.default
      if (v)  SRC.volume = v.default
      // eslint-disable-next-line no-undef
      const c = (typeof window !== 'undefined') && window.__d && window.__d.clouds
      if (c) c.rebuildShaders()
    },
  )
}
