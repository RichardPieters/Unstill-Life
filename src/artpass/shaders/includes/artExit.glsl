/**
 * artExit.glsl — when a stroke leaves: the exit rule, shared by the program that
 * takes the painting apart and the one that counts what has gone.
 *
 * The strokes are a STILL IMAGE and the landscape under them is not: once the
 * scene starts moving again the two disagree, and the painting has to go. This
 * answers, for one stroke at one moment of the exit, how much of it is gone. The
 * dissolve pass (artDissolve.frag) asks it per pixel of the held picture; the
 * count pass (artExitCount.frag) asks it per stroke of the lattice, so the
 * sound can follow the strokes actually leaving. One rule in one place means
 * the two cannot disagree.
 *
 * RULES   Chosen by `paint just disappears at random`.
 *         RANDOM: a stroke's moment is its own draw; the landscape is not
 *         consulted and the painting thins out evenly everywhere.
 *         DRIFT (default): a stroke is kept while what it was painted from is
 *         still roughly there, so the picture comes apart where the scene is
 *         busiest and holds together where it is calm.
 *
 * DOT BY DOT  A stroke goes whole and at once: its pixels share one draw, one
 *         moment and a short ramp (`uExitSoftness`, a few frames), never a
 *         slow blend toward transparent.
 *
 * BACKSTOP  Only DRIFT needs one: nothing guarantees a calm passage ever
 *         crosses its drift threshold. Past `uExitSweep` (a point in progress,
 *         not a duration) whatever is STILL standing switches to the RANDOM
 *         rule's per-stroke draw for the remainder, confined to [sweepStart, 1]
 *         instead of [groundBeat, 1], so the survivors go one by one, each on
 *         its own moment. RANDOM needs none: its own draw finishes every stroke
 *         by the end of the exit. The draws are scaled to [.., 1 - softness] so
 *         every stroke's ramp has finished BY progress 1.
 *
 * The caller keeps a stroke gone once it has gone (the drift measure is not
 * monotonic: the scene can drift back toward its original colour), see the
 * ratchet in artDissolve.frag and artExitCount.frag.
 */

uniform sampler2D uHeldBeauty;    // the frame the picture was painted from
uniform sampler2D uBeauty;        // the live frame, moving again

uniform float uExitRandom;       // 1 = each stroke goes at its own random
                                  // moment; 0 = the landscape's drift decides
uniform float uExitThreshold;    // drift a stroke survives, frame colour units
uniform float uExitJitter;       // spread on that, per stroke
uniform float uExitSoftness;     // how abruptly one stroke goes
uniform float uExitProgress;     // 0 at the start of the exit, 1 at its end
uniform float uExitSweep;        // where the DRIFT rule hands over to the draw
uniform float uExitGroundBeat;   // fraction of the exit spent settling the
                                  // surface between strokes before any mark
                                  // may start to go

/**
 * How much of the bare surface between strokes has gone over to the live frame.
 *
 * A pixel the lattice never painted has no stroke, so no draw to go on. Sent
 * through the per-stroke formula it would clamp to a draw of 0 and give EVERY
 * gap pixel the same moment: the whole surface between strokes would snap from
 * its held look to the live frame in one synchronised step. It takes a
 * deterministic step instead, evenly across the surface, in the first
 * `uExitGroundBeat` of the exit. That beat is also the EARLIEST moment a RANDOM
 * stroke may go, so the ground settles into the moving world and only then
 * does the paint on top of it come apart, as on a real canvas.
 */
float groundGone() {
  return smoothstep(0.0, max(uExitGroundBeat, 1e-4), uExitProgress);
}

/**
 * How much of a stroke has gone, [0,1].
 *
 * @param draw      the stroke's id, a hash in [0,1) (artPaint.frag's paint
 *                  order, the same per-cell draw): genuinely per-stroke, so it
 *                  needs no further hashing
 * @param anchorUv  where the stroke was painted from. Drift is measured THERE,
 *                  not at whichever pixel is asking: the landscape drifts
 *                  continuously, so sampling it per pixel would let one side of
 *                  a stroke cross the threshold before the other.
 */
float strokeGone(float draw, vec2 anchorUv) {
  float softness = max(uExitSoftness, 1e-4);
  if (uExitRandom > 0.5) {
    float when = mix(max(uExitGroundBeat, 1e-4), 1.0 - softness, draw);
    return smoothstep(0.0, softness, uExitProgress - when);
  }

  vec3 was = frameAt(uHeldBeauty, anchorUv);
  vec3 now = frameAt(uBeauty, anchorUv);
  float drift = length(now - was);
  float tolerance = uExitThreshold * mix(1.0 - uExitJitter, 1.0 + uExitJitter, draw);
  float gone = smoothstep(0.0, softness, drift - tolerance);

  // The backstop. Before sweepStart this is identically 0 for every stroke
  // (sweepWhen >= sweepStart >= progress), so it never interferes with drift
  // while drift still has room to work.
  float sweepStart = clamp(uExitSweep, 0.02, 0.95);
  float sweepWhen = mix(sweepStart, 1.0 - softness, draw);
  return max(gone, smoothstep(0.0, softness, uExitProgress - sweepWhen));
}
