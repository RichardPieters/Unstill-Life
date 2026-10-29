// erosion.glsl — Advanced terrain erosion filter (stacked faded gullies).
//
// Ported from Rune Skovbo Johansen's Shadertoy (https://www.shadertoy.com/view/wXcfWn),
// see https://blog.runevision.com/2026/03/fast-and-gorgeous-erosion-filter.html
// Phacelle Noise and Erosion Filter are MPL-2.0 — license headers preserved below.
// Injected into heightmap.frag by terrain.js. Self-contained: it has its own hash
// and needs nothing from noise.glsl.

#define EROSION_TAU 6.28318530717959

// Hash from the original shader's Common tab.
vec2 erosionHash(in vec2 x) {
  const vec2 k = vec2(0.3183099, 0.3678794);
  x = x * k + k.yx;
  return -1.0 + 2.0 * fract(16.0 * k * fract(x.x * x.y * (x.x + x.y)));
}

// The Simple Phacelle Noise function produces a stripe pattern aligned with the input vector.
// The name Phacelle is a portmanteau of phase and cell, since the function produces a phase by
// interpolating cosine and sine waves from multiple cells.
//  - p is the input point being evaluated.
//  - normDir is the direction of the stripes at this point. It must be a normalized vector.
//  - freq is the freqency of the stripes within each cell (best kept close to 1.0).
//  - offset is the phase offset of the stripes, where 1.0 is a full cycle.
//  - normalization is the degree of normalization applied, between 0 and 1.
// Phacelle Noise function copyright (c) 2025 Rune Skovbo Johansen
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
vec4 PhacelleNoise(in vec2 p, vec2 normDir, float freq, float offset, float normalization) {
  vec2 sideDir = normDir.yx * vec2(-1.0, 1.0) * freq * EROSION_TAU;
  offset *= EROSION_TAU;

  vec2 pInt = floor(p);
  vec2 pFrac = fract(p);
  vec2 phaseDir = vec2(0.0);
  float weightSum = 0.0;
  for (int i = -1; i <= 2; i++) {
    for (int j = -1; j <= 2; j++) {
      vec2 gridOffset = vec2(i, j);
      vec2 gridPoint = pInt + gridOffset;
      vec2 randomOffset = erosionHash(gridPoint) * 0.5;
      vec2 vectorFromCellPoint = pFrac - gridOffset - randomOffset;

      float sqrDist = dot(vectorFromCellPoint, vectorFromCellPoint);
      float weight = exp(-sqrDist * 2.0);
      weight = max(0.0, weight - 0.01111);
      weightSum += weight;

      float waveInput = dot(vectorFromCellPoint, sideDir) + offset;
      phaseDir += vec2(cos(waveInput), sin(waveInput)) * weight;
    }
  }

  vec2 interpolated = phaseDir / weightSum;
  float magnitude = sqrt(dot(interpolated, interpolated));
  magnitude = max(1.0 - normalization, magnitude);
  return vec4(interpolated / magnitude, sideDir);
}

// ─── Erosion filter utilities ─────────────────────────────────────────────────

float erosion_pow_inv(float t, float power) {
  return 1.0 - pow(1.0 - clamp(t, 0.0, 1.0), power);
}

float erosion_ease_out(float t) {
  float v = 1.0 - clamp(t, 0.0, 1.0);
  return 1.0 - v * v;
}

float erosion_smooth_start(float t, float smoothing) {
  if (t >= smoothing)
    return t - 0.5 * smoothing;
  return 0.5 * t * t / smoothing;
}

vec2 erosion_safe_normalize(vec2 n) {
  float l = length(n);
  return (abs(l) > 1e-10) ? (n / l) : n;
}

// Advanced Terrain Erosion Filter copyright (c) 2025 Rune Skovbo Johansen
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
const int EROSION_MAX_OCTAVES = 6;
vec4 ErosionFilter(
    // Input parameters that vary per pixel.
    in vec2 p, vec3 heightAndSlope, float fadeTarget,
    // Phase offset of the gully stripes (port addition: animated via noiseTime
    // so the fine relief evolves — the original used a fixed 0.25).
    float gullyPhase,
    // Port addition: scales the fade-toward-fadeTarget term. In the original,
    // gullies fade to ±1 at flat spots (slope→0) with FULL magnitude while the
    // gully term is scaled by gullyWeight — at low gullyWeight this deliberately
    // "sharpens peaks" (author's comment), which reads as summit needle spikes
    // at our scale. 1 = original behaviour, 0 = gullies fade to zero instead.
    float peakPreserve,
    // Stylistic parameters that may vary per pixel.
    float strength, float gullyWeight, float detail, vec4 rounding, vec4 onset, vec2 assumedSlope,
    // Scale related parameters that do not support variation per pixel.
    float scale, float octaves, float lacunarity,
    // Other parameters.
    float gain, float cellScale, float normalization,
    // Output parameters.
    out float ridgeMap, out float debugOut
) {
  strength *= scale;
  fadeTarget = clamp(fadeTarget, -1.0, 1.0);

  vec3 inputHeightAndSlope = heightAndSlope;
  float freq = 1.0 / (scale * cellScale);
  float slopeLength = max(length(heightAndSlope.yz), 1e-10);
  float magnitude = 0.0;
  float roundingMult = 1.0;

  float roundingForInput = mix(rounding.y, rounding.x, clamp(fadeTarget + 0.5, 0.0, 1.0)) * rounding.z;
  // The combined accumulating mask, based first on initial slope, and later on slope of each octave too.
  float combiMask = erosion_ease_out(erosion_smooth_start(slopeLength * onset.x, roundingForInput * onset.x));

  // Initialize the ridgeMap fadeTarget and mask.
  // Port deviation: the original seeds this with
  // fadeTarget = normalised base ALTITUDE, which leaks through wherever the
  // slope masks never fire — flat saddles and smooth flanks then read as
  // "+1 ridge" (a crease bottom between two mountains rendered white).
  // Seeding neutral makes the ridge map a pure local gully-phase signal:
  // + inter-gully ribs, − gully floors, 0 where erosion is inactive.
  float ridgeMapCombiMask = erosion_ease_out(slopeLength * onset.z);
  float ridgeMapFadeTarget = 0.0;

  // Strength of the initial slope used for gully directions,
  // as a mix of the actual slope and an assumed slope.
  vec2 gullySlope = mix(heightAndSlope.yz, heightAndSlope.yz / slopeLength * assumedSlope.x, assumedSlope.y);

  for (int i = 0; i < EROSION_MAX_OCTAVES; i++) {
    if (float(i) >= octaves) break;

    // Calculate and add gullies to the height and slope.
    vec4 phacelle = PhacelleNoise(p * freq, erosion_safe_normalize(gullySlope), cellScale, gullyPhase, normalization);
    // Multiply with freq since p was multiplied with freq. Negate: slopes point down.
    phacelle.zw *= -freq;
    float sloping = abs(phacelle.y);

    // Add non-masked, normalized slope to gullySlope, for use by subsequent octaves.
    gullySlope += sign(phacelle.y) * phacelle.zw * strength * gullyWeight;

    // Gullies has height offset (from -1 to 1) in x and derivative in yz.
    vec3 gullies = vec3(phacelle.x, phacelle.y * phacelle.zw);
    vec3 fadedGullies = mix(vec3(fadeTarget * peakPreserve, 0.0, 0.0), gullies * gullyWeight, combiMask);
    heightAndSlope += fadedGullies * strength;
    magnitude += strength;

    fadeTarget = fadedGullies.x;

    float roundingForOctave = mix(rounding.y, rounding.x, clamp(phacelle.x + 0.5, 0.0, 1.0)) * roundingMult;
    float newMask = erosion_ease_out(erosion_smooth_start(sloping * onset.y, roundingForOctave * onset.y));
    combiMask = erosion_pow_inv(combiMask, detail) * newMask;

    ridgeMapFadeTarget = mix(ridgeMapFadeTarget, gullies.x, ridgeMapCombiMask);
    float newRidgeMapMask = erosion_ease_out(sloping * onset.w);
    ridgeMapCombiMask = ridgeMapCombiMask * newRidgeMapMask;

    strength *= gain;
    freq *= lacunarity;
    roundingMult *= rounding.w;
  }

  ridgeMap = ridgeMapFadeTarget * (1.0 - ridgeMapCombiMask);
  debugOut = fadeTarget;

  vec3 heightAndSlopeDelta = heightAndSlope - inputHeightAndSlope;
  return vec4(heightAndSlopeDelta, magnitude);
}
