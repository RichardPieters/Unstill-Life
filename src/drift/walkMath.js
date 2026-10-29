/**
 * walkMath.js — the bounded random walk behind every unattended wander
 * (atmosphere.js's overcast/haze, formWalker.js's macro dials), held per
 * channel by walk.js.
 *
 * A channel is a latent u in [0,1] with a target. Each tick `advance` moves u
 * one fixed `step` toward the target. When u arrives, a fresh target is drawn
 * within ±spread of it (`drawNearby`); a draw that would leave [0,1] is
 * reflected back in, so the dial never parks at an end.
 *
 * Note: the targets are uniform on [0,1], but u spends less time near the ends,
 * because it only passes through there on its way to a target (measured: at
 * spread 0.25 the outer 5% gets ~0.4× the average share). A channel that wants
 * a preferred region warps the readout (formWalker.js's snowline).
 */

import { clamp01 } from '../shared/mathUtils.js'

/** A target this close is treated as reached, and a fresh one is drawn. */
const ARRIVED_EPS = 1e-4

/**
 * Fold a value back into [0,1] by reflection. One fold suffices for the walk:
 * |hop| <= 1, so its input lands in [-1, 2]. Non-finite input returns 0.5, so a
 * NaN latent cannot reach the uniforms.
 */
export function reflect01(v) {
  if (!Number.isFinite(v)) return 0.5
  if (v < 0) return -v
  if (v > 1) return 2 - v
  return v
}

/** A fresh target within ±spread of `u` (spread clamped to [0,1]; NaN counts as 0), reflected off the ends. */
export function drawNearby(u, spread, random) {
  const hop = (random() * 2 - 1) * clamp01(spread)
  return reflect01(u + hop)
}

/**
 * One walk step toward `target`, redrawing the target on arrival. Returns a new
 * { u, target, moved }; `moved` is false only when u did not change, so the
 * owner can skip an `apply` that would rewrite its uniforms for nothing. A
 * non-positive or NaN step leaves the channel untouched.
 */
export function advance(u, target, step, spread, random) {
  if (!(step > 0)) return { u, target, moved: false }
  const gap = target - u
  if (Math.abs(gap) <= Math.max(step, ARRIVED_EPS)) {
    return { u: target, target: drawNearby(target, spread, random), moved: gap !== 0 }
  }
  return { u: u + Math.sign(gap) * step, target, moved: true }
}
