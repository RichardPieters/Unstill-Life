/**
 * water.js — the reflective water plane: mesh, material and its two GPU
 * pre-passes. The sea level, ripple clock and foam/sparkle reactions are
 * animated by a private WaterDriver (waterDriver.js).
 *
 * PARAMS   `water.params` (shared/paramAccess.js): every waterParams.js row by
 *          key. Fields: the driver's settings (sea band, foam / sparkle / depth
 *          bases), the mirror resolution, the art-data switch, visibility.
 *
 * PASSES   (main.js calls both each frame, skipped while the world holds still)
 *   Both re-render the rest of the scene, water hidden, into a render target
 *   (RT) that water.frag samples later.
 *   depthPrePass       the real camera → depth texture. water.frag reads it for
 *                      the depth under each water pixel; clouds and godrays
 *                      reuse it (getDepthTexture()).
 *   reflectionPrePass  a camera mirrored across the sea level → colour RT at
 *                      `_reflectScale` × canvas.
 *
 * SHARED WITH TERRAIN  Fog colour/curve/range/max, light level and the cloud
 *   shadow must equal terrain's, or the shoreline shows a seam, so they are the
 *   same objects: the scene-wide set (shared/sceneUniforms.js) is mounted into
 *   the material. This class only reads them.
 *
 * INPUTS   (each frame, from main.js) terrain amp sum, wave speed;
 *          artGBuffer flips the `artData` param around its capture pass.
 * OUTPUTS  getSeaLevel() → terrain, godrays, audio · getRippleTime() → audio.
 */

import * as THREE from 'three'
import noiseGlsl from '../shared/shaders/noise.glsl?raw'
import waterVertSrc from './shaders/water.vert?raw'
import waterFragSrc from './shaders/water.frag?raw'
import { inject } from '../shared/shaderCompose.js'
import {
  applyUniforms, captureUniforms, namesOfClass, STATE_FORMAT,
} from '../shared/uniformSerialize.js'
import { WaterDriver } from './waterDriver.js'
import { WATER_PARAMS, UNIFORM_CLASSES } from './waterParams.js'
import { paramAccess, objectFields } from '../shared/paramAccess.js'
import { uniformsFor, rowDefaults } from '../shared/paramSchema.js'
import { PLANE_SIZE } from '../shared/sceneConfig.js'

// The scene-wide uniforms the water reads but never writes (shared/
// sceneUniforms.js). No uCloudHeight: water.frag's shadow lookup reads the
// ground shadow texture only.
const SCENE_NAMES = [
  'uFogColor', 'uFogNear', 'uFogFar', 'uFogCurve', 'uFogMaxAlpha', 'uLightLevel',
  'uCloudGround', 'uCloudShadowAmt', 'uCloudShadowAbs', 'uCloudShadowFloor', 'uCloudShadowTiers',
  'uCloudLevel', 'uCloudExtent', 'uCloudWind', 'uCloudSunDir',
]

// noise.glsl (the terrain fBM's simplex noise) is spliced in at a marker
// comment: the ripple layers noise detail on the sine swell, and the foam warps
// its shore-distance signal with it. Mutable SRC so the HMR block at the bottom
// can recompose the live material.
const SRC = { noise: noiseGlsl, wvert: waterVertSrc, wfrag: waterFragSrc }
const composeWaterVert = () => inject(SRC.wvert, [['// noise.glsl injected by water.js', SRC.noise]])
const composeWaterFrag = () => inject(SRC.wfrag, [['// noise.glsl injected by water.js', SRC.noise]])

// Plane size and fog range come from sceneConfig, so water and terrain share
// their extent and horizon seam by construction.
const SEGMENTS = 200

// Every row's default, by key (the uniforms a row does not seed itself).
const DEFAULT = rowDefaults(WATER_PARAMS)
// How uniformsFor builds a colour row's value: a colour-managed THREE.Color.
const MAKE = { srgb: hex => new THREE.Color(hex) }

// Water-plane normal for the reflection pass's oblique clip.
const REFLECT_UP = new THREE.Vector3(0, 1, 0)

// The clip plane sits this far below the sea level, so ripple troughs at the
// waterline don't open a sliver gap in the reflection seam.
const REFLECT_CLIP_MARGIN = 0.1

export class Water {
  // ─── state ─────────────────────────────────────────────────────────────────

  /**
   * @param {import('../dynamics/dynamics.js').Dynamics} dynamics
   * @param {import('../shared/sceneUniforms.js').SceneUniforms} sceneUniforms
   *   the scene-wide set (main.js creates it; a test makes its own)
   */
  constructor(dynamics, sceneUniforms) {
    const geo = new THREE.PlaneGeometry(PLANE_SIZE, PLANE_SIZE, SEGMENTS, SEGMENTS)
    geo.rotateX(-Math.PI / 2)

    this._material = new THREE.ShaderMaterial({
      vertexShader:   composeWaterVert(),
      fragmentShader: composeWaterFrag(),
      transparent: true,
      depthWrite:  false,   // transparent surface — don't occlude terrain in depth
      uniforms: {
        uTime:         { value: 0.0 },
        // The row-backed uniforms (waterParams.js), seeded from the rows: the
        // sliders and the palette colours (main.js writes the palette again
        // before the first frame).
        ...uniformsFor(WATER_PARAMS, undefined, MAKE),
        uRippleScale:  { value: 0.02 },
        uOpacity:      { value: 0.85 },
        // The driver rewrites these three every tick from its settings (the
        // rows' `foamShare`, `sparkleThreshold`, `deepShare`); it also writes
        // them once on construction, so the 1 is never drawn.
        uSparkleThreshold: { value: DEFAULT.sparkleThreshold },
        uFoamWidth:     { value: 1.0 },
        uDepthMax:      { value: 1.0 },
        uArtData:       { value: 0.0 },   // the `artData` field
        uDepthTexture:  { value: null },
        uResolution:    { value: new THREE.Vector2(1, 1) },
        uCameraNear:    { value: 0.1 },
        uCameraFar:     { value: 3000.0 },
        // Fog, light level and cloud shadows: the scene-wide objects terrain
        // reads too, because the two meet at the shoreline.
        ...sceneUniforms.mount(SCENE_NAMES),
        // Planar terrain reflection — see reflectionPrePass()
        uReflectionTex:     { value: null },
        uReflectionMatrix:  { value: new THREE.Matrix4() },
      },
    })

    /** @type {THREE.Mesh} */
    this.mesh = new THREE.Mesh(geo, this._material)
    this.mesh.renderOrder = 1   // draw after terrain (renderOrder 0)
    this._enabled = true
    // true: a sea-band write jumps the waterline to its target (see withSeaSnap).
    this._seaSnaps = true

    this._depthRT   = null
    this._reflectRT = null
    this._fullSize  = { w: 1, h: 1 }
    // Mirror-pass resolution (the `reflectScale` field).
    this._reflectScale = DEFAULT.reflectScale

    // Scratch reused by reflectionPrePass() every frame.
    this._reflectCamera    = new THREE.PerspectiveCamera()
    this._reflectDir       = new THREE.Vector3()
    this._reflectTarget    = new THREE.Vector3()
    this._reflectViewProj  = new THREE.Matrix4()
    this._reflectClipPlane = new THREE.Plane()
    this._reflectClipPoint = new THREE.Vector3()
    this._reflectClipV4    = new THREE.Vector4()
    this._reflectClipQ     = new THREE.Vector4()

    // Constructed last: its constructor seeds its bases from the uniform
    // defaults above and applies the initial sea level to the mesh.
    this._driver = new WaterDriver(
      dynamics,
      this._material.uniforms,
      y => { this.mesh.position.y = y },
    )

    // The one accessor over every water value: the rows of waterParams.js
    // (built last, after the driver whose settings several rows write).
    // Callers read and write through it: `water.params.set(key, v)`.
    const u = this._material.uniforms
    const band = this._driver.settings
    this.params = paramAccess({
      tables: [u],
      rows:   WATER_PARAMS,
      fields: {
        // The driver's settings: the panel sets the setting, the driver derives
        // the uniform from it every tick.
        ...objectFields(band, ['foamShare', 'sparkleThreshold', 'deepShare']),
        // The sea band. The rows' `pair` keeps seaLow <= seaHigh; a write
        // snaps the smoothed level unless withSeaSnap says otherwise.
        seaLow:  { get: () => band.seaLow,  set: v => this._writeSeaBand('seaLow', v) },
        seaHigh: { get: () => band.seaHigh, set: v => this._writeSeaBand('seaHigh', v) },
        reflectScale: {
          get: () => this._reflectScale,
          set: v => {
            this._reflectScale = v
            this._rebuildReflectRT()
          },
        },
        artData: {
          get: () => u.uArtData.value > 0,
          set: on => { u.uArtData.value = on ? 1.0 : 0.0; this._material.depthWrite = on },
        },
        enabled: {
          get: () => this._enabled,
          set: v => { this._enabled = v; this.mesh.visible = v },
        },
      },
    })
  }

  // ─── sea band ──────────────────────────────────────────────────────────────

  /**
   * The waterline eases toward a target set by the sea band, so it takes
   * seconds to arrive. Writing `seaLow` or `seaHigh` normally SNAPS it: the
   * waterline jumps to the new target at once, so a slider drag shows
   * immediately. The form walker rewrites the band every frame; snapping each
   * time would pin the waterline to the target and the easing (the slow drift)
   * would vanish. It therefore wraps its writes in `withSeaSnap(false, fn)`,
   * which turns snapping off for the duration of `fn` only.
   */
  withSeaSnap(snap, fn) {
    const before = this._seaSnaps
    this._seaSnaps = snap
    try { fn() } finally { this._seaSnaps = before }
  }

  /**
   * Snapshot (sceneSnapshot.js): the rows by key (the sea band, the foam,
   * sparkle and depth bases and the mirror resolution among them), the
   * integrated uniforms by name (the ripple clock and the last tick's foam,
   * sparkle and depth) and the driver's smoothed sea level. The scene-wide
   * uniforms are the scene set's (terrain's entry).
   */
  exportState() {
    return {
      format: STATE_FORMAT,
      params: this.params.export(),
      integrated: captureUniforms([this._material.uniforms], namesOfClass(UNIFORM_CLASSES, 'integrated')),
      driver: this._driver.exportState(),
    }
  }

  /**
   * Restore exportState(). Returns { unknown, rejected }.
   */
  importState(state) {
    if (state.format !== STATE_FORMAT) return { unknown: [`water.format ${state.format}`], rejected: [] }
    // Rows, then the integrated uniforms over what those wrote, then the
    // smoothed level (a band write above snapped it).
    const report = this.params.import(state.params || {})
    const integrated = applyUniforms([this._material.uniforms], state.integrated || {})
    if (state.driver) this._driver.importState(state.driver)
    return {
      unknown: [...report.unknown, ...integrated.unknown],
      rejected: [...report.rejected, ...integrated.rejected],
    }
  }

  // ─── per-frame inputs (pushed by main.js and artGBuffer) ───────────────────

  /** The terrain's fBM amplitude sum: foam reach and deep-colour depth scale with it. */
  setTerrainScale(ampSum) { this._driver.setTerrainScale(ampSum) }

  /** Ripple pace multiplier, animSpeed.getWaveSpeed(). */
  setAnimSpeed(v) { this._driver.setAnimSpeed(v) }

  // ─── outputs ───────────────────────────────────────────────────────────────

  /** The smoothed sea level (main.js pushes it to terrain and godrays). */
  getSeaLevel() { return this._driver.getSeaLevel() }

  /** The ripple clock (uTime); audio times the surf to it. */
  getRippleTime() { return this._driver.getRippleTime() }

  /** Depth texture of depthPrePass, reused by clouds and godrays. */
  getDepthTexture() { return this._depthRT ? this._depthRT.depthTexture : null }

  // ─── lifecycle ─────────────────────────────────────────────────────────────

  /** Resize the depth and reflection render targets to the renderer output. */
  setSize(w, h) {
    if (this._depthRT) this._depthRT.dispose()
    this._depthRT = new THREE.WebGLRenderTarget(w, h, {
      depthBuffer: true,
      depthTexture: new THREE.DepthTexture(w, h),
    })
    this._material.uniforms.uDepthTexture.value = this._depthRT.depthTexture
    this._material.uniforms.uResolution.value.set(w, h)

    // The depth RT stays full resolution (fog/foam math, never seen
    // directly); only the reflection RT follows the resolution slider.
    this._fullSize.w = w
    this._fullSize.h = h
    this._rebuildReflectRT()
  }

  /**
   * Render the scene without water into the depth RT, so water.frag can
   * measure the water depth under each fragment.
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Scene} scene
   * @param {THREE.Camera} camera
   */
  depthPrePass(renderer, scene, camera) {
    if (!this._depthRT) return
    const prevTarget = renderer.getRenderTarget()
    this.mesh.visible = false
    renderer.setRenderTarget(this._depthRT)
    renderer.render(scene, camera)
    renderer.setRenderTarget(prevTarget)
    this.mesh.visible = this._enabled
    // water.frag needs near/far to turn depth values back into distances.
    this._material.uniforms.uCameraNear.value = camera.near
    this._material.uniforms.uCameraFar.value  = camera.far
  }

  /**
   * Render the scene without water from a camera mirrored across the current
   * sea level into the reflection RT: the real terrain and sky reflected, not
   * a flat sky tint.
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Scene} scene
   * @param {THREE.Camera} camera
   */
  reflectionPrePass(renderer, scene, camera) {
    if (!this._reflectRT) return
    const mirrorY = this._driver.getSeaLevel()
    const cam = this._placeMirrorCamera(camera, mirrorY)
    this._clipNearPlaneToWater(cam, mirrorY)

    const prevTarget = renderer.getRenderTarget()
    this.mesh.visible = false
    renderer.setRenderTarget(this._reflectRT)
    renderer.render(scene, cam)
    renderer.setRenderTarget(prevTarget)
    this.mesh.visible = this._enabled

    // For the shader: projecting a water pixel through this matrix gives its
    // UV in the reflection RT.
    this._reflectViewProj.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse)
    this._material.uniforms.uReflectionMatrix.value.copy(this._reflectViewProj)
  }

  /**
   * Recompose the shader source from SRC and flag the material for recompile,
   * keeping the uniform objects (all slider and tick state). Called by the
   * HMR block on a shader edit.
   */
  rebuildShaders() {
    this._material.vertexShader   = composeWaterVert()
    this._material.fragmentShader = composeWaterFrag()
    this._material.needsUpdate    = true
  }

  // ─── private ───────────────────────────────────────────────────────────────

  /** One end of the sea band, written (and the level snapped) by the field setters. */
  _writeSeaBand(key, v) {
    this._driver.settings[key] = v
    if (this._seaSnaps) this._driver.snapSeaLevel()
  }

  /** (Re)build the reflection RT at `_reflectScale` × the full canvas size. */
  _rebuildReflectRT() {
    if (this._reflectRT) this._reflectRT.dispose()
    const rw = Math.max(1, Math.round(this._fullSize.w * this._reflectScale))
    const rh = Math.max(1, Math.round(this._fullSize.h * this._reflectScale))
    // Linear filtering: water.frag samples the RT through a projected UV, so
    // its size needs no shader change, and bilinear upsampling turns a small
    // RT into a soft blur rather than a blocky mirror. The blur is a real cost
    // at low settings (reflect_resolution.spec.js): the distortion facets and
    // fresnel tiers quantise which texel is read and how opaque it is, not
    // the sharpness of the image.
    this._reflectRT = new THREE.WebGLRenderTarget(rw, rh, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    })
    this._material.uniforms.uReflectionTex.value = this._reflectRT.texture
  }

  /**
   * Copy the view camera's lens and mirror its position and view direction
   * across the horizontal plane y = mirrorY. Flipping the Y components is
   * exact for a horizontal plane; no general reflection matrix is needed.
   */
  _placeMirrorCamera(camera, mirrorY) {
    const cam = this._reflectCamera
    cam.fov = camera.fov
    cam.aspect = camera.aspect
    cam.near = camera.near
    cam.far = camera.far
    cam.updateProjectionMatrix()

    cam.position.set(camera.position.x, 2 * mirrorY - camera.position.y, camera.position.z)
    camera.getWorldDirection(this._reflectDir)
    this._reflectDir.y *= -1
    this._reflectTarget.copy(cam.position).add(this._reflectDir)
    cam.up.set(0, 1, 0)
    cam.lookAt(this._reflectTarget)
    cam.updateMatrixWorld(true)
    return cam
  }

  /**
   * Oblique near-plane clipping (Lengyel's method, as in THREE.Reflector):
   * warp the projection so its near plane is the water plane. Without it the
   * submerged seabed sits between the mirrored camera and the mountains it
   * should see, and renders into the RT as dark occluding wedges. Only the
   * projection's z-row changes, so water.frag's xy/w UV lookup is unaffected.
   */
  _clipNearPlaneToWater(cam, mirrorY) {
    this._reflectClipPoint.set(0, mirrorY - REFLECT_CLIP_MARGIN, 0)
    this._reflectClipPlane.setFromNormalAndCoplanarPoint(REFLECT_UP, this._reflectClipPoint)
    this._reflectClipPlane.applyMatrix4(cam.matrixWorldInverse)
    const cp = this._reflectClipPlane
    const cv = this._reflectClipV4.set(cp.normal.x, cp.normal.y, cp.normal.z, cp.constant)
    const pe = cam.projectionMatrix.elements
    const q  = this._reflectClipQ
    q.x = (Math.sign(cv.x) + pe[8]) / pe[0]
    q.y = (Math.sign(cv.y) + pe[9]) / pe[5]
    q.z = -1.0
    q.w = (1.0 + pe[10]) / pe[14]
    cv.multiplyScalar(2.0 / cv.dot(q))
    pe[2]  = cv.x
    pe[6]  = cv.y
    pe[10] = cv.z + 1.0
    pe[14] = cv.w
  }
}

// ─── Dev-only shader hot-reload ───────────────────────────────────────────────
// The ?raw strings are baked in at construction, so accept the shader modules,
// refresh SRC and rebuild in place (uniforms preserved). noise.glsl is shared
// with terrain.js, which accepts it too, so both materials rebuild on a noise
// edit. Stripped from prod builds.
if (import.meta.hot) {
  import.meta.hot.accept(
    [
      '../shared/shaders/noise.glsl?raw',
      './shaders/water.vert?raw',
      './shaders/water.frag?raw',
    ],
    ([n, wv, wf]) => {
      if (n)  SRC.noise = n.default
      if (wv) SRC.wvert = wv.default
      if (wf) SRC.wfrag = wf.default
      // eslint-disable-next-line no-undef
      const d = (typeof window !== 'undefined') && window.__d
      if (d && d.water) d.water.rebuildShaders()
      // A paused loop draws nothing until a frame is marked dirty; without
      // this the edit would stay invisible.
      if (d && d.markDirty) d.markDirty()
    },
  )
}
