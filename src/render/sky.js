/**
 * sky.js — the scene background: a vertical gradient from zenith to horizon.
 *
 * HOW      The gradient is painted into a 2×256 canvas texture that main.js sets
 *   as `scene.background`; three.js draws it as a screen-filling quad. 256 rows
 *   are far fewer than the screen's pixels, so the linear filter blends adjacent
 *   rows and the gradient stays smooth (nearest would show flat bands). The
 *   canvas holds sRGB bytes, as a THREE.Color background would.
 * NO MESH  The camera holds one framing, so a screen-space gradient is a sky
 *   dome for a frame that never turns: no extra mesh or shader.
 * ENDS     The horizon is written by main.js's `applyHorizon`; the zenith is a
 *   weather-driven row (weatherDriver.js) that blends toward the horizon's heavy
 *   colour, so at full overcast the gradient flattens.
 * REACH    The `reach` row packs the whole blend into the top of the canvas,
 *   the only part ever seen above the mountains.
 * SNAPSHOT `reach` only; the colours are captured in atmosphere.js's clear state.
 */

import * as THREE from 'three'
import { paramAccess } from '../shared/paramAccess.js'
import { SKY_PARAMS } from './skyParams.js'

export class Sky {
  // ─── state ─────────────────────────────────────────────────────────────────

  constructor() {
    this.params = paramAccess({ tables: [], rows: SKY_PARAMS })

    // Two texels wide is enough: three.js stretches a plain (non-cube)
    // background texture over the screen, so only the vertical resolution
    // shows. Not one texel, which some platforms filter oddly at the edges.
    this._canvas = document.createElement('canvas')
    this._canvas.width = 2
    this._canvas.height = 256
    this._ctx = this._canvas.getContext('2d')
    this.texture = new THREE.CanvasTexture(this._canvas)
    // The canvas holds sRGB bytes, as a THREE.Color background would; without
    // this they are read as linear and the sky looks washed out.
    this.texture.colorSpace = THREE.SRGBColorSpace
    this.texture.minFilter = THREE.LinearFilter
    this.texture.magFilter = THREE.LinearFilter

    this._redraw()
    this.params.onAnyChange(() => this._redraw())
  }

  /** Snapshot (sceneModules.js): `reach` only — see SNAPSHOT in the header. */
  exportState() { return this.params.export() }

  importState(state = {}) {
    if (Number.isFinite(state.reach)) this.params.set('reach', state.reach)
  }

  // ─── drawing ───────────────────────────────────────────────────────────────

  _hexToCss(hex) { return '#' + (hex >>> 0).toString(16).padStart(6, '0') }

  _redraw() {
    const ctx = this._ctx
    const h = this._canvas.height
    // The blend ends at `reach`; the explicit stop at 1 holds the horizon
    // colour over the rest (a gradient would repeat its last stop anyway).
    const grad = ctx.createLinearGradient(0, 0, 0, h)
    grad.addColorStop(0, this._hexToCss(this.params.get('zenithHex')))
    grad.addColorStop(this.params.get('reach'), this._hexToCss(this.params.get('horizonHex')))
    grad.addColorStop(1, this._hexToCss(this.params.get('horizonHex')))
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, 2, h)
    this.texture.needsUpdate = true
  }
}
