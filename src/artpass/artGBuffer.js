import * as THREE from 'three'

/**
 * artGBuffer.js — the scene data the art pass paints from.
 *
 * The divisionist pass is an image-space operation, but it is not a filter: a
 * stroke has to know how far away the thing under it is, whether that thing is
 * sky, water or land, and which way the ground slopes there. None of that
 * survives into the composited frame, so it is rendered separately, once per
 * frame, into one small target.
 *
 * WHAT IS IN IT — one RGBA8 colour target plus a hardware depth texture:
 *
 *    R, G   the surface normal's x and z, mapped 0..1
 *    B      1 on the water surface, 0 on land
 *    A      1 where any surface was drawn — cleared to 0, so sky is what is
 *           left untouched rather than a value anyone has to write
 *    depth  the real depth buffer
 *
 * That is the complete list of what the lattice asks about the scene. There is
 * no material id: nothing reads biome granularity, so it would be a channel
 * nothing loads.
 *
 * WHY A SEPARATE PASS rather than extra outputs on the main render. The main
 * render goes through EffectComposer, whose render target has one attachment;
 * adding more means replacing the composer's own machinery. This costs one
 * extra scene submission instead, and the fragment stage it runs is four
 * instructions long — both terrain.frag and water.frag return from their
 * `uArtData` branch before classify, the canopy resolve, the lighting ladder
 * and the fog, which is where essentially all of their cost lives. The vertex
 * stage is two texture fetches. The existing depth pre-pass is justified on
 * exactly this reasoning (water.depthPrePass, in main.js's loop).
 *
 * WHY A UNIFORM rather than an override material: the terrain's height comes
 * from its own vertex shader, so any substitute material renders a flat plane
 * at y = 0 that sits above the sea and occludes the water everywhere
 * (measured: 0% water coverage with depth test on, 58% with it off).
 */
export class ArtGBuffer {
  /**
   * @param {import('../terrain/terrain.js').Terrain} terrain
   * @param {import('../water/water.js').Water} water
   */
  constructor(terrain, water) {
    this._terrain = terrain
    this._water = water
    this._rt = null
    this._sizedFor = null
  }

  /** The G-buffer colour target, or null before the first render. */
  get texture() { return this._rt ? this._rt.texture : null }

  /** Its depth attachment. */
  get depthTexture() { return this._rt ? this._rt.depthTexture : null }

  setSize(width, height) {
    const w = Math.max(1, Math.round(width))
    const h = Math.max(1, Math.round(height))
    const key = `${w}x${h}`
    if (this._sizedFor === key) return
    this._sizedFor = key

    if (this._rt) this._rt.dispose()
    this._rt = new THREE.WebGLRenderTarget(w, h, {
      // NEAREST throughout. The alpha channel is a coverage MASK and the blue
      // channel a segment FLAG: interpolating either across a silhouette
      // invents a half-covered, half-watery pixel that is neither, and the
      // three-way test downstream is a threshold, so a smoothed edge becomes a
      // one-pixel band of the wrong segment rather than a softer boundary.
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: true,
      depthTexture: new THREE.DepthTexture(w, h),
    })
  }

  /**
   * Draw one frame of the G-buffer.
   *
   * `scene.background` has to go for the duration. It wins over the clear
   * colour, so leaving it in place makes every pixel opaque and the coverage
   * mask reads 100% — the sky then registers as land and the whole frame paints
   * with the terrain's spread and orientation.
   */
  render(renderer, scene, camera) {
    if (!this._rt) return

    const prevTarget = renderer.getRenderTarget()
    const prevBg = scene.background
    const prevClear = renderer.getClearColor(new THREE.Color())
    const prevAlpha = renderer.getClearAlpha()

    scene.background = null
    this._terrain.params.set('artData', true)
    this._water.params.set('artData', true)

    renderer.setRenderTarget(this._rt)
    renderer.setClearColor(0x000000, 0)
    renderer.clear(true, true, false)
    renderer.render(scene, camera)

    this._terrain.params.set('artData', false)
    this._water.params.set('artData', false)
    scene.background = prevBg
    renderer.setClearColor(prevClear, prevAlpha)
    renderer.setRenderTarget(prevTarget)
  }

  dispose() {
    if (this._rt) this._rt.dispose()
    this._rt = null
    this._sizedFor = null
  }
}
