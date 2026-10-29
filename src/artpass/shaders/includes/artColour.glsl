/**
 * artColour.glsl — the divisionist colour engine.
 *
 * Spliced into artPaint.frag by artPassMaterials.js, after artHash.glsl. It is
 * a separate file because the whole design rests on the mixture's weighted mean
 * returning the target exactly, and that part wants to live in one place.
 */

// Uniforms the colour engine needs, declared with it.
uniform sampler2D uLutIdx;     // pigment indices, nearest
uniform sampler2D uLutWts;     // their area fractions
uniform vec3  uPigment[16];    // palette, linear light
uniform float uPigmentCount;
uniform float uLutN;
uniform float uTint;           // within-family, toward white / toward shade
uniform float uLoad;           // within-family, toward raw pigment / toward grey
uniform float uDarkQuiet;      // spread falls toward the darks

const float SKEW = 2.2;
const float SKEW_MEAN = 1.0 / (SKEW + 1.0);

// ─── colour space ────────────────────────────────────────────────────────────
// Optical mixing is an average of radiance, so every mix happens in linear
// light. Only the final result goes back to sRGB.
vec3 toLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}
vec3 toSrgb(vec3 c) {
  c = max(c, 0.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

// hash1 / hash2 come from artHash.glsl, spliced before this.

// Skewed, exactly zero-mean draw. Piles most strokes onto their family colour
// with a thin tail, and subtracting the known mean of u^SKEW keeps the
// expectation at zero so the mixture's average is untouched. A symmetric draw
// would send half of every family away from white — the too-dark strokes.
float skew(float u) { return pow(u, SKEW) - SKEW_MEAN; }

vec3 pigmentAt(int i) {
  for (int k = 0; k < 16; k++) if (k == i) return uPigment[k];
  return vec3(0.5);
}

// ─── the mixture at one point ────────────────────────────────────────────────
// Returns the stroke's colour. `C` is the target; the lookup says which
// pigments and in what proportion; the pick is dithered by the cell's own fixed
// threshold so the counts match the weights.
vec3 strokeColour(vec3 Csrgb, vec2 cell, float kSeg) {
  vec3 C = toLinear(Csrgb);

  // Nearest lookup: pigment indices cannot be interpolated, and they need not
  // be — the re-centring below makes the average exact for whatever set arrives.
  float N = uLutN;
  vec3 q = clamp(floor(Csrgb * (N - 1.0) + 0.5), 0.0, N - 1.0);
  float px = q.z * N + q.x;
  vec2 uv = (vec2(px, q.y) + 0.5) / vec2(N * N, N);
  vec4 ids = texture(uLutIdx, uv) * 255.0;
  vec4 wts = texture(uLutWts, uv);

  float wsum = wts.x + wts.y + wts.z + wts.w;
  if (wsum < 1e-4) return Csrgb;
  wts /= wsum;

  // P̄, the weighted centroid of the chosen pigments.
  vec3 bar = vec3(0.0);
  bar += wts.x * pigmentAt(int(ids.x + 0.5));
  bar += wts.y * pigmentAt(int(ids.y + 0.5));
  bar += wts.z * pigmentAt(int(ids.z + 0.5));
  bar += wts.w * pigmentAt(int(ids.w + 0.5));

  // Pick one family. Cumulative weights against a fixed per-cell threshold.
  float t = hash1(cell, 5.11);
  int   pick = int(ids.x + 0.5);
  float acc = wts.x;
  if (t >= acc) { pick = int(ids.y + 0.5); acc += wts.y;
    if (t >= acc) { pick = int(ids.z + 0.5); acc += wts.z;
      if (t >= acc) { pick = int(ids.w + 0.5); } } }
  vec3 p = pigmentAt(pick);

  // s = C + k(p − P̄). The weighted mean over the families returns to C exactly,
  // for any palette, any weights and any k — the palette sets only the
  // directions colour scatters in, and cannot move the average.
  // Spread falls toward the darks: the references keep their division in the
  // lights and mid-tones and let the darks go quiet.
  float lum = dot(C, vec3(0.2126, 0.7152, 0.0722));
  float k = kSeg * mix(1.0 - uDarkQuiet, 1.0, clamp(lum * 3.0, 0.0, 1.0));
  vec3 centre = C + k * (p - bar);

  // A family is a ramp, not a colour. The two moves a painter actually makes,
  // both hue-preserving because both endpoints share the family's hue.
  vec3 white = pigmentAt(int(uPigmentCount) - 1);
  vec2 j = hash2(cell, 91.7);
  centre += skew(j.x) * uTint * (white - centre);
  centre += skew(j.y) * uLoad * (p - centre);

  return toSrgb(centre);
}

