import * as THREE from 'three'
import { shareGone } from './artPassMath.js'

/**
 * artHold.js — the finished picture, held, and taken apart again on exit.
 *
 * A completed entrance does not keep repainting: the paint buffer is copied
 * once and served from the copy, which is what makes a finished painting cheap
 * and what makes the exit possible at all. A held lattice cannot track a
 * landscape that has started moving again, because nothing is recomputing it,
 * so the painting stays a still image while the scene resumes underneath it,
 * and the dissolve (artDissolve.frag) takes strokes away where the two have
 * drifted apart.
 *
 * It owns the targets that live between frames (the held lattice, the stroke
 * ids, the frame the lattice was painted from, the dissolve's output and its
 * memory of what has gone), the materials that move pixels between them, and
 * the COUNT of strokes that have gone: the same exit rule asked of every
 * stroke of the lattice (artExitCount.frag), read back asynchronously, so the
 * sound can follow the strokes actually leaving. When the picture is held, and
 * when the dissolve runs, is the state machine's (artPassReveal.js) and
 * ArtPass's.
 */
export class ArtHold {
  /**
   * @param {object} deps
   * @param {(renderer, material, target) => void} deps.draw  fullscreen draw
   * @param {object} deps.materials  copyMat, dissolveMat, exitCountMat
   * @param {object} deps.shared     uHeldBeauty
   */
  constructor({ draw, materials, shared }) {
    this._draw = draw
    this._copyMat = materials.copyMat
    this._dissolveMat = materials.dissolveMat
    this._countMat = materials.exitCountMat
    this._shared = shared
    this._goneRts = null
    this._goneKey = null
    this._countFlip = 0
    this._countPending = false
    this._removed = 0
  }

  /** Adopt freshly allocated targets for a new frame size. */
  resize(targets, width, height) {
    this._t = targets
    this._shared.uHeldBeauty.value = targets.heldBeautyRt.texture
    this._countMat.uniforms.uRes.value.set(width, height)
    this._size = { width, height }
  }

  /** The held picture, for the finish pass to light. */
  get paint() { return this._t.heldPaintRt.texture }

  /** The share of the lattice's strokes that have gone in the exit running now,
   *  [0,1]; 0 outside one. Lags the picture by a frame or two. */
  get removed() { return this._removed }

  /**
   * Hold the finished picture: the lattice, which stroke owns each of its
   * pixels, and the frame it was painted from.
   *
   * Three copies at ONE instant, which is the point for the last two — the
   * exit's whole question is how far the landscape has drifted from the
   * painting's own moment, and that only means anything if both the frame
   * and the id/anchor each pixel drifts AGAINST were taken together.
   *
   * @param {THREE.WebGLRenderTarget} paintRt  the paint target (two attachments)
   * @param {THREE.Texture} beauty  the frame that picture was painted from
   */
  freeze(renderer, paintRt, beauty) {
    const t = this._t
    this._copy(renderer, paintRt.texture, t.heldPaintRt)
    this._copy(renderer, paintRt.textures[1], t.heldIdRt)
    this._copy(renderer, beauty, t.heldBeautyRt)
    // The exit's ratchet starts here too: at the instant of freezing, nothing
    // has dissolved yet, so its "memory of what survived last frame" starts
    // as the fully-painted picture itself.
    this._copy(renderer, t.heldPaintRt.texture, t.dissolvePrevRt)
    this._removed = 0
    this._countMat.uniforms.uHavePrev.value = 0
  }

  /**
   * Thin the held lattice by one frame's worth of dissolve, and return what the
   * finish pass should light. The live frame it is measured against is the
   * shared uBeauty.
   *
   * Everything downstream is unchanged by this, so the relief still lights
   * correctly and fades out with the paint it belongs to.
   */
  dissolve(renderer) {
    const t = this._t
    const u = this._dissolveMat.uniforms
    u.uHeldPaint.value = t.heldPaintRt.texture
    u.uHeldId.value = t.heldIdRt.texture
    u.uPrevDissolved.value = t.dissolvePrevRt.texture
    this._draw(renderer, this._dissolveMat, t.dissolveOutRt)

    // This frame's result becomes next frame's memory of what has already gone
    // — see the ratchet in artDissolve.frag. Without it, a stroke's survival is
    // recomputed from scratch every frame from nothing but the CURRENT
    // live/held colours, which is not monotonic: the drift rule's "distance
    // from the original colour" can shrink again later (the landscape
    // revisiting a similar colour, a camera panning back), and a stroke that
    // had already gone would reappear.
    this._copy(renderer, t.dissolveOutRt.texture, t.dissolvePrevRt)
    return t.dissolveOutRt.texture
  }

  /**
   * Ask the exit rule of every stroke of the lattice and start reading the
   * answer back. At most one read is in flight; the share it finds replaces
   * `removed` when it arrives, a frame or two later, and never falls.
   *
   * @param {{texture, width, height, cellsX, cellsY}} anchors  the base
   *   lattice table: where each stroke is anchored (ArtStrokes.anchorTable)
   */
  countRemoved(renderer, anchors) {
    this._ensureGone(anchors)
    const [a, b] = this._goneRts
    const [prev, out] = this._countFlip ? [b, a] : [a, b]
    const u = this._countMat.uniforms
    u.uPrevGone.value = prev.texture
    this._draw(renderer, this._countMat, out)
    u.uHavePrev.value = 1
    this._countFlip = 1 - this._countFlip

    if (this._countPending) return
    this._countPending = true
    const buf = new Uint8Array(out.width * out.height * 4)
    renderer.readRenderTargetPixelsAsync(out, 0, 0, out.width, out.height, buf).then(() => {
      this._removed = Math.max(this._removed,
        shareGone(buf, out.width, out.height, anchors.cellsX, anchors.cellsY))
    }).catch(err => {
      console.warn('artPass: reading back the exit count failed', err)
    }).finally(() => { this._countPending = false })
    // three.js leaves the read's pixel-pack buffer bound until the GPU answers,
    // frames later, and every synchronous readback in between fails and returns
    // zeros: a reveal starting then (the growth seed, the birth-time readback)
    // would bake every stroke at pixel (0, 0). The read keeps its own handle and
    // rebinds it to collect the result, so unbinding here costs it nothing.
    const gl = renderer.getContext()
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null)
  }

  /** The count's two targets are the lattice table's size. */
  _ensureGone(anchors) {
    const key = `${anchors.width}x${anchors.height}`
    if (key === this._goneKey) return
    for (const rt of this._goneRts || []) rt.dispose()
    const make = () => new THREE.WebGLRenderTarget(anchors.width, anchors.height, {
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false,
    })
    this._goneRts = [make(), make()]
    this._goneKey = key
    this._countMat.uniforms.uHavePrev.value = 0
    this._countFlip = 0
  }

  dispose() {
    for (const rt of this._goneRts || []) rt.dispose()
  }

  _copy(renderer, src, target) {
    this._copyMat.uniforms.uSrc.value = src
    this._draw(renderer, this._copyMat, target)
  }
}
