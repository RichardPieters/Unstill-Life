/**
 * mathUtils.js — small numeric helpers shared across subsystems.
 *
 * Both clamps treat NaN and any non-number (undefined, null) as the LOWER bound
 * rather than passing them through: values from outside (a stalled sensor, a
 * hand-edited snapshot, a missing field) reach uniforms and AudioParams, where
 * a NaN blanks the frame or throws. ±Infinity clamps to the matching bound.
 */

/** Clamp `x` to [lo, hi]; NaN and non-numbers become `lo`. Needs lo <= hi (not checked: this runs every frame). */
export function clamp(x, lo, hi) {
  if (typeof x !== 'number' || Number.isNaN(x)) return lo
  return x < lo ? lo : x > hi ? hi : x
}

/** Clamp `x` to [0, 1]; NaN and non-numbers become 0. */
export function clamp01(x) {
  return clamp(x, 0, 1)
}
