/**
 * pixelRatio.js — how many drawn pixels per CSS pixel the canvas renders at.
 *
 * Almost all of a frame's cost — the cloud march, the terrain and forest
 * shading — is paid per DRAWN pixel, so it grows with the square of this
 * ratio. A Retina screen reports a device ratio of 2: four times the pixels of
 * the same window at 1. Capping the ratio renders fewer pixels and lets the
 * browser scale the canvas up to fill the same window, trading edge sharpness
 * for frame rate. On a screen whose device ratio is already at or below the
 * cap (a 1080p projector or monitor), the cap changes nothing.
 *
 * Pure: no THREE, no DOM.
 */

// The floor for any device ratio or cap (a zoomed-out browser reports a ratio
// well below 1): below this the picture is too soft to be worth the frame rate.
export const PIXEL_RATIO_MIN = 0.5

/**
 * The ratio to render at: the device's own, but never above the cap.
 * @param {number} deviceRatio  window.devicePixelRatio
 * @param {number} cap          the user's ceiling (debug slider)
 */
export function cappedPixelRatio(deviceRatio, cap) {
  return Math.max(PIXEL_RATIO_MIN, Math.min(deviceRatio, cap))
}
