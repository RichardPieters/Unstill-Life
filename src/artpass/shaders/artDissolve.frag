/**
 * artDissolve.frag — the painting comes apart as the landscape resumes.
 *
 * INPUTS  the held lattice (RGB the painted picture, ALPHA its thickness);
 *         `uHeldId` (R the stroke id, GB the stroke's anchor uv — the paint
 *         buffer's second attachment, frozen); and `uPrevDissolved`, this
 *         pass's own previous output (see MONOTONIC). Where paint survives, the
 *         held picture stands; where it has gone, the live frame shows
 *         through, so the painting dissolves back into the moving world rather
 *         than into bare canvas. WHEN a stroke goes is artExit.glsl's rule.
 *
 * PER STROKE  `uHeldId`'s red channel is the exact id artPaint.frag assigned
 *         the WINNING stroke at each pixel. Every pixel of a stroke — rim
 *         included, up to where a different stroke's coverage crosses 50% and
 *         wins the pixel — carries that stroke's id and nothing else's, so the
 *         whole mark draws once and goes together. (An id reconstructed from
 *         the colour buffer breaks on antialiased rims, and cannot tell
 *         overlapping strokes apart.) The GB channels are the same stroke's
 *         anchor uv.
 *
 * MONOTONIC  The drift measure is not monotonic in time, so without memory a
 *         stroke that had gone could reappear. Survival this frame is capped
 *         at what survived last frame (read from `uPrevDissolved`): once gone,
 *         always gone.
 *
 * GAPS    A pixel the lattice never painted carries NO_STROKE_ID and settles
 *         in the exit's ground beat (artExit.glsl's groundGone).
 */

//#include format
//#include frame
//#include exit

in  vec2 vUv;
out vec4 fragColor;

uniform sampler2D uHeldPaint;     // the frozen lattice: RGB picture, A thickness
uniform sampler2D uHeldId;        // R the stroke id, GB its anchor uv
uniform sampler2D uPrevDissolved; // this pass's own output, one frame ago

// A pixel owns a stroke when its id is above the midpoint between NO_STROKE_ID
// and the lowest real id (0).
const float NO_STROKE = 0.5 * NO_STROKE_ID;

void main() {
  vec4 held = texture(uHeldPaint, vUv);
  vec4 idData = texture(uHeldId, vUv);
  vec3 now = frameAt(uBeauty, vUv);

  float gone = (idData.r > NO_STROKE)
    ? strokeGone(clamp(idData.r, 0.0, 1.0), idData.gb)
    : groundGone();

  // Ratchet: never let survival rise back above what already survived last
  // frame. held.a is the FROZEN thickness (constant across the whole exit), so
  // dividing the previous frame's own output alpha by it recovers exactly the
  // survival fraction that frame produced, with no separate buffer to carry it
  // in.
  float prevSurvival = held.a > 1e-5
    ? clamp(texture(uPrevDissolved, vUv).a / held.a, 0.0, 1.0)
    : 1.0;
  float survival = min(1.0 - gone, prevSurvival);

  // Thickness goes with the paint, so artFinish.frag stops lighting relief
  // that is no longer there rather than embossing the live landscape.
  fragColor = vec4(mix(now, held.rgb, survival), held.a * survival);
}
