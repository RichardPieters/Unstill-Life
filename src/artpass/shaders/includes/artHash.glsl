/**
 * artHash.glsl — the per-cell random source the whole art pass is built on.
 *
 * Fixed per cell and NEVER animated. This is what makes the paint stable: a
 * stroke's jitter, its pigment family, its render order, its rim wobble and its
 * thickness are all drawn from here, so as long as its cell index and the scene
 * under it are unchanged, the stroke reproduces exactly. A drifting random
 * source would make the whole canvas crawl between frames.
 *
 * It is also why every slider that adds strokes adds them ONE AT A TIME: a
 * fixed hash compared against a rising threshold crosses each cell's own value
 * at its own moment, scattered over the frame, instead of popping a whole
 * region in together.
 *
 * Its own file because both artColour.glsl and artNoise.glsl need it, and the
 * finish pass needs the noise without wanting the pigment engine.
 */

float hash1(vec2 c, float s) {
  return fract(sin(dot(c + s, vec2(127.1, 311.7))) * 43758.5453);
}

vec2 hash2(vec2 c, float s) {
  return vec2(hash1(c, s), hash1(c, s + 17.13));
}
