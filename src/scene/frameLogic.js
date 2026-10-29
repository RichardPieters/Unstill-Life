/**
 * frameLogic.js — the per-frame decisions main.js's render loop makes between
 * the art pass, dynamics, the debug pause and the camera: whether dynamics
 * advances, whether a painting holds or wakes it, whether the art pass needs
 * frames, whether cached render targets are valid.
 *
 * Pure functions of the objects passed in: no THREE, no DOM, no state.
 * dynamics.js and artPass.js know nothing of each other; this is where their
 * relationship is decided.
 */

/**
 * A painting is up and not dissolving: the reveal is playing or the finished
 * painting is held. The exit is excluded, because its dissolve reads the
 * landscape drifting. Independent of how the painting got there (the freeze,
 * the debug checkbox, a snapshot restore).
 */
export function isPaintingStill(artPass) {
  return artPass.enabled && !artPass.isExitPlaying()
}

/**
 * Keeps "a painting is up" implying "dynamics is frozen". A painting the cycle
 * did not cause gets a silent `hold()`, which attention cannot wake; once its
 * exit starts, `wake()` lets the world move for the dissolve. Runs every frame,
 * before shouldAdvanceDynamics.
 */
export function reconcilePaintingHold(artPass, dynamics) {
  if (isPaintingStill(artPass) && !dynamics.isFrozen()) dynamics.hold()
  else if (dynamics.isHeld() && artPass.isExitPlaying()) dynamics.wake()
}

/**
 * Should dynamics.update() run this frame? Not while paused, and not while the
 * art pass holds the scene still (a random exit empties the canvas before the
 * landscape moves again) or its reveal plays (the reveal is painted to the end;
 * skipping the update skips the attention poll that would fire 'unfreeze'). A
 * finished painting needs no gate: a frozen update() polls attention every
 * frame, which is how a restless room wakes it.
 */
export function shouldAdvanceDynamics(paused, artPass) {
  return !paused && !artPass.holdsSceneStill() && !artPass.isRevealPlaying()
}

/**
 * Does the art pass need frames while the render loop's pause-skip would
 * otherwise return early? True while its reveal or exit animation plays; both
 * run on the wall clock, not the simulation's.
 */
export function isArtPassAnimating(artPass) {
  return artPass.isRevealPlaying() || artPass.isExitPlaying()
}

/**
 * Is the world holding still, so every cache keyed on it (the art pass's edge
 * field, ground and G-buffer, the terrain data map, water's pre-passes, the
 * cloud volume) stays valid? True while the sim is frozen or paused, the camera
 * has not moved, and no debug control was touched (`dirty`). `dirty` is what
 * lets a slider act on a frozen scene: without it the passes that read the
 * slider would be skipped as redundant.
 *
 * Code that writes uniforms directly while the world holds still must raise
 * `dirty` itself (main.js's freezeForm and the cost measure do). The weather
 * and form walks need not: they step by noiseSpeed, which is 0 while frozen.
 *
 * Returns the boolean only; main.js applies it in the render-pass order.
 */
export function computeSceneStatic(paused, camMoved, dynamics, dirty = false) {
  return (dynamics.isFrozen() || paused) && !camMoved && !dirty
}
