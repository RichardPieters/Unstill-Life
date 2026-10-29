// cloudCommon.glsl — the march-time pieces: ray/slab geometry and the optics
// primitives (Beer's law, HG phase, the Sint/powder experiments).
//
// Injected by cloudsVolume.js into cloudsVolume.frag and by godrays.js into
// godrays.frag. Anything that decides how a cloud LOOKS once density and
// transmittance are known belongs in cloudShade.glsl instead.
//
// What deliberately stays OUT: the density field itself and the lightmarch.

uniform float uCameraNear;
uniform float uCameraFar;

// ── Shading-tail experiments ───────────────────────────────────────────────
// Each is a toggle; with it below 0.5 (uUseSint, uPowderEnabled) its term is
// a no-op.

// 0 = naive rectangle-rule in-scatter accumulation. 1 = Hillaire's closed-form
// per-step integral (Frostbite PBS16 §5.6) — see scatterWeight.
uniform float uUseSint;
// "Powder sugar" edge darkening (Schneider & Vos, HZD SIGGRAPH15) — see
// powderTerm. uPowderStrength has no analytically correct value (an artistic
// decay constant), hence a slider.
uniform float uPowderEnabled;
uniform float uPowderStrength;
float viewZFromDepth(float d) {
  return (uCameraNear * uCameraFar) / ((uCameraFar - uCameraNear) * d - uCameraFar);
}

// Ray-slab intersection against the horizontal shell [level, level+height].
// Handles the two cases a naive closed-form test misses: the camera already
// inside the shell (tNear clamped to 0) and a ray nearly parallel to it
// (would otherwise divide by ~0).
bool intersectCloudSlab(vec3 ro, vec3 rd, float level, float height, out float tNear, out float tFar) {
  float top = level + height;
  const float EPS = 1e-4;
  if (abs(rd.y) < EPS) {
    if (ro.y >= level && ro.y <= top) { tNear = 0.0; tFar = 1e9; return true; }
    return false;
  }
  float t0 = (level - ro.y) / rd.y;
  float t1 = (top   - ro.y) / rd.y;
  tNear = max(min(t0, t1), 0.0);
  tFar  = max(t0, t1);
  return tFar > tNear;
}

float beersLaw(float dist, float absorption) {
  return exp(-dist * absorption);
}

float henyeyGreenstein(float cosAngle, float g) {
  float g2 = g * g;
  return (1.0 - g2) / (4.0 * 3.14159265 * pow(1.0 + g2 - 2.0 * g * cosAngle, 1.5));
}

/**
 * Energy-conserving in-scatter weight for one step (Hillaire, Frostbite PBS16
 * §5.6, the "Sint" formula). The naive update weights a step's in-scattered
 * light by its raw length, as if none of it were re-absorbed leaving the step.
 * The exact weight is the integral of a decaying source across the step,
 * `(1 - stepTransmittance) / sigmaT`, which reuses the transmittance the march
 * already computes. It converges to the raw length as sigmaT * len -> 0.
 */
float scatterWeight(float stepTransmittance, float sigmaT, float len) {
  if (uUseSint < 0.5) return len;
  return (1.0 - stepTransmittance) / max(sigmaT, 1e-6);
}

/**
 * "Powder" darkening (Schneider & Vos, HZD SIGGRAPH15): a thin slice of cloud
 * facing the sun in-scatters less than density * transmittance predicts, so a
 * sun-facing edge reads darker than its interior. It scales the phase term only,
 * never the ambient. `stepOpticalDepth` is density * len * absorption;
 * uPowderStrength multiplies it.
 */
float powderTerm(float stepOpticalDepth) {
  if (uPowderEnabled < 0.5) return 1.0;
  return 1.0 - exp(-uPowderStrength * stepOpticalDepth);
}
