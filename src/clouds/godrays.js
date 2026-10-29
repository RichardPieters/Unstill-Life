import * as THREE from 'three'
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js'
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js'
import cloudCommonGlsl from './shaders/includes/cloudCommon.glsl?raw'
import godraysFragSrc from './shaders/godrays.frag?raw'
import godraysCompositeSrc from './shaders/godraysComposite.frag?raw'
import { inject } from '../shared/shaderCompose.js'
import { clamp01 } from '../shared/mathUtils.js'
import { STATE_FORMAT } from '../shared/uniformSerialize.js'
import { paramAccess } from '../shared/paramAccess.js'
import { uniformsFor, rowDefaults } from '../shared/paramSchema.js'
import { GODRAY_PARAMS, UNIFORM_CLASSES } from './godrayParams.js'

/**
 * godrays.js — volumetric light shafts.
 *
 * Two passes, the same shape as cloudsVolume's: a MARCH into a private render
 * target at a reduced scale, then a composite ShaderPass in the EffectComposer
 * that upsamples, posterizes and adds. The split exists so the quantising
 * happens after the filtering — see godraysComposite.frag.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IT BORROWS, AND WHY THAT IS THE WHOLE POINT
 *
 * Nothing here bakes anything. The shadow that carves the beams is the optical
 * depth cloudsVolume already stores in `_litRT` for its own lighting, handed
 * over each frame by `getShadowFrame()` into the scene-wide uniforms
 * (shared/sceneUniforms.js) — the same objects the ground shadows read. One
 * trilinear fetch per march step, no fBM, no shadow map.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THE WEATHER DOES TO IT
 *
 * The beams' own contrast needs no weather term: the march reads the real
 * shadow field, which is uniformly bright with nothing overhead and uniformly
 * dark under a closed lid, so the contrast that IS the beam disappears at both
 * ends on its own. The weather only gates the pass (setOvercast): below
 * `gateOnset` it does not run at all, and from there to full overcast the
 * brightness comes up with it, so shafts belong to the top of the overcast
 * range and cost nothing the rest of the time.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PARAMS
 *
 * `godrays.params` (shared/paramAccess.js): every godrayParams.js row by key.
 * A march row marks the march dirty; a composite row is read by the per-frame
 * composite pass and marks nothing. Fields: the user's switch, the gate's onset
 * (recomputes the gate) and the march-target scale (reallocates the target).
 * The weather's overcast is a per-frame input, not a param: setOvercast.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ORDER IN THE COMPOSER, AND THE ERROR IT ACCEPTS
 *
 * RenderPass -> godrays -> clouds -> artPass.
 *
 * Before artPass is required, not preferred: the paint shader samples the
 * composited colour as `uBeauty`, so a pass after it would be invisible in the
 * painted frame — and the freeze IS the terminal state of this piece.
 *
 * Before the CLOUDS is a trade with no correct answer. A single alpha composite
 * cannot tell a shaft behind a cloud from one in front of it. Compositing first
 * means cloud alpha dims shafts that are actually nearer than the cloud;
 * compositing after would paint shafts over clouds genuinely in front of them.
 * First is chosen because the shafts live BELOW the deck (shell floor y=80,
 * camera y=72) and are mostly seen against terrain, where cloud alpha is ~0 —
 * so the error lands on sky pixels near the horizon, which is the cheaper half.
 */

const VERT = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

// Every row's default, by key.
const DEFAULT = rowDefaults(GODRAY_PARAMS)
// How uniformsFor builds a colour row's value: a colour-managed THREE.Color.
const MAKE = { srgb: hex => new THREE.Color(hex) }
// The row-backed uniforms the composite pass reads; the rest are the march's.
const COMPOSITE_UNIFORMS = new Set([
  'uRayColor', 'uRayIntensity', 'uRayTiers', 'uRaySoften', 'uRayIntensityScale',
])

// The scene-wide cloud-shadow frame (shared/sceneUniforms.js), under this
// pass's own names: the same objects the ground shadow reads, written by the
// scene set's per-frame step, read here. uShadowTiers is the GROUND shadow's
// ladder, mounted so the beam cut can be snapped onto it (cutLevel() in
// godrays.frag); it is not a control of this module.
const SCENE_NAMES = {
  uCloudGround: 'uCloudGround',
  uSunDir:      'uCloudSunDir',   // normalised, the same vector the ground shadow uses
  uCloudLevel:  'uCloudLevel',
  uCloudHeight: 'uCloudHeight',
  uCloudExtent: 'uCloudExtent',
  uCloudWind:   'uCloudWind',
  uShadowTiers: 'uCloudShadowTiers',
  // Beyond this the cloud volume repeats, so the beams fade out before it.
  // The volume's own value: its draw distance.
  uUsableRadius: 'uUsableRadius',
}

// The shared names are not this pass's to capture: the tier count is the scene
// set's (terrain's entry), the usable radius the cloud volume's, restored with
// its draw distance.

export class Godrays {
  /**
   * @param {import('../shared/sceneUniforms.js').SceneUniforms} sceneUniforms
   *   the scene-wide set; this pass reads its cloud-shadow frame
   */
  constructor(sceneUniforms) {
    this._marchMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uDepthTexture:      { value: null },
        uInverseProjection: { value: new THREE.Matrix4() },
        uInverseView:       { value: new THREE.Matrix4() },
        uCameraPos:         { value: new THREE.Vector3() },
        uSeaLevel:          { value: -6.0 },
        uCameraNear:        { value: 0.1 },
        uCameraFar:         { value: 3000 },
        ...sceneUniforms.mount(SCENE_NAMES),
        // The row-backed march uniforms (godrayParams.js), seeded from the rows.
        ...uniformsFor(GODRAY_PARAMS, r => !COMPOSITE_UNIFORMS.has(r.uniform), MAKE),
      },
      vertexShader:   VERT,
      fragmentShader: inject(godraysFragSrc, [
        ['// cloudCommon.glsl injected by godrays.js', cloudCommonGlsl],
      ]),
      depthTest: false, depthWrite: false,
    })
    this._marchQuad = new FullScreenQuad(this._marchMaterial)

    this._compositeMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse:      { value: null },
        uRayTex:       { value: null },
        uRayTexel:     { value: new THREE.Vector2(1, 1) },
        // The row-backed composite uniforms: colour, intensity, tiers, softness
        // and the density dial's intensity scale.
        ...uniformsFor(GODRAY_PARAMS, r => COMPOSITE_UNIFORMS.has(r.uniform), MAKE),
        uRayWeather:   { value: 0 },   // closed until setOvercast says otherwise
      },
      vertexShader:   VERT,
      fragmentShader: godraysCompositeSrc,
    })
    this.pass = new ShaderPass(this._compositeMaterial)
    this.pass.enabled = false

    this._rayRT = null
    this._canvasW = 0
    this._canvasH = 0
    this._renderScale = DEFAULT.renderScale
    // Whether the world is holding still. Same contract as the cloud volume's:
    // told every frame by main.js, and what it lets us skip is our business.
    this._sceneStatic = false
    this._dirty = true
    // The ground ladder and usable radius the last march used. Both are scene
    // set objects other modules move without telling this pass, so a change is
    // noticed here and forces a march even while the world holds still.
    this._marchedTiers = null
    this._marchedRadius = null
    // Instrumentation for static_scene_gating.spec.js — a pass that quietly
    // re-marched every frame under a finished painting would burn the budget
    // that gate exists to save, and nothing else would notice.
    this.marchCount = 0
    // The switch the user owns, kept apart from this.pass.enabled — which is
    // the switch the WEATHER owns. Both have to be on for anything to run.
    this._enabled   = DEFAULT.enabled
    this._overcast  = 0
    this._gateOnset = DEFAULT.gateOnset
    // Leaves this.pass.enabled false until the weather is grey enough — see
    // setOvercast. On by default, but costing nothing on a clear day.
    this._applyGate()

    // The one accessor over every godrays value: the rows of godrayParams.js
    // (built last, after the materials and the state its fields read). Callers
    // read and write through it: `godrays.params.set(key, v)`.
    this.params = paramAccess({
      tables: [this._marchMaterial.uniforms, this._compositeMaterial.uniforms],
      rows:   GODRAY_PARAMS,
      fields: {
        enabled:   { get: () => this._enabled, set: v => { this._enabled = v; this._applyGate(); this._dirty = true } },
        // The gate follows the onset: it moves uRayWeather and the pass's switch.
        gateOnset: { get: () => this._gateOnset, set: v => { this._gateOnset = v; this._applyGate() } },
        renderScale: { get: () => this._renderScale, set: v => this._rescaleTarget(v) },
      },
      // The march rows: a change forces one more march (see `render`).
      onInvalidate: () => { this._dirty = true },
    })
  }

  /**
   * The weather's overcast, 0..1, pushed every frame by main.js.
   *
   * Below `gateOnset` there is no shaft at all and the composite pass is turned
   * OFF, which takes the march, the half-res target and a fullscreen blit out of
   * the frame with it — most of the time, since the gate only opens at the very
   * top of the overcast range. From the onset to full overcast the shafts come
   * up to strength, so the effect arrives with the weather instead of appearing
   * fully formed at a threshold.
   */
  setOvercast(w) {
    const next = clamp01(w)
    if (next === this._overcast) return
    this._overcast = next
    this._applyGate()
  }
  getOvercast() { return this._overcast }

  /** Current gate value, 0..1 — 0 means the whole pass is switched off. */
  getWeatherGate() { return this._compositeMaterial.uniforms.uRayWeather.value }

  _applyGate() {
    const onset = this._gateOnset
    const gate = onset >= 1 ? (this._overcast >= 1 ? 1 : 0)
                            : clamp01((this._overcast - onset) / (1 - onset))
    const u = this._compositeMaterial.uniforms.uRayWeather
    if (u.value !== gate) { u.value = gate; this._dirty = true }
    const on = this._enabled && gate > 0
    if (this.pass.enabled !== on) { this.pass.enabled = on; this._dirty = true }
  }

  setSceneStatic(v) { this._sceneStatic = !!v }
  /** Force one more march (a slider moved, the window resized). */
  markDirty() { this._dirty = true }

  setDepthTexture(tex) { this._marchMaterial.uniforms.uDepthTexture.value = tex }
  /** World Y of the (flat) water plane — clips the march at the water surface
   *  instead of the terrain floor beneath it (see the shader's own doc). */
  setSeaLevel(v) { this._marchMaterial.uniforms.uSeaLevel.value = v }

  setSize(w, h) {
    if (w === this._canvasW && h === this._canvasH) return
    this._canvasW = w
    this._canvasH = h
    if (this._rayRT) this._rayRT.dispose()
    const rw = Math.max(1, Math.round(w * this._renderScale))
    const rh = Math.max(1, Math.round(h * this._renderScale))
    this._rayRT = new THREE.WebGLRenderTarget(rw, rh, {
      type: THREE.HalfFloatType,
      format: THREE.RedFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
    })
    this._compositeMaterial.uniforms.uRayTex.value = this._rayRT.texture
    this._compositeMaterial.uniforms.uRayTexel.value.set(1 / rw, 1 / rh)
    this._dirty = true
  }

  /**
   * March into the private target. Called from main.js before the composer, the
   * same place and for the same reason as clouds.renderClouds.
   */
  render(renderer, camera) {
    if (!this.pass.enabled || !this._rayRT) return
    const u = this._marchMaterial.uniforms
    // No cloud volume yet means no shadow to carve beams out of. Marching a
    // null sampler is undefined, so bail rather than bind one.
    if (!u.uCloudGround.value) return

    // Only the cloud volume writes the radius. 0 means this pass was built on
    // a scene set no volume mounted, and every beam would silently fade out.
    if (!(u.uUsableRadius.value > 0)) {
      throw new Error('godrays: uUsableRadius is unset; build the VolumeClouds on the same scene uniforms')
    }
    if (u.uShadowTiers.value !== this._marchedTiers || u.uUsableRadius.value !== this._marchedRadius) {
      this._dirty = true
    }
    // Hold the last marched frame while the world does. The early-return is the
    // whole reason this pass can sit in a piece that spends most of its time
    // frozen under a painting.
    if (this._sceneStatic && !this._dirty) return

    u.uInverseProjection.value.copy(camera.projectionMatrixInverse)
    u.uInverseView.value.copy(camera.matrixWorld)
    u.uCameraPos.value.copy(camera.position)
    u.uCameraNear.value = camera.near
    u.uCameraFar.value = camera.far

    const prev = renderer.getRenderTarget()
    renderer.setRenderTarget(this._rayRT)
    this._marchQuad.render(renderer)
    renderer.setRenderTarget(prev)
    this.marchCount++
    this._dirty = false
    this._marchedTiers = u.uShadowTiers.value
    this._marchedRadius = u.uUsableRadius.value
  }

  // ─── snapshot (sceneModules.js) ────────────────────────────────────────────

  /**
   * { format, params }: every row by key. The `enabled` row is the USER's
   * switch, not this.pass.enabled — that one also carries the weather gate, and
   * a snapshot taken under a clear sky would otherwise restore as "godrays off"
   * forever. No uniform is integrated (godrayParams.js).
   */
  exportState() {
    return { format: STATE_FORMAT, params: this.params.export() }
  }

  /**
   * Restore exportState(). Returns { unknown, rejected }.
   */
  importState(state = {}) {
    if (state.format !== STATE_FORMAT) return { unknown: [`godrays.format ${state.format}`], rejected: [] }
    const report = this.params.import(state.params || {})
    // uRayWeather is derived, not authored — recompute it (and pass.enabled)
    // from the restored switch and onset rather than trusting whatever overcast
    // happened to be in force when the snapshot was taken.
    this._applyGate()
    this._dirty = true
    return { unknown: report.unknown, rejected: report.rejected }
  }

  // ─── private ───────────────────────────────────────────────────────────────

  /** The `renderScale` field: rebuild the march target at the new scale. */
  _rescaleTarget(scale) {
    this._renderScale = scale
    const w = this._canvasW, h = this._canvasH
    this._canvasW = 0     // force setSize to rebuild at the new scale
    this.setSize(w, h)
  }
}
