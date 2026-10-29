precision highp float;

// heightmap.frag — terrain data-map pass (erosion pipeline).
//
// Per frame: the dynamic fBM (drift + noiseTime) at reduced octaves forms the
// base heightmap; the runevision erosion filter carves gully detail on top and
// emits the ridge/erosion data layers. Erosion is re-evaluated on the animated
// base each frame, so the gully network migrates with the terrain.
//
// Output channels:
//   R — height (world units, erosion applied)
//   G — ridgeMap      (−1 creases … +1 ridges; 1.0 when erosion disabled)
//   B — erosionDelta  (normalised height delta / magnitude; 0.0 when disabled)
//   A — bedrock/mantle select (which field won the max)

varying vec2 vUv;

uniform float uPlaneSize;
uniform bool  uErosionEnabled;
uniform float uErosionTimeSpeed;     // gully-pattern phase drift per noiseTime unit
uniform float uErosionScale;
uniform float uErosionStrength;
uniform float uErosionGullyWeight;
uniform float uErosionDetail;
uniform float uErosionOctaves;
// Rounding of ridges/creases — the blog's anti-spike control. 0 = knife-sharp.
uniform float uErosionRidgeRound;
uniform float uErosionCreaseRound;
// Rounding multiplier on the input height function (rounding.z) — spike fix:
// must scale with how much lower-frequency the base fBM is than the gullies.
uniform float uErosionInputRound;
// Fade-to-target magnitude at flat spots (the filter's peak/valley sharpening).
// 1 = original filter; 0 = no summit cones at all.
uniform float uErosionPeakSharpen;

// Camera-safety pit — caps height near the fixed authored camera position so
// the terrain's own drift can never grow a peak up through it (fly
// mode is debug-only, so only this one static point needs the guarantee).
// uCamXZ is CAM_POSITION.xz (sceneConfig.js), never the live debug fly-cam.
uniform vec2  uCamXZ;
uniform float uCamPitRadius;  // world units — radius of the compression disc
uniform float uCamPitFloor;   // world units — height ceiling at the camera's own column
uniform float uCamPitEase;    // ease-out exponent — 1 = linear, higher = fast rise then long flat approach to uHeightMax
uniform float uHeightMax;     // global height ceiling — the disc blends out to this at uCamPitRadius

// Erosion constants (runevision demo values)
// Rounding zw: input-function multiplier, per-octave multiplier (= lacunarity
// for consistent rounding across octaves).
const vec4  EROSION_ONSET         = vec4(1.25, 1.25, 2.8, 1.5);
const vec2  EROSION_ASSUMED_SLOPE = vec2(0.7, 1.0);
const float EROSION_CELL_SCALE    = 0.7;
const float EROSION_NORMALIZATION = 0.5;
const float EROSION_LACUNARITY    = 2.0;
const float EROSION_GAIN          = 0.5;
// World-height ↔ normalised-height scale: H_NORM = (uFBM0Amp + uFBM1Amp) *
// H_NORM_PER_AMP (terrainMath.js; terrain.js writes the constant on the next
// line). The ratio puts the surface in the regime the filter's onset and
// rounding masks were tuned for; too steep a ratio saturates the ridge-map
// masks and paints creeks over the whole terrain. Tracking the amplitude sum
// keeps the normalised slope the erosion filter sees independent of the amp
// sliders.
// H_NORM_PER_AMP defined by terrain.js

// noise.glsl injected by terrain.js

// fbm.glsl injected by terrain.js

// erosion.glsl injected by terrain.js

// Baked into the height map itself (not the vertex/derive stage) so erosion,
// the derive-pass gradient/ring-means, and terrain.frag's biome/shoreline
// bands all read the SAME already-safe field — one number, one guarantee.
//
// This is a RESCALE, not a clip: everything from uCamPitFloor up to
// uHeightMax gets proportionally remapped into [uCamPitFloor, ceil(r)] —
// relief (ridges, noise) is compressed, never discarded, so the terrain near
// the camera keeps its own shape.
//
// At r=0, ceil==uCamPitFloor, so the scale factor is exactly 0 and the result
// is uCamPitFloor for ANY h — the safety guarantee. The trailing min() is only
// a backstop for h > uHeightMax (uHeightMax underestimating the true peak), so
// it almost never fires and normal terrain keeps its real shape.
//
// The ceiling follows an ease-out power curve (1-(1-t)^n): it rises toward
// uHeightMax fast, then holds a long flat approach to it, so the
// compressed-looking area stays well inside the radius while the radius itself
// can stay large (gentle world-space slope, no hard ring). n>=2 keeps the curve
// C1 at r=R (zero slope into the untouched field); n>=3 keeps it C2 too.
float applyCamPit(float h, vec2 xz) {
  if (h <= uCamPitFloor) return h;   // valleys/sea below the band — untouched
  float r     = length(xz - uCamXZ);
  float t     = clamp(r / max(uCamPitRadius, 1e-4), 0.0, 1.0);
  float ceilT = 1.0 - pow(1.0 - t, max(uCamPitEase, 1.0));
  float ceil  = mix(uCamPitFloor, uHeightMax, ceilT);
  float span  = max(uHeightMax - uCamPitFloor, 1e-4);
  float rescaled = uCamPitFloor + (h - uCamPitFloor) * (ceil - uCamPitFloor) / span;
  return min(rescaled, ceil);
}

void main() {
  vec2 xz = (vUv - 0.5) * uPlaneSize;

  if (!uErosionEnabled) {
    // Erosion off: the fBM height alone; ridge 1, erosion delta 0.
    vec2 lg;
    float lBedrock;
    float lh = getHeightAndGrad(xz, lg, lBedrock);
    gl_FragColor = vec4(applyCamPit(lh, xz), 1.0, 0.0, lBedrock);
    return;
  }

  // ── Base heightmap: dynamic fBM ───────────────────────────────────────────
  // The main octaves slider (uFBMxOctaves, default 3 while erosion supplies
  // the fine detail) drives the base directly — no separate cap.
  if (!uEnableBaseFBM) {
    // Base off = flat plane.
    gl_FragColor = vec4(applyCamPit(0.0, xz), 1.0, 0.0, 0.0);
    return;
  }
  vec2 xz0 = xz + uFBM0DriftOffset;   // instance-0 drift, reused by the erosion pass below

  // Single source (fbm.glsl): height + raw gradient, incl. per-instance ridge.
  // One sample per texel. The gradient is already the WINNING field's
  // (getHeightAndGrad selects it), so the erosion input follows the exposed
  // surface's slope, and the bedrock select is 0 or 1.
  vec2  gradWorld;
  float bedrockSel;
  float hWorld = getHeightAndGrad(xz, gradWorld, bedrockSel);

  // ── Normalised space for the erosion filter ───────────────────────────────
  // p spans ~[0,1] across the plane and rides instance-0 drift so gullies
  // move with the terrain. Slope converts via the chain rule (d/dp = d/dxz · size).
  // H_NORM scales with amplitude: gradWorld grows with amplitude, so a fixed norm
  // let tall ridges push the normalised slope past EROSION_ASSUMED_SLOPE and the
  // filter's ridge masks saturated → serrated crests. Tracking the amplitude sum
  // keeps hs (height + slope) in the regime the onset/rounding masks were tuned for.
  float H_NORM    = max((uFBM0Amp + uFBM1Amp) * H_NORM_PER_AMP, 1.0);
  vec2  p         = xz0 / uPlaneSize;
  vec3  hs        = vec3(hWorld / H_NORM, gradWorld * uPlaneSize / H_NORM);
  float baseAmp   = (uFBM0Amp + uFBM1Amp) / H_NORM;
  float fadeTarget = clamp(hs.x / max(baseAmp * 0.6, 1e-4), -1.0, 1.0);

  // Gully phase drifts with noiseTime so the fine relief is never still
  // (momentum-scaled evolution reaches the erosion layer too).
  float gullyPhase = 0.25 + uTime * uErosionTimeSpeed;

  float ridgeMap, debugOut;
  vec4 e = ErosionFilter(
    p, hs, fadeTarget, gullyPhase, uErosionPeakSharpen,
    uErosionStrength, uErosionGullyWeight, uErosionDetail,
    vec4(uErosionRidgeRound, uErosionCreaseRound, uErosionInputRound, 2.0), EROSION_ONSET, EROSION_ASSUMED_SLOPE,
    uErosionScale, uErosionOctaves, EROSION_LACUNARITY,
    EROSION_GAIN, EROSION_CELL_SCALE, EROSION_NORMALIZATION,
    ridgeMap, debugOut);

  float hFinal = (hs.x + e.x) * H_NORM;
  hFinal = applyCamPit(hFinal, xz);

  float erosionDelta = e.x / max(e.w, 1e-5);

  gl_FragColor = vec4(hFinal, ridgeMap, erosionDelta, bedrockSel);
}
