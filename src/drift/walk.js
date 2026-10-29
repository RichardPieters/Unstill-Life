/**
 * walk.js — the channel bookkeeping of the bounded random walk (the maths is
 * walkMath.js): per channel a latent u in [0,1], the target it creeps toward,
 * and an optional readout warp, so the position an owner sees is warp(u).
 *
 * The owner decides the pace: it computes each channel's step per tick and
 * calls `step`. `spreadOf(key)` is read per draw, so a range slider takes
 * effect at once. Channels rest at 0.5 until `seed`. A hand-set position
 * reflects off the ends and redraws the target; an imported latent or target
 * clamps, because it arrives from outside.
 * formWalker.js (five dials) and atmosphere.js (overcast, haze) each own one.
 */

import { clamp01 } from '../shared/mathUtils.js'
import { advance, drawNearby, reflect01 } from './walkMath.js'

const IDENTITY = v => v

export class Walk {
  /**
   * @param {object} opts
   * @param {{key:string, warp?:(u:number)=>number, unwarp?:(pos:number)=>number}[]} opts.channels
   *   `unwarp` is the inverse of `warp`
   * @param {(key:string) => number} opts.spreadOf  the channel's target range, read per draw
   * @param {() => number} [opts.random]            injectable for tests
   */
  constructor({ channels, spreadOf, random = Math.random }) {
    this._spreadOf = spreadOf
    this._random = random
    this._channels = channels.map(({ key, warp = IDENTITY, unwarp = IDENTITY }) => ({ key, warp, unwarp }))
    this._byKey = Object.fromEntries(this._channels.map(c => [c.key, c]))
    this._u = {}
    this._target = {}
    for (const { key } of this._channels) { this._u[key] = 0.5; this._target[key] = 0.5 }
  }

  /**
   * Start a channel at `position`, clamped to [0,1] before the inverse warp (a
   * negative number raised to a fractional power is NaN), with a target drawn
   * nearby. A non-finite position starts at 0.5.
   */
  seed(key, position) {
    const pos = Number.isFinite(position) ? clamp01(position) : 0.5
    this._u[key] = this._byKey[key].unwarp(pos)
    this._target[key] = drawNearby(this._u[key], this._spreadOf(key), this._random)
  }

  /** The channel's readout, warp(u). */
  position(key) { return this._byKey[key].warp(this._u[key]) }

  /** The channel's latent, before the warp. */
  latent(key) { return this._u[key] }

  /** Every channel's readout, by key. */
  positions() {
    return Object.fromEntries(this._channels.map(c => [c.key, c.warp(this._u[c.key])]))
  }

  /** One walk step of `step` for a channel; false when its latent did not change. */
  step(key, step) {
    const r = advance(this._u[key], this._target[key], step, this._spreadOf(key), this._random)
    this._u[key] = r.u
    this._target[key] = r.target
    return r.moved
  }

  /**
   * Hand-set a channel's latent (reflected into [0,1]; non-finite reads as
   * 0.5) and redraw its target from there, so the walk resumes from the hand's
   * position.
   */
  setPosition(key, v) {
    this._u[key] = reflect01(v)
    this._target[key] = drawNearby(this._u[key], this._spreadOf(key), this._random)
  }

  /** The latents and in-flight targets, by key. */
  exportState() {
    return { u: { ...this._u }, target: { ...this._target } }
  }

  /** Restore latents and targets, clamped to [0,1]; a missing or non-finite entry keeps its value. */
  importState({ u, target } = {}) {
    for (const { key } of this._channels) {
      if (Number.isFinite(u?.[key]))      this._u[key] = clamp01(u[key])
      if (Number.isFinite(target?.[key])) this._target[key] = clamp01(target[key])
    }
  }
}
