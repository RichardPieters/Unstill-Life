// cloudVolumeBake.frag — pass 1 of the baked cloud volume: the density field on
// a regular grid, one horizontal layer per draw, into the shape volume
// (cloudsVolume.js). One fullscreen quad per layer.
//
// STORED: the raw signed fBM, not the thresholded density. The threshold
// (`max(fbm*scale - coverage, 0)`) is applied after the hardware trilinear
// filter, in the light pass and the march, so the density and coverage sliders
// never re-bake this volume and the sub-threshold gradient survives filtering.
//
// NOT STORED: waves shorter than two cells (wavelength ~1.7021/frequency).
// cloudVolumeMath.safeOctaveCount derives uOctaves from that; a finer octave
// would add aliasing no filtering removes.
//
// noise.glsl injected by cloudsVolume.js

// Toroidal window: texel t holds the cloud-space cell, inside the current
// window [origin, origin + resolution), whose index is congruent to t modulo
// the resolution. uOriginCell moves by whole cells with the wind and camera, so
// a drift step re-indexes the grid instead of resampling it.
uniform vec2  uOriginCell;   // window min-corner cell index, integers as floats
uniform float uResolution;   // texels per horizontal axis
uniform float uLayers;       // texels on the vertical axis
uniform float uLayer;        // which layer this draw writes
uniform float uCellSize;     // world units per horizontal cell

uniform float uCloudLevel;   // world-Y of the shell's bottom
uniform float uCloudHeight;  // shell thickness

// The point every frequency-sensitive sample (the base fBM, the Worley erosion)
// is taken relative to. A rescale `snoise(p*freq)` moves everything by
// `p * deltaFreq`, so with p measured from the world origin a scatter nudge
// would move clouds by an amount that grows with how far the wind has carried
// the window. The anchor puts the fixed point at the window, bounding the shift
// by the window's size.
//
// Moving the anchor must not move the field: _moveAnchor (cloudsVolume.js) adds
// `(A_new - A_old) * f` to uFreqPhase / uWorleyPhase, so `(p - A) * f + phase`
// is unchanged for every p.
uniform vec2  uFreqAnchor;
uniform vec2  uFreqPhase;     // base fBM, in noise-space units (xz)
uniform vec2  uWorleyPhase;   // Worley erosion, in its own noise-space units (xz)

// Single fBM: one band whose every octave clears the grid's limit.
uniform float uBaseFreq;
uniform float uLacunarity;
uniform float uGain;
uniform float uAmpNorm;      // 1 / sum(amplitudes), so peak |fBM| stays ~1
uniform int   uOctaves;
// Weight on the last baked octave (index uOctaves-1). It fades to 0 as its
// frequency nears the grid's limit (octaveEdgeCloseness) while
// cloudsVolume.frag's detailFbm fades in a marched term of the same frequency
// and amplitude.
uniform float uLastOctaveWeight;

// Curl-noise warp of the sample position before the fBM: swirl instead of a
// pure translation. A function of the cell's own position, so incremental
// re-bakes stay valid. The warp raises the local frequency by about
// (1 + uCurlStrength * uCurlFreq * |gradient|), which can push a safe octave past
// the grid's limit, and baked that is a permanent moiré: keep uCurlStrength well
// below the curl field's wavelength (past half of it the warp folds space).
// Horizontal only: every layer gets the same warp.
uniform float uCurlFreq;
uniform float uCurlStrength;

vec2 curlNoise(vec2 p) {
  vec3 grad;
  // Fixed z so this samples a DIFFERENT part of the noise field than the
  // base fBM above (which starts its own series at p*uBaseFreq) — otherwise
  // the warp would correlate with the very field it's warping.
  snoise_grad(vec3(p * uCurlFreq, 91.7), grad);
  // Divergence-free by construction: grad is ∇ψ for ψ(x,y)=snoise(x,y,const),
  // and (∂ψ/∂y, -∂ψ/∂x) is the standard curl-noise rotation of a scalar
  // potential's gradient (Bridson) — swirly, incompressible-looking
  // displacement instead of the directional bias a raw gradient would give.
  return vec2(grad.y, -grad.x);
}

// ── Worley erosion (the "Perlin-Worley" technique of Schneider & Vos, HZD SIGGRAPH15) ──
// The smooth field above is simplex noise, standing in for the Perlin noise of
// the original technique. On its own it gives rounded blobs; Worley (cellular)
// noise bites into the blobs' low-density edges for a billowy look: the
// standard remap by erosion.
uniform float uWorleyFreq;
uniform float uWorleyAmount;
uniform float uWorleyErosion;
uniform int   uWorleyOctaves;

const int WORLEY_OCTAVES_HARD_CAP = 3;

// Inigo Quilez's sine hash (the constants of his hash33).
vec3 _worleyHash(vec3 p) {
  p = vec3(dot(p, vec3(127.1, 311.7, 74.7)),
           dot(p, vec3(269.5, 183.3, 246.1)),
           dot(p, vec3(113.5, 271.9, 124.6)));
  return fract(sin(p) * 43758.5453123);
}

/** 3D Worley F1: distance from `p` to the nearest of one jittered feature point per unit cell. */
float worleyF1(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  float minDist = 1.0e6;
  for (int x = -1; x <= 1; x++)
  for (int y = -1; y <= 1; y++)
  for (int z = -1; z <= 1; z++) {
    vec3 neighbor = vec3(float(x), float(y), float(z));
    vec3 point = _worleyHash(i + neighbor);
    minDist = min(minDist, length(neighbor + point - f));
  }
  return minDist;
}

/**
 * fBM of (1 - Worley F1), normalised to [0,1]: ~1 at the feature points, ~0 on
 * the cell walls. erodeByWorley negates it, so the carve bites hardest on the
 * walls and leaves cloud standing on the feature points (billows); the other
 * sign leaves the walls standing, a lace that flattens into a grey sheet.
 *
 * Worley's grid limit is feature spacing (at least two cells), not wavelength;
 * _recomputeGrid clamps the octaves with safeWorleyOctaveCount.
 */
float worleyFbm(vec3 p, int octaves) {
  float sum = 0.0;
  float ampSum = 0.0;
  float amp = 1.0;
  float freq = 1.0;
  for (int i = 0; i < WORLEY_OCTAVES_HARD_CAP; i++) {
    if (i >= octaves) break;
    sum += (1.0 - clamp(worleyF1(p * freq), 0.0, 1.0)) * amp;
    ampSum += amp;
    amp *= 0.5;
    freq *= 2.0;
  }
  return ampSum > 0.0 ? sum / ampSum : 0.0;
}

/**
 * Mean of worleyFbm over the field, for the centring in erodeByWorley
 * (GPU-measured 0.4769 / 0.4789 / 0.4801 for 1 / 2 / 3 octaves; scale-invariant).
 * It goes stale if the Worley construction changes; cloud_impl.spec.js pins the
 * invariant it protects.
 */
const float WORLEY_FBM_MEAN = 0.478;

/**
 * Worley erosion: remap(base01, lo, 1, 0, 1), clamped, with the mean-centred
 * threshold lo = (WORLEY_FBM_MEAN - worley01) * uWorleyErosion.
 *
 * Centred, not the textbook `lo = worley01 * erosion`: that lo is never
 * negative, so the remap only pulls samples down toward the top of the range and
 * the field's mean sinks (measured -0.03 to -0.43 across the amount slider,
 * taking 92% of the cloud alpha), which reads as the clouds shrinking rather
 * than eroding. Centred, lo is negative at the feature points and positive on
 * the cell walls, so the carve trades material between them: the mean holds
 * within ~0.01, and the amount slider changes the field's character, not its
 * coverage. The max(..., 1e-4) guard is never reached (lo peaks near 0.41).
 */
float erodeByWorley(float base01, float worley01) {
  float lo = (WORLEY_FBM_MEAN - worley01) * uWorleyErosion;
  return clamp((base01 - lo) / max(1.0 - lo, 1e-4), 0.0, 1.0);
}

// Compile-time loop bound, with the uniform doing the real trip count (the
// portable pattern; the *_HARD_CAP consts elsewhere do the same).
const int OCTAVES_HARD_CAP = 8;

varying vec2 vUv;

void main() {
  // gl_FragCoord.xy is the texel this invocation writes; mod() folds the
  // window origin back onto it to recover the cloud-space cell. GLSL's mod is
  // non-negative for a positive divisor, so this is correct for the negative
  // cell indices the window reaches west/north of the origin.
  vec2 texel = floor(gl_FragCoord.xy);
  vec2 cell  = uOriginCell + mod(texel - uOriginCell, uResolution);

  vec3 p;
  p.xz = (cell + 0.5) * uCellSize;                                  // cell centre
  p.y  = uCloudLevel + (uLayer + 0.5) / uLayers * uCloudHeight;     // layer centre

  // Curl noise samples the TRUE absolute position, unrecentred — its own
  // frequency (uCurlFreq) never changes with scatter, so it cannot itself
  // cause the sliding this fix is for, and recentring its INPUT would only
  // make the swirl pattern jump every time the anchor below refreshes, for no
  // benefit.
  p.xz += curlNoise(p.xz) * uCurlStrength;

  // Recentred AFTER the warp is added, not before: the warp's own bounded
  // displacement (order uCurlStrength) rides along with whichever term below
  // reads `pr`, and since it is bounded either way, doing the subtraction
  // here rather than earlier changes nothing about how large `pr` can get.
  vec3 pr = p;
  pr.xz -= uFreqAnchor;

  float v = 0.0;
  float amp = 1.0;
  vec3 q = pr * uBaseFreq;
  q.xz += uFreqPhase;
  for (int i = 0; i < OCTAVES_HARD_CAP; i++) {
    if (i >= uOctaves) break;
    // Only the LAST iteration is ever weighted below 1 — see uLastOctaveWeight.
    float w = (i == uOctaves - 1) ? uLastOctaveWeight : 1.0;
    v += amp * w * snoise(q);
    amp *= uGain;
    q *= uLacunarity;
  }
  v *= uAmpNorm;

  float shape = v;
  // No octave at all (a grid too coarse for any: cloudsVolume.js's
  // _recomputeGrid) leaves the smooth field untouched; worleyFbm would return
  // 0 there, which the erosion reads as a hole in the Worley field.
  if (uWorleyAmount > 0.0 && uWorleyOctaves > 0) {
    float base01 = v * 0.5 + 0.5;
    // Same recentred coordinate — uWorleyFreq is exactly the same class of
    // rescale as uBaseFreq, and invalidates the shape the same way, so it
    // needs the identical fix or a worley-frequency change would still slide
    // the erosion pattern even after the base fBM stopped moving.
    vec3 qw = pr * uWorleyFreq;
    qw.xz += uWorleyPhase;
    float worley01 = worleyFbm(qw, uWorleyOctaves);
    float carved01 = erodeByWorley(base01, worley01);
    shape = mix(v, carved01 * 2.0 - 1.0, uWorleyAmount);
  }

  gl_FragColor = vec4(shape, 0.0, 0.0, 1.0);
}
