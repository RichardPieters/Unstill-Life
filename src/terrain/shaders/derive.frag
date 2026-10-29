precision highp float;

// derive.frag — data-map DERIVE pass.
//
// Reads the finished height map (RT_A, produced by heightmap.frag) and bakes
// the view-INDEPENDENT per-point signals the terrain vertex shader needs:
//   • surface gradient (→ normal)            — 4 texture taps
//   • large-ring mean height (valley scale)  — 8 taps
//   • small-ring mean height (gully scale)   — 8 taps
// Doing it once per texel here costs one map-resolution pass per frame instead
// of ~21 taps per vertex and fragment in every scene pass; terrain.vert,
// terrain.frag and the forest sites read this bundle (RT_B) in one fetch. The
// signals depend only on the map, so one bake serves all passes.
//
// Output channels (RT_B):
//   R — d(height)/dx   (world units per world unit)
//   G — d(height)/dz
//   B — large-ring mean height (world units) → concaveLarge reference
//   A — small-ring mean height (world units) → concaveSmall reference

varying vec2 vUv;

uniform sampler2D uDataMap;      // RT_A: R height · G ridge · B erosionDelta · A bedrock/mantle select
uniform float     uPlaneSize;    // world size covered by the map
uniform float     uDataMapTexel; // 1 / map resolution
uniform float     uHollowRadius; // large ring radius (world units) — shared with terrain material
uniform float     uCreaseRadius; // small ring radius (world units) — shared with terrain material

// dataMapSample.glsl injected by terrain.js

// Mean height over an 8-tap ring of uv-radius r (world radius / plane size).
float ringMean(vec2 uv, float r) {
  vec2 offs[8];
  offs[0]=vec2(1.,0.); offs[1]=vec2(-1.,0.); offs[2]=vec2(0.,1.); offs[3]=vec2(0.,-1.);
  offs[4]=vec2(.707,.707); offs[5]=vec2(-.707,.707); offs[6]=vec2(.707,-.707); offs[7]=vec2(-.707,-.707);
  float m = 0.0;
  for (int i = 0; i < 8; i++) {
    m += texture2D(uDataMap, uv + r * offs[i]).r;
  }
  return m * 0.125;
}

void main() {
  vec2 uv = vUv;

  // Normal from symmetric central differences (±1 texel).
  float span = 2.0 * uDataMapTexel * uPlaneSize;
  float hx1 = texture2D(uDataMap, smoothDataUV(uv + vec2(uDataMapTexel, 0.0))).r;
  float hx0 = texture2D(uDataMap, smoothDataUV(uv - vec2(uDataMapTexel, 0.0))).r;
  float hz1 = texture2D(uDataMap, smoothDataUV(uv + vec2(0.0, uDataMapTexel))).r;
  float hz0 = texture2D(uDataMap, smoothDataUV(uv - vec2(0.0, uDataMapTexel))).r;
  float gradX = (hx1 - hx0) / span;
  float gradZ = (hz1 - hz0) / span;

  // Two-scale topographic concavity references: ring means on the
  // FINAL eroded map. The fragment shader forms (mean − height) × gain later.
  float coarseMean = ringMean(uv, uHollowRadius / uPlaneSize);
  float smallMean  = ringMean(uv, uCreaseRadius / uPlaneSize);

  gl_FragColor = vec4(gradX, gradZ, coarseMean, smallMean);
}
