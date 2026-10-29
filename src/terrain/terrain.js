/**
 * terrain.js — the terrain: mesh, materials, the per-frame data-map passes and
 * the param accessor over their uniforms.
 *
 * MESH       one adaptive plane (dense near the camera), displaced in terrain.vert
 *            from the data map; normals come from the derive pass.
 * PASSES     renderDataMap(), once per frame before the scene render:
 *              heightmap.frag → _dataMapRT   height · ridge · erosion · bedrock select
 *              derive.frag    → _deriveRT    gradient · two ring means
 *              terrain.frag (FOREST_SITE_PASS) → forest site table, forest on only
 * MATERIALS  _material (what is drawn), _depthMaterial (same vertex shader, empty
 *            fragment, swapped in for water's depth pre-pass), _heightmapMaterial,
 *            _deriveMaterial, _forestSiteMaterial. Their uniform objects are
 *            SHARED BY REFERENCE, so a tick or slider write reaches every pass;
 *            nothing here replaces a uniform object, only its `.value`.
 * ANIMATION  TerrainDriver (terrainDriver.js) advances time, drift and the derived
 *            uHeightMax / uMantleDC on the dynamics tick; this class only draws.
 * PARAMS     `terrain.params` (shared/paramAccess.js): every terrainParams.js
 *            row by key, over all three data materials. Fields: the driver's
 *            settings, the mantle octaves (two uniforms), the segment count.
 *            Derived: uSunAzimuth, from the held compass angle.
 * SCENE      fog, light level and the cloud-shadow lookup are the scene-wide
 *            objects of shared/sceneUniforms.js, mounted into the material and
 *            shared with water. This class only reads them; their writers are
 *            the scene set's own `set` and its per-frame shadow frame.
 * SNAPSHOT   exportState/importState: the rows by key (params.export, the
 *            segment count and the driver's settings among them), the
 *            integrated uniforms by name, the drift headings and the scene
 *            set's authored values. Every uniform is classified in
 *            terrainParams.js; the restore recomputes the derived ones. A state
 *            whose `format` is not 2 is rejected.
 * DEV        shader HMR (bottom of file) recomposes the sources via rebuildShaders().
 */

import * as THREE from 'three'
import noiseGlsl    from '../shared/shaders/noise.glsl?raw'
import fbmGlsl      from './shaders/includes/fbm.glsl?raw'
import erosionGlsl  from './shaders/includes/erosion.glsl?raw'
import materialGlsl from './shaders/includes/material.glsl?raw'
import forestGlsl   from './shaders/includes/forest.glsl?raw'
import dataMapSampleGlsl from './shaders/includes/dataMapSample.glsl?raw'
import terrainVert  from './shaders/terrain.vert?raw'
import terrainFrag  from './shaders/terrain.frag?raw'
import heightmapVert from './shaders/heightmap.vert?raw'
import heightmapFrag from './shaders/heightmap.frag?raw'
import deriveFrag    from './shaders/derive.frag?raw'
import {
  TerrainDriver, DRIVER_SETTINGS, driverDefaults,
  DRIFT_INITIAL_ANGLE_0, DRIFT_INITIAL_ANGLE_1,
} from './terrainDriver.js'
import { inject } from '../shared/shaderCompose.js'
import { H_NORM_PER_AMP } from './terrainMath.js'
import {
  applyUniforms, captureUniforms, namesOfClass, STATE_FORMAT,
} from '../shared/uniformSerialize.js'
import { createAdaptivePlane } from './terrainGeometry.js'
import { forestUniforms } from './terrainUniforms.js'
import { TERRAIN_PARAMS, UNIFORM_CLASSES } from './terrainParams.js'
import { uniformsFor, rowDefaults } from '../shared/paramSchema.js'
import { forestSiteWindow, forestSiteTableSide } from './forestSites.js'
import { paramAccess, objectFields } from '../shared/paramAccess.js'
import { PLANE_SIZE, CAM_POSITION } from '../shared/sceneConfig.js'

// Shader sources are mutable and module-level so the dev HMR block at the bottom
// can swap them and rebuild the live materials in place (?raw shaders are baked
// into a ShaderMaterial at construction). The marker comments below are where
// the includes are spliced in.
const SRC = {
  noise: noiseGlsl, fbm: fbmGlsl, erosion: erosionGlsl, material: materialGlsl,
  forest: forestGlsl, dataSample: dataMapSampleGlsl,
  tvert: terrainVert, tfrag: terrainFrag, hmvert: heightmapVert, hmfrag: heightmapFrag,
  dfrag: deriveFrag,
}
const composeTerrainVert = () => inject(SRC.tvert, [
  ['// dataMapSample.glsl injected here by terrain.js at shader compile time', SRC.dataSample],
])
const composeTerrainFrag = () => inject(SRC.tfrag, [
  ['// noise.glsl injected by terrain.js', SRC.noise],
  ['// material.glsl injected by terrain.js', SRC.material],
  ['// forest.glsl injected by terrain.js', SRC.forest],
])
const composeHeightmapFrag = () => inject(SRC.hmfrag, [
  ['// H_NORM_PER_AMP defined by terrain.js', `const float H_NORM_PER_AMP = ${H_NORM_PER_AMP.toFixed(3)};`],
  ['// noise.glsl injected by terrain.js', SRC.noise],
  ['// fbm.glsl injected by terrain.js', SRC.fbm],
  ['// erosion.glsl injected by terrain.js', SRC.erosion],
])
const composeDeriveFrag = () => inject(SRC.dfrag, [
  ['// dataMapSample.glsl injected by terrain.js', SRC.dataSample],
])

// Every row's default, by key (the uniforms a row does not seed itself, e.g.
// the two octave uniforms of the `mantleOctaves` field, take theirs from here).
const DEFAULT = rowDefaults(TERRAIN_PARAMS)
// Which table a row's uniform lives in: the heightmap pass owns the erosion
// filter and the camera pit; every other row-backed uniform is the material's
// (the heightmap pass reads some of those by reference, see sharedKeys).
const inHeightmap = r => /^u(Erosion|CamPit)/.test(r.uniform)
// How uniformsFor builds a colour row's value: a colour-managed THREE.Color.
const MAKE = { srgb: hex => new THREE.Color(hex) }

// The horizontal length of the sun direction (its shipped (x, z) is
// (0.58495…, −0.26044) at 336°). Rotating the sun keeps it, so the compass
// slider is not also a brightness knob; a snapshot restore re-reads it.
const SUN_AZIMUTH_RADIUS = 0.6403124237432848

// The scene-wide uniforms the terrain reads but never writes (shared/
// sceneUniforms.js): fog, light level and the cloud-shadow lookup. Water reads
// the same objects, so the shoreline cannot seam.
const SCENE_NAMES = [
  'uFogColor', 'uFogNear', 'uFogFar', 'uFogCurve', 'uFogMaxAlpha', 'uLightLevel',
  'uCloudGround', 'uCloudShadowAmt', 'uCloudShadowAbs', 'uCloudShadowFloor', 'uCloudShadowTiers',
  'uCloudLevel', 'uCloudHeight', 'uCloudExtent', 'uCloudWind',
]

// The drift's initial velocities: the driver's initial angles (terrainDriver.js)
// at the base-speed rows' defaults.
const DRIVER = driverDefaults()
const initialDrift = (angle, speed) => [Math.cos(angle) * speed, Math.sin(angle) * speed]
const DRIFT0 = initialDrift(DRIFT_INITIAL_ANGLE_0, DRIVER.baseSpeed0)
const DRIFT1 = initialDrift(DRIFT_INITIAL_ANGLE_1, DRIVER.baseSpeed1)

// Data-map resolution: one float RT covers the whole plane (uv = xz/PLANE_SIZE
// + 0.5), and the vertex shader reads it instead of re-running the fBM per
// vertex, so 512² trades normal/detail sharpness for frame time.
const TERRAIN_MAP_SIZE    = 512

export class Terrain {
  /**
   * @param {import('../dynamics/dynamics.js').Dynamics} dynamics
   * @param {import('../shared/sceneUniforms.js').SceneUniforms} sceneUniforms
   *   the scene-wide set (main.js creates it; a test makes its own)
   */
  constructor(dynamics, sceneUniforms) {
    this._scene = sceneUniforms
    this._segsAdaptive = DEFAULT.segments

    // Adaptive grid — denser near the camera.
    this._adaptiveGeometry = createAdaptivePlane(PLANE_SIZE, this._segsAdaptive)

    // Splice the includes in at the marker comments (composed from the mutable
    // SRC bindings so rebuildShaders() can recompose on HMR).
    const vert = composeTerrainVert()
    const frag = composeTerrainFrag()

    this._material = new THREE.ShaderMaterial({
      vertexShader:   vert,
      fragmentShader: frag,
      uniforms: {
        uTime:      { value: 0.0 },
        // Fog, light level and cloud shadows: the scene-wide objects.
        ...sceneUniforms.mount(SCENE_NAMES),
        // The row-backed uniforms (terrainParams.js), seeded from the rows; the
        // heightmap pass reads some of them by reference. The palette rows'
        // values are palette.js's, which main.js writes before the first frame.
        ...uniformsFor(TERRAIN_PARAMS, r => !inHeightmap(r), MAKE),
        // Horizontal sun direction (x, z): derived from the `sunAzimuth` row by
        // this.params (below), never written directly.
        uSunAzimuth:     { value: new THREE.Vector2() },
        // Biome zonation
        uSnowAspect:     { value: 0.10 },
        uSnowHollow:     { value: 0.15 },
        uTreeTongue:     { value: 0.12 },
        // The forest's fixed constants and per-species crown-form/colour arrays
        // (terrainUniforms.js) — see includes/forest.glsl.
        ...forestUniforms(),
        // Populated height range — recomputed each tick from amps + erosion margin
        uHeightMax:        { value: 55.0 },
        // Data maps
        uDataMap:          { value: null },  // set below once the RT exists
        uDeriveMap:        { value: null },  // RT_B (derive.frag) — set below
        // Forest site table (forest.glsl) — rebuilt each data-map pass, see _renderForestSites.
        // The origin is derived from the drift every frame, never authored.
        uForestSites:      { value: null },
        uForestSiteOrigin: { value: new THREE.Vector2(0, 0) },
        uPlaneSize:        { value: PLANE_SIZE },
        uDataMapTexel:     { value: 1 / TERRAIN_MAP_SIZE },   // 1 / map resolution (derive pass)
        // Bedrock/mantle two-field placement (see fbm.glsl): the mean lift
        // max() adds, recomputed every tick (TerrainDriver)
        uMantleDC:               { value: 0.0 },
        // The fBM instances' drift (TerrainDriver writes the velocities every
        // tick and integrates the offsets) and their mantle octave count (the
        // `mantleOctaves` field writes both).
        uFBM0DriftX:      { value: DRIFT0[0] },
        uFBM0DriftZ:      { value: DRIFT0[1] },
        uFBM0DriftOffset: { value: new THREE.Vector2(0, 0) },
        uFBM0Octaves:     { value: DEFAULT.mantleOctaves },
        uFBM1DriftX:      { value: DRIFT1[0] },
        uFBM1DriftZ:      { value: DRIFT1[1] },
        uFBM1DriftOffset: { value: new THREE.Vector2(0, 0) },
        uFBM1Octaves:     { value: DEFAULT.mantleOctaves },
      },
    })

    /** @type {THREE.Mesh} */
    // Vertex normals come analytically from the derive-pass gradient (RT_B): no
    // per-triangle faceting.
    this.mesh = new THREE.Mesh(this._adaptiveGeometry, this._material)

    // Depth-only twin of _material: SAME vertex shader (so displacement is
    // pixel-identical — water's depth read must see the real mountain, not a
    // flat plane) and uniforms (shared by reference — drift/tick updates reach
    // both with no separate bookkeeping), but a one-line fragment shader.
    // water.depthPrePass only reads the hardware depth buffer (uDepthTexture
    // is a THREE.DepthTexture; the colour output is never sampled by
    // anything), so the full forest/biome/lighting fragment cost would be pure
    // waste — it is swapped in for that one pass only, via setDepthOnly().
    // terrain.frag never calls discard (forest is alpha-blended into colour,
    // not punched out), so every fragment this depth material writes matches
    // where the real material would too.
    this._depthMaterial = new THREE.ShaderMaterial({
      vertexShader:   vert,
      fragmentShader: 'void main() { gl_FragColor = vec4(0.0); }',
      uniforms:       this._material.uniforms,
    })

    // ── Data-map pass ────────────────────────────────────────────────────────
    // A fullscreen quad renders the height function into a float RT each frame;
    // the terrain vertex shader displaces from it. The heightmap material
    // SHARES the fBM uniform objects with the terrain material, so every tick
    // update reaches both passes.
    this._dataMapRT = new THREE.WebGLRenderTarget(TERRAIN_MAP_SIZE, TERRAIN_MAP_SIZE, {
      type:        THREE.FloatType,   // downgraded to HalfFloat in init() if float-linear unsupported
      format:      THREE.RGBAFormat,
      minFilter:   THREE.LinearFilter,
      magFilter:   THREE.LinearFilter,
      wrapS:       THREE.ClampToEdgeWrapping,
      wrapT:       THREE.ClampToEdgeWrapping,
      depthBuffer: false,
      stencilBuffer: false,
    })
    this._material.uniforms.uDataMap.value = this._dataMapRT.texture

    const sharedKeys = [
      'uTime', 'uPlaneSize',
      'uEnableBaseFBM', 'uEnableTimeAxis', 'uRidgeAmt', 'uRidgeRound',
      'uBedrockOctaves', 'uMantleRelief', 'uMantleDC', 'uFieldSolo',
      'uRockRidge', 'uRockPersist', 'uRockAniso', 'uRockJointAngle',
      'uRockGateAmt', 'uRockGateLo', 'uRockGateHi',
      'uMantleBias', 'uHeightMax',
    ]
    for (const inst of ['uFBM0', 'uFBM1']) {
      for (const p of ['Freq', 'Amp', 'DriftX', 'DriftZ', 'DriftOffset', 'TimeSpeed', 'Persistence', 'Lacunarity', 'Octaves']) {
        sharedKeys.push(inst + p)
      }
    }
    const heightmapUniforms = {
      // The erosion filter (heightmap.frag, erosion.glsl) and the camera pit:
      // terrainParams.js's rows.
      ...uniformsFor(TERRAIN_PARAMS, inHeightmap),
      // Camera-safety pit (heightmap.frag applyCamPit) — fixed authored point,
      // never the live debug fly-cam (see sceneConfig.js CAM_POSITION).
      uCamXZ:              { value: new THREE.Vector2(CAM_POSITION.x, CAM_POSITION.z) },
    }
    for (const k of sharedKeys) heightmapUniforms[k] = this._material.uniforms[k]

    const hmFrag = composeHeightmapFrag()
    this._heightmapMaterial = new THREE.ShaderMaterial({
      vertexShader:   SRC.hmvert,
      fragmentShader: hmFrag,
      uniforms:       heightmapUniforms,
      depthTest:      false,
      depthWrite:     false,
    })
    this._heightmapScene  = new THREE.Scene()
    this._heightmapScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this._heightmapMaterial))
    this._heightmapCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
    this._renderer = null

    // ── Derive pass ──────────────────────────────────────────────────────────
    // A second fullscreen quad reads the finished height map and bakes the
    // view-INDEPENDENT per-point signals (surface gradient + two ring means)
    // once at map resolution, so every consumer needs one texture fetch
    // instead of ~21 taps. uHollowRadius/uCreaseRadius are SHARED BY
    // REFERENCE from the terrain material so the Biome-panel radius sliders
    // reach this pass too.
    this._deriveRT = new THREE.WebGLRenderTarget(TERRAIN_MAP_SIZE, TERRAIN_MAP_SIZE, {
      type:        THREE.FloatType,   // downgraded to HalfFloat in init() to match uDataMap
      format:      THREE.RGBAFormat,
      minFilter:   THREE.LinearFilter,
      magFilter:   THREE.LinearFilter,
      wrapS:       THREE.ClampToEdgeWrapping,
      wrapT:       THREE.ClampToEdgeWrapping,
      depthBuffer: false,
      stencilBuffer: false,
    })
    this._material.uniforms.uDeriveMap.value = this._deriveRT.texture

    this._deriveMaterial = new THREE.ShaderMaterial({
      vertexShader:   SRC.hmvert,
      fragmentShader: composeDeriveFrag(),
      // All shared by reference: slider changes reach both passes, and the
      // fixture's repoint of uDataMap (setFixtureHeightfield) is one write.
      uniforms: {
        uDataMap:      this._material.uniforms.uDataMap,
        uPlaneSize:    this._material.uniforms.uPlaneSize,
        uDataMapTexel: this._material.uniforms.uDataMapTexel,
        uHollowRadius: this._material.uniforms.uHollowRadius,
        uCreaseRadius: this._material.uniforms.uCreaseRadius,
      },
      depthTest:  false,
      depthWrite: false,
    })
    this._deriveScene = new THREE.Scene()
    this._deriveScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this._deriveMaterial))

    // ── Forest site table ────────────────────────────────────────────────────
    // Each tree's root verdict (exists? species? ground gradient) depends on its
    // lattice site alone, so it is computed once per site here, after the
    // derive pass it reads, instead of by every terrain fragment for each of the
    // ~11 crown candidates it checks — see forest.glsl's forestSite. The SAME
    // terrain.frag, compiled with FOREST_SITE_PASS, so the classify logic and
    // its uniforms exist exactly once; uniforms shared by reference, like the
    // depth material's.
    this._forestSitesRT = null   // sized to the lattice window on first use
    this._forestSiteMaterial = new THREE.ShaderMaterial({
      vertexShader:   SRC.hmvert,
      fragmentShader: frag,
      defines:        { FOREST_SITE_PASS: '' },
      uniforms:       this._material.uniforms,
      depthTest:      false,
      depthWrite:     false,
    })
    this._forestSiteScene = new THREE.Scene()
    this._forestSiteScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this._forestSiteMaterial))

    // Signal-test fixture state (see setFixtureHeightfield) — never set in production
    this._fixtureActive  = false
    this._fixtureTexture = null

    // Per-frame shape/drift animation lives in a private driver. It writes
    // `.value` on the shared fBM/drift uniform objects by reference, so the
    // heightmap and derive passes see the same objects.
    this._driver = new TerrainDriver(
      dynamics,
      this._material.uniforms,
      this._heightmapMaterial.uniforms,
    )

    // The radius uSunAzimuth is derived at (see SUN_AZIMUTH_RADIUS);
    // importState re-reads it from a restored vector.
    this._sunAzimuthRadius = SUN_AZIMUTH_RADIUS

    // The one accessor over every terrain value: the rows of terrainParams.js,
    // over all three data materials (built here, after they and the driver
    // exist). Callers read and write through it: `terrain.params.set(key, v)`.
    const u = this._material.uniforms
    this.params = paramAccess({
      tables: this._uniformTables(),
      rows:   TERRAIN_PARAMS,
      fields: {
        ...objectFields(this._driver.settings, DRIVER_SETTINGS),
        // One count for both fBM instances' mantle octaves.
        mantleOctaves: {
          get: () => u.uFBM0Octaves.value,
          set: n => { u.uFBM0Octaves.value = n; u.uFBM1Octaves.value = n },
        },
        segments: { get: () => this._segsAdaptive, set: n => this.setSegments(n) },
      },
      derived: [{
        // The compass angle, in degrees, at the held radius.
        uniform: 'uSunAzimuth', from: ['sunAzimuth'],
        fn: read => {
          const a = read('sunAzimuth') * Math.PI / 180
          const r = this._sunAzimuthRadius
          return { x: r * Math.cos(a), y: r * Math.sin(a) }
        },
      }],
    })
  }

  // ─── readouts ──────────────────────────────────────────────────────────────

  /** Current drift angle of one fBM instance, radians — for debug display. */
  getDriftAngle(instance) { return this._driver.getDriftAngle(instance) }
  /** Current drift velocity { x, z } of one fBM instance (the driver's output)
   *  — for debug display. */
  getDriftVelocity(instance) {
    const u = this._material.uniforms
    return { x: u[`uFBM${instance}DriftX`].value, z: u[`uFBM${instance}DriftZ`].value }
  }
  /** Live uSunAzimuth (x, z), derived from the `sunAzimuth` param — main.js
   *  reads it each frame to keep the cloud system's sun direction agreeing. */
  getSunAzimuth() { return this._material.uniforms.uSunAzimuth.value }

  // ─── geometry and the signal-test fixture ──────────────────────────────────

  /** Rebuild the adaptive geometry with a new segment count, disposing the old
   *  one. The `segments` param writes through here. */
  setSegments(n) {
    this._segsAdaptive = n
    const old = this._adaptiveGeometry
    const geo = createAdaptivePlane(PLANE_SIZE, n)
    this._adaptiveGeometry = geo
    this.mesh.geometry     = geo
    old.dispose()
  }

  /**
   * Signal-test fixture: replace the live fBM+erosion height map with an
   * analytic surface fn(x,z) so signals can be checked against known ground
   * truth. Builds a float DataTexture matching the data-map RT exactly and
   * repoints uDataMap at it (one object, read by the terrain and derive
   * materials both); the derive
   * pass still runs each frame (RT_B gradient/ring-means recomputed FROM the
   * fixture), so the real vertex normal / concavity path is exercised. Pass
   * null to restore the live pipeline. Test-only; never called in production.
   * @param {((x:number,z:number)=>number)|null} fn  world height, or null to restore
   */
  setFixtureHeightfield(fn) {
    if (fn == null) {
      if (this._fixtureTexture) { this._fixtureTexture.dispose(); this._fixtureTexture = null }
      this._fixtureActive = false
      this._material.uniforms.uDataMap.value = this._dataMapRT.texture
      return
    }
    const N = TERRAIN_MAP_SIZE
    const data = new Float32Array(N * N * 4)
    // Same world<->uv mapping the passes use: uv = xz/size + 0.5, texel centre.
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const u = (i + 0.5) / N, v = (j + 0.5) / N
        const x = (u - 0.5) * PLANE_SIZE, z = (v - 0.5) * PLANE_SIZE
        const o = (j * N + i) * 4
        data[o] = fn(x, z)   // R = height; G/B/A = 0 (ridge/erosion/bedrock select unread by tested signals)
      }
    }
    const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.FloatType)
    tex.minFilter = THREE.LinearFilter
    tex.magFilter = THREE.LinearFilter
    tex.wrapS = THREE.ClampToEdgeWrapping
    tex.wrapT = THREE.ClampToEdgeWrapping
    tex.needsUpdate = true
    if (this._fixtureTexture) this._fixtureTexture.dispose()
    this._fixtureTexture = tex
    this._fixtureActive = true
    this._material.uniforms.uDataMap.value = tex
  }

  // ─── snapshot ──────────────────────────────────────────────────────────────

  /**
   * The terrain's state for a scene snapshot (sceneSnapshot.js): its rows by key
   * (`params`, the segment count and the driver's settings among them), the
   * integrated uniforms by name, the drift headings, and the scene set's
   * authored values (fog, light level, cloud shadow), which ride in this entry.
   * Derived, frame and constant uniforms are not captured (terrainParams.js).
   */
  exportState() {
    return {
      format: STATE_FORMAT,
      params: this.params.export(),
      integrated: captureUniforms(this._uniformTables(), namesOfClass(UNIFORM_CLASSES, 'integrated')),
      driver: this._driver.exportState(),
      scene: this._scene.exportState(),
    }
  }

  /**
   * Restore exportState(). Returns { unknown, rejected } for the caller to warn on.
   */
  importState(state) {
    if (state.format !== STATE_FORMAT) return { unknown: [`terrain.format ${state.format}`], rejected: [] }
    // Rows first (they fire the derived and invalidation steps), then the
    // integrated uniforms over whatever those wrote.
    const report = this.params.import(state.params || {})
    const integrated = applyUniforms(this._uniformTables(), state.integrated || {})
    if (state.scene) this._scene.importState(state.scene)
    if (state.driver) this._driver.importState(state.driver)
    this._driver.applyRange()
    return {
      unknown: [...report.unknown, ...integrated.unknown],
      rejected: [...report.rejected, ...integrated.rejected],
    }
  }

  /**
   * Swap the mesh to the depth-only material (see its construction comment)
   * for the duration of water's depthPrePass, and back to the real material
   * after. Swapping the mesh's material here, not scene.overrideMaterial in
   * main.js, keeps the swap local to the one mesh it is actually safe for, so
   * it can't silently mis-render some future scene object with different
   * displacement needs.
   */
  setDepthOnly(on) { this.mesh.material = on ? this._depthMaterial : this._material }

  // ─── lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Stores the renderer for the data-map pass. Downgrades the RTs to half
   * float when linear filtering of full-float textures is unsupported.
   * @param {THREE.WebGLRenderer} renderer
   * @returns {Promise<void>}
   */
  async init(renderer) {
    this._renderer = renderer
    if (!renderer.extensions.has('OES_texture_float_linear')) {
      this._dataMapRT.texture.type = THREE.HalfFloatType
      this._deriveRT.texture.type  = THREE.HalfFloatType
    }
    return Promise.resolve()
  }

  /**
   * Render the terrain data maps (height/ridge/erosion/bedrock select, then the
   * derived gradient + ring means, then the forest site table). Called by
   * main.js once per frame, before the scene render. Saves and restores the
   * active render target per module rules.
   */
  renderDataMap() {
    if (!this._renderer) return
    const prev = this._renderer.getRenderTarget()
    // Phase 1: height map (fBM + erosion). Phase 2: derive gradient + ring
    // means from the finished map — must run after, samples RT_A's neighbours.
    // Under a signal-test fixture, phase 1 is skipped (uDataMap points at the
    // fixture texture), but phase 2 STILL runs so RT_B is recomputed from it.
    if (!this._fixtureActive) {
      this._renderer.setRenderTarget(this._dataMapRT)
      this._renderer.render(this._heightmapScene, this._heightmapCamera)
    }
    this._renderer.setRenderTarget(this._deriveRT)
    this._renderer.render(this._deriveScene, this._heightmapCamera)
    // Phase 3: the forest's per-site verdicts, from the finished maps.
    if (this._material.uniforms.uForestOn.value >= 0.5) this._renderForestSites()
    this._renderer.setRenderTarget(prev)
  }

  /**
   * Recompose every material's shader source from the current SRC bindings and
   * flag them for recompile, keeping the existing uniform objects (so all
   * slider/tick state is preserved). Called by the dev HMR block on a shader
   * edit. A GLSL compile error just logs to the console; the old program keeps
   * running until the next successful edit.
   */
  rebuildShaders() {
    this._material.vertexShader   = composeTerrainVert()
    this._material.fragmentShader = composeTerrainFrag()
    this._material.needsUpdate    = true
    this._depthMaterial.vertexShader = this._material.vertexShader
    this._depthMaterial.needsUpdate  = true
    this._forestSiteMaterial.fragmentShader = this._material.fragmentShader
    this._forestSiteMaterial.needsUpdate    = true
    this._heightmapMaterial.vertexShader   = SRC.hmvert
    this._heightmapMaterial.fragmentShader = composeHeightmapFrag()
    this._heightmapMaterial.needsUpdate    = true
    this._deriveMaterial.vertexShader   = SRC.hmvert
    this._deriveMaterial.fragmentShader = composeDeriveFrag()
    this._deriveMaterial.needsUpdate    = true
  }

  // ─── private ───────────────────────────────────────────────────────────────

  // The uniform tables that shape the rendered terrain: the material, the
  // heightmap data-map pass (owns the erosion uniforms), and the derive pass.
  // Snapshots and the key accessor MUST cover all three (the heightmap/derive
  // uniforms exist on neither the material); shared-by-reference names are
  // captured once.
  _uniformTables() {
    return [
      this._material.uniforms,
      this._heightmapMaterial.uniforms,
      this._deriveMaterial.uniforms,
    ]
  }

  /**
   * Rebuild the forest site table for this frame's lattice window (which moves
   * with the drift and scales with the cell size), reallocating it only when
   * the window outgrows it — see forestSites.js.
   */
  _renderForestSites() {
    const u = this._material.uniforms
    const { origin, size } = forestSiteWindow(PLANE_SIZE, u.uForestCell.value, u.uFBM0DriftOffset.value)
    const side = forestSiteTableSide(size, this._forestSitesRT ? this._forestSitesRT.width : 0)
    if (!this._forestSitesRT || this._forestSitesRT.width !== side) {
      if (this._forestSitesRT) this._forestSitesRT.dispose()
      // Full float, nearest, read with texelFetch: existence and the gradient
      // must reach the crowns unrounded, and a site is never interpolated.
      this._forestSitesRT = new THREE.WebGLRenderTarget(side, side, {
        type:        THREE.FloatType,
        format:      THREE.RGBAFormat,
        minFilter:   THREE.NearestFilter,
        magFilter:   THREE.NearestFilter,
        depthBuffer: false,
        stencilBuffer: false,
      })
      u.uForestSites.value = this._forestSitesRT.texture
    }
    u.uForestSiteOrigin.value.set(origin[0], origin[1])
    this._renderer.setRenderTarget(this._forestSitesRT)
    this._renderer.render(this._forestSiteScene, this._heightmapCamera)
  }
}

// ─── Dev-only shader hot-reload ───────────────────────────────────────────────
// Accept the shader modules here, refresh the SRC bindings, and rebuild the
// live material in place — uniforms (all slider/tick state) are preserved.
// Stripped from production builds.
if (import.meta.hot) {
  import.meta.hot.accept(
    [
      '../shared/shaders/noise.glsl?raw',
      './shaders/includes/fbm.glsl?raw',
      './shaders/includes/erosion.glsl?raw',
      './shaders/includes/material.glsl?raw',
      './shaders/includes/forest.glsl?raw',
      './shaders/includes/dataMapSample.glsl?raw',
      './shaders/terrain.vert?raw',
      './shaders/terrain.frag?raw',
      './shaders/heightmap.vert?raw',
      './shaders/heightmap.frag?raw',
      './shaders/derive.frag?raw',
    ],
    ([n, f, e, m, cp, ds, tv, tf, hv, hf, df]) => {
      if (n)  SRC.noise      = n.default
      if (f)  SRC.fbm        = f.default
      if (e)  SRC.erosion    = e.default
      if (m)  SRC.material   = m.default
      if (cp) SRC.forest     = cp.default
      if (ds) SRC.dataSample = ds.default
      if (tv) SRC.tvert      = tv.default
      if (tf) SRC.tfrag      = tf.default
      if (hv) SRC.hmvert     = hv.default
      if (hf) SRC.hmfrag     = hf.default
      if (df) SRC.dfrag      = df.default
      // eslint-disable-next-line no-undef
      const d = (typeof window !== 'undefined') && window.__d
      if (d && d.terrain) d.terrain.rebuildShaders()
      // A rebuilt material changes nothing on screen by itself: the data-map
      // pass that feeds it is skipped while the world is holding still, and a
      // frozen landscape under a painting is exactly when shaders get edited.
      if (d && d.markDirty) d.markDirty()
    },
  )
}
