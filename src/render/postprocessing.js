/**
 * postprocessing.js — the EffectComposer chain, in its fixed order:
 *
 *   RenderPass → godrays → clouds → artPass
 *
 *   godrays  before the clouds, so a cloud in front of a shaft occludes it
 *   clouds   `clouds.passes` (cloudsVolume.js's composite)
 *   artPass  last: it paints the composited picture, sky and clouds included
 *
 * Every pass is added once and stays in the chain; turning one off sets its
 * `enabled`, which the composer skips for free, instead of rebuilding the
 * chain mid-frame. godrays, clouds and artPass are optional (null = left out).
 */

import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass }     from 'three/addons/postprocessing/RenderPass.js'

export class Postprocessing {
  constructor(renderer, scene, camera, clouds, artPass, godrays) {
    this._composer = new EffectComposer(renderer)
    this._composer.addPass(new RenderPass(scene, camera))
    if (godrays) this._composer.addPass(godrays.pass)
    if (clouds) for (const pass of clouds.passes) this._composer.addPass(pass)
    if (artPass) this._composer.addPass(artPass)
  }

  render() {
    this._composer.render()
  }

  /** @param {number} width @param {number} height */
  setSize(width, height) {
    this._composer.setSize(width, height)
  }

  /**
   * The composer copies the renderer's pixel ratio once, at construction, so a
   * later renderer.setPixelRatio alone leaves the main scene render at the old
   * resolution. Call alongside it. @param {number} ratio
   */
  setPixelRatio(ratio) {
    this._composer.setPixelRatio(ratio)
  }
}
