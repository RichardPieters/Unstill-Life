precision highp float; // highp required — fBM accumulation causes banding at mediump

// ─── Uniforms ─────────────────────────────────────────────────────────────────
// Data-map displacement path (erosion pipeline)
uniform sampler2D uDataMap;        // RT_A: R height · G ridgeMap · B erosionDelta · A bedrock/mantle select
uniform sampler2D uDeriveMap;      // RT_B: R d/dx · G d/dz · B coarseMean · A smallMean (derive.frag)
uniform float     uPlaneSize;      // world size covered by the data map
uniform float     uDataMapTexel;   // 1 / map resolution

// ─── Varyings ─────────────────────────────────────────────────────────────────
varying float vHeight;
varying vec3  vNormal;
varying vec2  vWorldXZ;
// Material-field sampling frame: material noise must ride the same
// drift + time axis as the terrain, or colour placement decouples from landforms.
varying vec2  vMatXZ;        // world xz + instance-0 drift offset
varying float vMatTime;      // terrain's time-axis position (0 when time axis disabled)
varying float vCoarseHeight; // large-ring mean height — valley-scale concavity reference
varying float vSmallMean;    // small-ring mean height — gully-scale concavity reference
// Erosion data layers (heightmap.frag G/B/A), read only by terrain.frag's debug
// views; neutral values when erosion is off
varying float vRidge;        // −1 creases … +1 ridges (1.0 when erosion is off)
varying float vErosion;      // signed erosion delta (0.0 when erosion is off)
varying float vBedrock;      // 1 bedrock exposed … 0 mantle (0.0 under a test fixture)

// dataMapSample.glsl injected here by terrain.js at shader compile time

// The material noise frame: the drift and the time axis (the same uniform objects
// the data-map pass and fbm.glsl use).
uniform float uTime;
uniform bool  uEnableTimeAxis;
uniform float uFBM0TimeSpeed;
uniform vec2  uFBM0DriftOffset;

// ─── Main ─────────────────────────────────────────────────────────────────────
void main() {
  vec3 pos = position;

  // Displace from the data map rendered by the heightmap pass; read the baked
  // normal + concavity references from the derive pass (derive.frag). Same
  // world↔uv mapping the passes use: uv = xz/size + 0.5. Both fetches go through
  // a smoothstepped fractional coordinate so plain bilinear (C0 — its gradient
  // jumps at texel borders) doesn't show diagonal cell-grid artifacts on slopes.
  vec2 uvRaw = pos.xz / uPlaneSize + 0.5;
  vec2 uv    = smoothDataUV(uvRaw);
  vec4 d  = texture2D(uDataMap, uv);      // R height · G ridge · B erosion · A bedrock select
  float h  = d.r;
  vRidge   = d.g;
  vErosion = d.b;
  vBedrock = d.a;

  // RT_B: gradient (→ normal) + two-scale ring means, all pre-baked once per
  // frame at map resolution. Small ring
  // = gully floors vs ribs; large ring = valleys vs masses.
  vec4 db = texture2D(uDeriveMap, uv);
  vCoarseHeight = db.b;
  vSmallMean    = db.a;
  vec3 n = normalize(vec3(-db.r, 1.0, -db.g));

  vHeight   = h;
  vNormal   = normalize((modelMatrix * vec4(n, 0.0)).xyz);
  vWorldXZ  = pos.xz;

  vMatXZ   = pos.xz + uFBM0DriftOffset;
  vMatTime = uEnableTimeAxis ? uTime * uFBM0TimeSpeed : 0.0;

  gl_Position = projectionMatrix * modelViewMatrix * vec4(pos.x, h, pos.z, 1.0);
}
