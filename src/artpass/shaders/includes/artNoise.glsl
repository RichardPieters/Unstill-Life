/**
 * artNoise.glsl — value noise and domain warping, for the paint surface.
 *
 * Everything here describes the PAINT, never the landscape. The depicted scene
 * arrives already rendered and the lattice is hash-driven, so this noise is
 * only ever the irregularity of a brush mark, the thickness of its load, and
 * the weave of the cloth underneath.
 *
 * Value noise rather than gradient noise: it is cheaper, and at the scale of a
 * brush mark the difference does not read. Depends on hash1/hash2 from
 * artHash.glsl, so it must be spliced after it.
 */

// Smooth value noise on the unit lattice. The quintic fade has zero first AND
// second derivative at the cell corners, so the lattice does not show up as a
// grid of creases once the result is differentiated for relief — which is
// exactly what happens downstream.
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = p - i;
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = hash1(i + vec2(0.0, 0.0), 0.0);
  float b = hash1(i + vec2(1.0, 0.0), 0.0);
  float c = hash1(i + vec2(0.0, 1.0), 0.0);
  float d = hash1(i + vec2(1.0, 1.0), 0.0);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

/** Ridged octaves. Returns roughly 0..1. */
float fbm2(vec2 p) {
  float s = 0.0, amp = 0.5;
  for (int i = 0; i < 4; i++) {
    s += amp * vnoise(p);
    p *= 2.03;                 // not exactly 2, so octaves do not align
    amp *= 0.5;
  }
  return s;
}

/** Two decorrelated fields, for warping a coordinate rather than a value. */
vec2 fbmVec(vec2 p) {
  return vec2(fbm2(p), fbm2(p + vec2(37.1, 11.7)));
}

/**
 * Domain warp: bend the space a shape is measured in, rather than the shape.
 *
 * A brush mark's outline is not a smooth curve offset by noise — it is a smooth
 * curve drawn through a medium that pushed it around. Warping the coordinate
 * reproduces that: lobes, pinches and the occasional near-severed tail all fall
 * out of one displacement field, and the SAME warp applied to the thickness
 * profile keeps the relief registered with the outline instead of sliding
 * underneath it.
 */
vec2 warp(vec2 p, float amount, float scale, vec2 seed) {
  if (amount <= 0.0) return p;
  vec2 n = fbmVec(p / max(scale, 0.05) + seed) - 0.5;
  return p + n * amount * 2.0;
}

// ─── the canvas ──────────────────────────────────────────────────────────────
uniform float uWeave;          // canvas grain showing through the paint
uniform float uWeaveScale;

/**
 * The woven ground, as a surface rather than a tint.
 *
 * Two sines alone read as a regular cross-hatch — a machine grid, not linen. So
 * each thread wobbles and the fibre noise carries most of the contrast, which
 * breaks the lattice up without costing another octave.
 *
 * ONE definition, used twice: the stroke pass tints what shows between the
 * marks with it, and the finish pass displaces the surface by it, so the
 * visible grain and the relief that catches the light describe the same cloth.
 */
float weaveAt(vec2 frag) {
  vec2 p = frag / max(uWeaveScale, 0.5);
  float wob = hash1(floor(p.yx), 5.1) - 0.5;
  float warpT = sin((p.x + wob * 0.4) * 3.14159) * 0.5 + 0.5;
  float weft  = sin((p.y - wob * 0.4) * 3.14159) * 0.5 + 0.5;
  float fibre = hash1(floor(p), 3.7);
  return mix(mix(warpT, weft, 0.5), fibre, 0.22) * 0.5 + 0.5;
}
