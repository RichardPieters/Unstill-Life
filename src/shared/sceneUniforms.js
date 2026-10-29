/**
 * sceneUniforms.js — the uniforms the whole scene shares: one fog, one light
 * level, one cloud deck casting one shadow. Terrain, water, godrays and the art
 * pass must agree on them or the shoreline shows a seam.
 *
 *   const scene = createSceneUniforms()      // once, in main.js (a test makes its own)
 *   new Terrain(dynamics, scene)
 *   scene.params.set('fogCurve', 0.7)
 *   scene.setCloudShadowFrame(clouds.getShadowFrame())
 *
 * ONE OBJECT  Each uniform is a single { value } object, mounted into every
 *   consumer's own uniform table (`mount`), so one write reaches every program.
 *   A consumer may mount one under another name (godrays' uSunDir is
 *   uCloudSunDir).
 * ONE WRITER  The authored values (sceneParams.js rows) are written only through
 *   `params.set`. The cloud-shadow placement (uCloudGround, level, height, extent,
 *   wind, sun direction) is the cloud volume's own state, copied in once per
 *   frame by `setCloudShadowFrame`. uUsableRadius is written only by the cloud
 *   volume. tests/unit/sceneUniforms.test.js fails on a consumer that writes one.
 * DERIVED     uCloudShadowAmt = master × density scale while a light volume
 *   exists, else 0. Recomputed on every write to either and every frame.
 * SNAPSHOT    `exportState`/`importState` carry the authored values. They ride in
 *   terrain's snapshot entry; the placement and the derived amount are not captured.
 *
 * A factory, not a module-level object: each call is an independent set.
 */
import * as THREE from 'three'
import { paramAccess } from './paramAccess.js'
import { uniformsFor } from './paramSchema.js'
import { SCENE_PARAMS } from './sceneParams.js'

function buildUniforms() {
  return {
    ...uniformsFor(SCENE_PARAMS, () => true, { srgb: hex => new THREE.Color(hex) }),
    // Cloud shadows: the ground shadow's 2-D texture (null until the cloud volume
    // has baked; the volume swaps between two, so the frame names the current one)
    // and how the ground reads it. The placement below is the cloud
    // volume's own values, copied in every frame (setCloudShadowFrame); the 0s
    // are never read, since the amount is 0 and godrays skip until a volume exists.
    uCloudGround:      { value: null },
    uCloudShadowAmt:   { value: 0 },
    uCloudLevel:       { value: 0 },
    uCloudHeight:      { value: 0 },
    uCloudExtent:      { value: 0 },
    uCloudWind:        { value: new THREE.Vector2() },
    uCloudSunDir:      { value: new THREE.Vector3(0.788, 0.615, 0) },
    // How far from the camera the cloud volume can be trusted before it
    // repeats. Owned and written by the cloud volume alone (cloudsVolume.js,
    // from its draw distance, at construction and on every regrid); godrays reads it
    // to fade the beams out before the repeat. 0 until the volume writes it.
    uUsableRadius:     { value: 0 },
  }
}

/**
 * @returns {SceneUniforms} one independent set
 * @typedef {ReturnType<typeof createSceneUniforms>} SceneUniforms
 */
export function createSceneUniforms() {
  const uniforms = buildUniforms()
  // The amount the shader reads: the master times the dial's scale while a light
  // volume exists, else 0.
  const shadowAmount = read => (uniforms.uCloudGround.value ? read('cloudShadowAmt') * read('cloudShadowScale') : 0)
  const params = paramAccess({
    tables: [uniforms],
    rows: SCENE_PARAMS,
    derived: [{ uniform: 'uCloudShadowAmt', from: ['cloudShadowAmt', 'cloudShadowScale'], fn: shadowAmount }],
  })

  return {
    /** The authored values by key (sceneParams.js): get, set, onChange, export, import. */
    params,

    /**
     * The shared objects for one consumer's uniform table. `names` is a list
     * (mounted under their own names) or a map { consumerName: sharedName }.
     * Spread the result into the material's `uniforms`; never copy a value.
     */
    mount(names) {
      const pairs = Array.isArray(names) ? names.map(n => [n, n]) : Object.entries(names)
      const out = {}
      for (const [as, name] of pairs) {
        if (!Object.hasOwn(uniforms, name)) throw new Error(`sceneUniforms.mount: no shared uniform "${name}"`)
        out[as] = uniforms[name]
      }
      return out
    },

    /**
     * The cloud volume's sun-shadow oracle for this frame (cloudsVolume.js
     * getShadowFrame). Every frame rather than once, because the volume is
     * built lazily and its wind offset scrolls. While `frame.ground` is null the
     * amount is 0 and the placement is left as it was; the sun direction (the
     * water glint reads it too) is written either way.
     */
    setCloudShadowFrame(frame) {
      uniforms.uCloudGround.value = frame.ground
      uniforms.uCloudShadowAmt.value = shadowAmount(params.get)
      uniforms.uCloudSunDir.value.set(frame.sunX, frame.sunY, frame.sunZ)
      if (!frame.ground) return
      uniforms.uCloudLevel.value  = frame.level
      uniforms.uCloudHeight.value = frame.height
      uniforms.uCloudExtent.value = frame.extent
      uniforms.uCloudWind.value.set(frame.windX, frame.windZ)
    },

    /**
     * The authored values, by key, as JSON (params.export): a colour as
     * '#rrggbb', the cloud-shadow master as the slider holds it, and the density
     * dial's scale. terrain.js carries this in its own snapshot entry. The
     * per-frame cloud-shadow frame and the derived amount are not captured.
     */
    exportState() { return params.export() },
    /** Restore exportState(); returns the keys it could not write. */
    importState(values) {
      const present = Object.fromEntries(Object.entries(values).filter(([, v]) => v != null))
      return params.import(present).rejected
    },
  }
}

/** Every shared uniform name (the single-writer test scans consumers for them). */
export const SCENE_UNIFORM_NAMES = Object.keys(buildUniforms())

/** The names a consumer mounts a shared uniform under when they differ (godrays). */
export const SCENE_ALIASES = ['uSunDir', 'uShadowTiers']
