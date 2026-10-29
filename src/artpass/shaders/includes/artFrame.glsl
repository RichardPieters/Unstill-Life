/**
 * artFrame.glsl — the rendered frame, as the colour engine and the exit rule
 * read it.
 *
 * The composited buffer is half-float with no tone mapping in front of it, so
 * it can hold values outside [0,1]. strokeColour's toLinear() raises its input
 * to the 2.4 — NaN for a negative base — and a single NaN stroke colour spreads
 * through every mix it touches; a growth or drift measure on an overshooting
 * channel would swamp every other comparison. Clamping restores the 8-bit
 * domain every consumer assumes, and doing it here means no program reads the
 * frame unclamped by forgetting to.
 */

/** The frame at `uv`, with the mip level the sampler picks. */
vec3 frameAt(sampler2D frame, vec2 uv) {
  return clamp(texture(frame, uv).rgb, 0.0, 1.0);
}

/** The frame at `uv` at an explicit mip level: a stroke reads it blurred, so it
 *  carries a shape and not the terrain's per-pixel detail. */
vec3 frameLod(sampler2D frame, vec2 uv, float lod) {
  return clamp(textureLod(frame, uv, lod).rgb, 0.0, 1.0);
}
