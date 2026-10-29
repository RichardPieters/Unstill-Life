// cloudsVolume.frag — pass 3 of the baked cloud volume: the per-pixel march.
//
// Slab intersection, terrain-depth occlusion, Henyey-Greenstein phase and
// in-scatter accumulation, then the shading tail (cloudShade.glsl). Density and
// sun transmittance come from one trilinear fetch of the baked volume per step,
// plus noise only for the octaves the grid cannot hold. A per-pixel noise march
// measured ~525 snoise per pixel at 1080p against ~48 fetches here.
//
// noise.glsl injected by cloudsVolume.js
// cloudCommon.glsl injected by cloudsVolume.js
// cloudShade.glsl injected by cloudsVolume.js

uniform sampler2D uDepthTexture;  // terrain depth pre-pass (water.js's depthPrePass RT)
uniform sampler3D uCloudLit;      // RG and BA: two copies of (raw fBM, optical depth toward the sun)
uniform float uLitRG[LIT_LAYERS]; // per layer, how much of RG the march shows
uniform sampler2D uWeatherMap;    // see weatherBias() below

uniform mat4  uInverseProjection;
uniform mat4  uInverseView;
uniform vec3  uCameraPos;

// World -> cloud space. The field is static in cloud space; drift is this
// offset growing, which is why nothing has to be re-baked to make clouds move.
uniform vec2  uWindOffset;
uniform float uExtent;
uniform float uUsableRadius;      // how far the volume can be trusted (see below)

uniform float uCloudLevel;
uniform float uCloudHeight;

// Horizon curvature droop: clouds sink toward the horizon with distance instead
// of ending in a hard flat bottom edge. 0 = flat shell. March time only; the
// bake and the light pass know nothing of the camera. See curvatureDrop().
uniform float uPlanetCurve;

uniform float uDensityScale;
uniform float uCoverage;

// Weather map — patches of air that are locally fuller or thinner than the
// flat uCoverage slider, pinned to the ground rather than to the density
// field's own wind, and updating on its own slow independent scroll
// (uWeatherOffset) so the whole coverage pattern gradually reshuffles over
// time instead of being a fixed stamp. Baked once (cloudWeatherMap.js) from a
// couple of low-frequency octaves — this is a coverage BIAS, not a second
// shape field, so it never needs the Nyquist bookkeeping the density grid does.
uniform vec2  uWeatherOffset;   // the weather map's own scroll, world units
uniform float uWeatherScale;    // world units per weather-tile
uniform float uWeatherStrength; // 0 = off

uniform float uAbsorption;
uniform float uScatteringAniso;

uniform vec2  uSunAzimuth;
uniform float uSunElevation;

uniform int   uMaxSteps;
uniform float uMarchStepSize;

// ── Analytic high-frequency detail ──────────────────────────────────────────
// The volume holds only octaves coarser than two of its cells. The same fBM
// series continues here from the octave the bake stopped at. The limit is the
// march: samples sit uMarchStepSize apart and obey the same two-sample rule, so
// uDetailOctaves is derived from the step (cloudVolumeMath.detailOctaveCount),
// 0 when the march is no finer than the grid. The light volume does not see the
// detail: it changes a cloud's edges, not which parts the sun reaches.
uniform float uDetailAmount;    // 1 = exact continuation of the baked series
uniform int   uDetailOctaves;   // derived from uMarchStepSize; 0 = off
uniform float uDetailFreq;      // where the series resumes
uniform float uDetailAmp;       // amplitude it resumes at, already amp-normalised
uniform float uLacunarity;
uniform float uGain;
// The boundary-octave crossfade's marched half — see cloudVolumeBake.frag's
// uLastOctaveWeight (the same octave's baked half) and cloudVolumeMath.js's
// octaveEdgeCloseness for why this exists. uBoundaryAmp is 0 (a no-op term)
// whenever the bake's last octave is comfortably inside this grid's Nyquist
// limit, which is most of the time; it only becomes non-zero as that octave
// nears the limit, standing in for exactly the amplitude the bake is fading
// out, at the SAME frequency, so the two together sum to the octave's full,
// undiminished amplitude throughout the crossfade.
uniform float uBoundaryFreq;
uniform float uBoundaryAmp;
// 0 (fully baked/resting) -> 1 (about to drop an octave). See detailFbm's own
// comment: this drives a POSITIONAL crossfade between drift-speed bands,
// separate from uBoundaryAmp's amplitude one — the two already-continuous
// amplitudes above still sample a discontinuous position without this.
uniform float uOctaveEdge;

// Differential drift: the detail octaves drift slower than the baked shape. The
// base, mid and fine bands run at 1, 0.75 and 0.375 of the same wind
// (cloudVolumeMath.windVector). Each offset is its own `windOffset(speed, time)`
// computed in JS; subtracting two growing accumulators in the shader would leave
// a wrong-signed residue and lose precision over a long session.
uniform vec2 uMidWindOffset;    // detail octave 0
uniform vec2 uFineWindOffset;   // detail octaves 1+

const int DETAIL_HARD_CAP = 4;

// snoise's dominant wavelength in INPUT units, measured by zero-crossing count
// (tests/tools/snoise_wavelength.mjs). Mirrors cloudVolumeMath.SNOISE_WAVELENGTH
// — the one number both the grid's and the march's Nyquist limits derive from.
const float SNOISE_WAVELENGTH = 1.7021;

// Upper bound on |snoise|, with margin. The GPU's own snoise peaked at 1.0382
// over 335M samples (the JS port in tests/tools is NOT faithful here — it
// reaches 4.26), so 1.25 is a bound, not a fit. detailBound() rests on it.
const float SNOISE_PEAK = 1.25;

// Empty-space skip in the march (see detailBound / marchVolumeClouds). Exact:
// it only skips work whose result is provably 0, so 1 and 0 render the same
// pixels. A uniform rather than a constant so a test can prove exactly that.
uniform float uEmptySpaceSkip;

// Steps grow with distance: uMarchStepSize is the step at tNear, widened by
// uStepGrowth per step. A uniform fine step would spend all 96 steps near the
// camera (8 units x 96 = 768, against a usable radius of 1811) and drop the far
// clouds; growing the step keeps the near detail and the reach.
uniform float uStepGrowth;

// Debug views, same idea as terrain.frag's uDebugView: the baked pipeline has
// three stages that can each fail silently to zero (bake wrote nothing, the
// threshold ate everything, the light march saturated), and a black sky looks
// identical in all three cases. Each view short-circuits main() with an opaque
// greyscale of one intermediate, so the failing stage is one screenshot away.
//   0 off · 1 raw baked fBM · 2 density after threshold
//   3 baked optical depth   · 4 sun transmittance
uniform float uDebugView;

// Loop bound for uMaxSteps. A step is a texture fetch rather than 21 noise
// evaluations, so a long march is affordable and is the cheapest way to buy
// back some of the smoothness the coarser field costs.
const int MAX_STEPS_HARD_CAP = 96;

varying vec2 vUv;

// World -> cloud space: the field is static here, so both the volume lookup
// and the analytic detail below must be evaluated in it, or they would drift
// apart from each other as the wind offset grows.
vec3 toCloudSpace(vec3 pWorld) {
  return vec3(pWorld.x + uWindOffset.x, pWorld.y, pWorld.z + uWindOffset.y);
}

/**
 * How far to shift a sample's world-Y up before testing it against the shell's
 * bounds: the shell sinks as a rigid unit with horizontal distance d from the
 * camera, by d²/(2R) (the small-angle drop of a plane behind a sphere). R is
 * uPlanetCurve, an artistic knob, not the real Earth's radius.
 */
float curvatureDrop(vec3 ro, vec3 pWorld) {
  if (uPlanetCurve <= 0.0) return 0.0;
  float d = length(pWorld.xz - ro.xz);
  return (d * d) / (2.0 * uPlanetCurve);
}

// Both signals, from the two layers around the height. Each layer stores its
// light twice (RG and BA); uLitRG says how much of RG it shows. Mixing the two
// layers by hand, not by the hardware's filter, keeps every layer's own weight
// exact. uv needs no window origin — the volume stores cell c at texel
// c mod resolution, exactly what RepeatWrapping addresses.
vec2 litAt(vec3 pCloud) {
  vec2 uv = pCloud.xz / uExtent;
  float zt = (pCloud.y - uCloudLevel) / uCloudHeight * float(LIT_LAYERS) - 0.5;
  int   i0 = clamp(int(floor(zt)), 0, LIT_LAYERS - 1);
  int   i1 = min(i0 + 1, LIT_LAYERS - 1);
  float f  = clamp(zt - float(i0), 0.0, 1.0);
  vec4 v0 = texture(uCloudLit, vec3(uv, (float(i0) + 0.5) / float(LIT_LAYERS)));
  vec4 v1 = texture(uCloudLit, vec3(uv, (float(i1) + 0.5) / float(LIT_LAYERS)));
  return mix(mix(v0.ba, v0.rg, uLitRG[i0]), mix(v1.ba, v1.rg, uLitRG[i1]), f);
}

/**
 * How much of one detail octave, of frequency `freq`, a step of `localStep` can
 * carry without aliasing: its wavelength over twice the step, clamped. Per
 * octave, so an octave keeps its weight whether it is the boundary term or
 * detail octave 0 or 1. As the step grows with distance the finest octaves fade
 * first.
 */
float detailWeight(float localStep, float freq) {
  return clamp(SNOISE_WAVELENGTH / (freq * 2.0 * localStep), 0.0, 1.0);
}

/**
 * The baked series continued: octaves the volume could not hold. Takes
 * WORLD position (not cloud space) because the two bands below each add
 * their OWN drift instead of sharing uWindOffset — see uMidWindOffset's doc.
 */
float detailFbm(vec3 pWorld, float localStep) {
  float v = 0.0;

  vec3 pMid  = vec3(pWorld.x + uMidWindOffset.x,  pWorld.y, pWorld.z + uMidWindOffset.y);
  vec3 pFine = vec3(pWorld.x + uFineWindOffset.x, pWorld.y, pWorld.z + uFineWindOffset.y);

  // Boundary crossfade term (uBoundaryFreq / uBoundaryAmp): the marched half of
  // the last baked octave. Skipped when that octave is well inside the grid's
  // limit (uBoundaryAmp is 0). Its position slides from pWorld to pMid as
  // uOctaveEdge rises to 1, so that at the drop it sits where detail octave 0
  // samples (pMid); a fixed pWorld would make a full-amplitude octave jump
  // between drift bands (seen at scatter 0.32 -> 0.33).
  if (uBoundaryAmp > 0.0) {
    vec3 pBoundary = mix(pWorld, pMid, uOctaveEdge);
    v += uBoundaryAmp * detailWeight(localStep, uBoundaryFreq) * snoise(pBoundary * uBoundaryFreq);
  }

  float amp = uDetailAmp;
  float freq = uDetailFreq;

  // Detail octave 0 ("mid" band) — same reasoning in reverse: this is the
  // octave the boundary term above stands in for BEFORE the flip, so it slides
  // from pMid toward pFine on the SAME uOctaveEdge, matching what it becomes
  // (detail octave 1, "fine" band) the instant uOctaves actually drops.
  if (uDetailOctaves >= 1) {
    vec3 pDetail0 = mix(pMid, pFine, uOctaveEdge);
    v += amp * detailWeight(localStep, freq) * snoise(pDetail0 * freq);
  }
  amp *= uGain;
  freq *= uLacunarity;

  // Octaves 1+ ("fine" band) — drifts slower still, same series continued.
  // No further split below this, so no further crossfade is needed here.
  for (int i = 1; i < DETAIL_HARD_CAP; i++) {
    if (i >= uDetailOctaves) break;
    v += amp * detailWeight(localStep, freq) * snoise(pFine * freq);
    amp *= uGain;
    freq *= uLacunarity;
  }
  return v;
}

// Signed coverage bias at a WORLD position, pinned to terrain rather than to
// cloud space — takes pWorld directly (the march loop has it already) rather
// than recovering it from pCloud, same reasoning as detailFbm above.
float weatherBias(vec2 pWorldXZ) {
  vec2 uv = (pWorldXZ + uWeatherOffset) / uWeatherScale;
  return texture(uWeatherMap, uv).r * uWeatherStrength;
}

/**
 * Upper bound on |detailFbm(p, localStep)| for every p: the sum of each
 * term's |amplitude| times its detailWeight times SNOISE_PEAK, over exactly
 * the terms detailFbm adds (the boundary term, octave 0, octaves
 * 1..uDetailOctaves-1).
 */
float detailBound(float localStep) {
  float b = abs(uBoundaryAmp) * detailWeight(localStep, uBoundaryFreq);
  float amp = abs(uDetailAmp);
  float freq = uDetailFreq;
  for (int i = 0; i < DETAIL_HARD_CAP; i++) {
    if (i >= uDetailOctaves) break;
    b += amp * detailWeight(localStep, freq);
    amp *= abs(uGain);
    freq *= uLacunarity;
  }
  return b * SNOISE_PEAK;
}

/**
 * Density at a point: the baked shape plus the analytic tail, thresholded after
 * the sum, so the detail carves the silhouette.
 *
 * Where even the largest the tail could add (uDetailAmount * detailBound) cannot
 * lift the field over the coverage threshold, the density is 0 whatever the
 * noise says, and the noise is not evaluated. That is most of the sky, and the
 * noise is the most expensive part of the frame. Valid only for
 * uDensityScale >= 0.
 */
float densityAt(vec3 pCloud, vec3 pWorld, float shape, float localStep) {
  float coverage = uCoverage - weatherBias(pWorld.xz);
  if (uEmptySpaceSkip > 0.5 && uDensityScale >= 0.0 &&
      (shape + abs(uDetailAmount) * detailBound(localStep)) * uDensityScale - coverage <= 0.0) return 0.0;
  float field = shape + uDetailAmount * detailFbm(pWorld, localStep);
  float h = clamp((pCloud.y - uCloudLevel) / uCloudHeight, 0.0, 1.0);
  float edgeFalloff = smoothstep(0.0, 0.15, h) * smoothstep(1.0, 0.75, h);
  return max(field * uDensityScale - coverage, 0.0) * edgeFalloff;
}

vec4 marchVolumeClouds(vec3 ro, vec3 rd, float tNear, float tFar, vec3 sunDir, float sunHeight) {
  float transmittance = 1.0;
  float lightEnergy = 0.0;
  float phase = henyeyGreenstein(dot(rd, sunDir), uScatteringAniso);

  float t = tNear;
  for (int i = 0; i < MAX_STEPS_HARD_CAP; i++) {
    if (i >= uMaxSteps) break;
    if (t >= tFar) break;
    float marchSize = uMarchStepSize * (1.0 + float(i) * uStepGrowth);
    vec3 pWorld = ro + rd * (t + marchSize * 0.5);
    pWorld.y += curvatureDrop(ro, pWorld);
    vec3 pCloud = toCloudSpace(pWorld);

    // Outside the shell's height range edgeFalloff is 0, so densityAt would
    // return 0 whatever the volume holds: skip the volume fetch as well. The
    // slab is widened downward for curvature (main), so many steps land here.
    // The 1e-4 margin leaves the boundary itself to densityAt, so a rounding
    // difference between this h and densityAt's can never change a pixel.
    float hShell = (pCloud.y - uCloudLevel) / uCloudHeight;
    if (uEmptySpaceSkip > 0.5 && (hShell < -1e-4 || hShell > 1.0001)) {
      t += marchSize;
      continue;
    }

    vec2 lit = litAt(pCloud);
    float density = densityAt(pCloud, pWorld, lit.r, marchSize);
    t += marchSize;

    if (density > 0.001) {
      // The baked optical depth becomes transmittance here rather than in the
      // volume, so uAbsorption stays a live slider and the interpolation
      // upstream stayed linear in the quantity that actually interpolates.
      float lightTransmittance = beersLaw(lit.g, uAbsorption);
      float stepTrans = beersLaw(density * marchSize, uAbsorption);
      // scatterWeight is `marchSize` unless uUseSint is on — see cloudCommon.glsl.
      float scatterLen = scatterWeight(stepTrans, density * uAbsorption, marchSize);
      // powderTerm is 1.0 unless uPowderEnabled is on — see cloudCommon.glsl.
      float powder = powderTerm(density * marchSize * uAbsorption);

      lightEnergy += scatterLen * transmittance * lightTransmittance * phase * powder;
      transmittance *= stepTrans;
    }
    if (transmittance < 0.01) break;
  }

  return cloudShade(lightEnergy, transmittance, sunHeight);
}

void main() {
  vec4 clip = vec4(vUv * 2.0 - 1.0, -1.0, 1.0);
  vec4 viewPos = uInverseProjection * clip;
  vec3 rayView = normalize(viewPos.xyz / viewPos.w);
  vec3 rayWorld = normalize(mat3(uInverseView) * rayView);
  vec3 ro = uCameraPos;

  float terrainViewZ = viewZFromDepth(texture2D(uDepthTexture, vUv).r);
  float terrainDist = (rayView.z < -1e-5) ? (terrainViewZ / rayView.z) : 1e9;

  // The per-sample curvatureDrop() above shifts effective altitude down by up
  // to this much at the far edge of the trustworthy volume — the coarse,
  // flat-plane intersection test below has to admit that whole widened band
  // first, or a grazing ray that curvature would later pull into the shell
  // never gets marched at all. Widening the BOTTOM only, top unchanged: the
  // shell sinks as a rigid unit, so its highest point at any distance is
  // still the original top.
  float maxDrop = uPlanetCurve > 0.0 ? (uUsableRadius * uUsableRadius) / (2.0 * uPlanetCurve) : 0.0;
  float slabLevel  = uCloudLevel - maxDrop;
  float slabHeight = uCloudHeight + maxDrop;

  float dNear, dFar;
  if (uDebugView >= 0.5) {
    // MARCHES the whole visible depth rather than probing one point: a rolling
    // buffer goes stale at the window's LEADING EDGE, one to two thousand units
    // out, which a fixed-distance probe would never reach. Averaging along the
    // ray covers everything a pixel actually sees.
    if (!intersectCloudSlab(ro, rayWorld, slabLevel, slabHeight, dNear, dFar)) {
      gl_FragColor = vec4(0.0, 0.0, 0.25, 1.0);   // ray misses the slab entirely
      return;
    }
    dFar = min(min(dFar, terrainDist), uUsableRadius);
    float acc = 0.0;
    float n = 0.0;
    int dSteps = min(uMaxSteps, int(ceil((dFar - dNear) / uMarchStepSize)));
    for (int i = 0; i < MAX_STEPS_HARD_CAP; i++) {
      if (i >= dSteps) break;
      float t = dNear + (float(i) + 0.5) * uMarchStepSize;
      if (t > dFar) break;
      vec3 pWorld = ro + rayWorld * t;
      pWorld.y += curvatureDrop(ro, pWorld);
      vec3 pCloud = toCloudSpace(pWorld);
      vec2 lit = litAt(pCloud);
      float density = densityAt(pCloud, pWorld, lit.r, uMarchStepSize);
      if (uDebugView < 1.5)      acc += lit.r * 0.5 + 0.5;          // signed -> 0..1
      else if (uDebugView < 2.5) acc += density;
      else if (uDebugView < 3.5) acc += lit.g / 64.0;
      else                       acc += beersLaw(lit.g, uAbsorption);
      n += 1.0;
    }
    gl_FragColor = vec4(vec3(n > 0.0 ? acc / n : 0.0), 1.0);
    return;
  }

  vec4 cloudColor = vec4(0.0);

  float tNear, tFar;
  if (intersectCloudSlab(ro, rayWorld, slabLevel, slabHeight, tNear, tFar)
      && tNear < uUsableRadius) {
    // uUsableRadius, not a fixed constant: a rolling buffer is a torus, and
    // somewhere out there the newest texel column abuts the oldest with a real
    // discontinuity across the seam. The window is camera-centred, so that
    // seam sits about extent/2 away; cloud alpha has to reach zero before a
    // ray gets there. This is the draw-distance cost of the baked approach.
    tFar = min(min(tFar, terrainDist), uUsableRadius);
    if (tFar > tNear) {
      vec3 sunDir = normalize(vec3(uSunAzimuth.x, uSunElevation, uSunAzimuth.y));
      cloudColor = marchVolumeClouds(ro, rayWorld, tNear, tFar, sunDir, sunDir.y);
      cloudColor.a *= 1.0 - smoothstep(uUsableRadius * 0.75, uUsableRadius, tNear);
    }
  }

  // Raw colour + alpha into cloudsVolume.js's cached RT, not the screen — the
  // scene mix happens in the separate cheap composite pass.
  gl_FragColor = cloudColor;
}
