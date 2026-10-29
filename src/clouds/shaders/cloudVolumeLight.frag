// cloudVolumeLight.frag — pass 2 of the baked cloud volume: for every cell,
// march toward the sun through the shape volume and store how much cloud lies
// between the cell and the sky. One fullscreen quad per layer, refreshed a few
// layers per frame (cloudsVolume.js).
//
// Stored per cell, twice (a relight overwrites one copy and the march fades from
// the other, cloudsVolume.js's LIGHT FADE):
//   R  the cell's own raw field, copied through so the march needs one fetch per step.
//   G  optical depth toward the sun, not transmittance: blending exp(-tau)
//      between cells is biased bright, and leaving the exponential to lookup
//      time keeps uAbsorption a live slider.
//   B, A  the same two values again.
//
// The analytic detail octaves are not applied here: they change every frame, and
// this volume is only re-baked on a window shift or an invalidation. The weather
// map's bias is applied, and a drift of the map past `weatherRelightDistance`
// (cloudsVolume.js) makes the light stale.

uniform sampler3D uCloudShape;

uniform vec2  uOriginCell;
uniform float uResolution;
uniform float uLayers;
uniform float uLayer;
uniform float uCellSize;
uniform float uExtent;       // world units spanned horizontally by the volume

uniform float uCloudLevel;
uniform float uCloudHeight;

// Shared by reference with the final march, so the two agree on what "density"
// means. Changing either invalidates this volume (cloudsVolume.js marks it).
uniform float uDensityScale;
uniform float uCoverage;

uniform sampler2D uWeatherMap;
uniform vec2  uWindOffset;
uniform vec2  uWeatherOffset;
uniform float uWeatherScale;
uniform float uWeatherStrength;

// The ground shadow's draw (layer 0, into cloudsVolume.js's `_ground`) mixes its
// value with last frame's, read at this texel; every other draw has blend 1.
uniform sampler2D uGroundHistory;
uniform float uGroundBlend;

uniform vec2  uSunAzimuth;
uniform float uSunElevation;

uniform int   uLightSteps;
uniform float uLightStepSize;
uniform float uMaxOpticalDepth;   // clamp, so half-float never sees a silly number

const int LIGHT_STEPS_HARD_CAP = 48;

varying vec2 vUv;

// Sampling the shape volume in cloud space. No window origin is needed: the
// volume stores cell c at texel c mod resolution, which is exactly what
// RepeatWrapping addresses, so the cell-centre half-texel offsets cancel and
// the coordinate is just position/extent. Proven in cloudVolumeMath's
// "uv = pCloud/extent addresses the texel that stores that cell" case.
float shapeAt(vec3 pCloud) {
  vec3 uvw = vec3(pCloud.xz / uExtent, (pCloud.y - uCloudLevel) / uCloudHeight);
  return texture(uCloudShape, uvw).r;
}

// The weather map's coverage bias, taken at the sample's world position
// (cloud space minus the wind offset), exactly as cloudsVolume.frag's
// weatherBias does, so a cloud's shadow thins and thickens with the drawn cloud.
float weatherBias(vec3 pCloud) {
  vec2 uv = (pCloud.xz - uWindOffset + uWeatherOffset) / uWeatherScale;
  return texture(uWeatherMap, uv).r * uWeatherStrength;
}

float densityAt(vec3 pCloud) {
  float h = clamp((pCloud.y - uCloudLevel) / uCloudHeight, 0.0, 1.0);
  // Same falloff as cloudsVolume.frag's densityAt, so both thin
  // out at the shell's top and bottom identically.
  float edgeFalloff = smoothstep(0.0, 0.15, h) * smoothstep(1.0, 0.75, h);
  return max(shapeAt(pCloud) * uDensityScale - (uCoverage - weatherBias(pCloud)), 0.0) * edgeFalloff;
}

void main() {
  vec2 texel = floor(gl_FragCoord.xy);
  vec2 cell  = uOriginCell + mod(texel - uOriginCell, uResolution);

  vec3 p;
  p.xz = (cell + 0.5) * uCellSize;
  p.y  = uCloudLevel + (uLayer + 0.5) / uLayers * uCloudHeight;

  // Same sun convention as terrain.frag's lightDir and cloudsVolume.frag.
  vec3 sunDir = normalize(vec3(uSunAzimuth.x, uSunElevation, uSunAzimuth.y));

  float top = uCloudLevel + uCloudHeight;
  float opticalDepth = 0.0;
  vec3 lp = p;
  for (int i = 0; i < LIGHT_STEPS_HARD_CAP; i++) {
    if (i >= uLightSteps) break;
    lp += sunDir * uLightStepSize;
    // Left the shell — everything beyond is empty, so the integral is done.
    // (densityAt would return 0 out here anyway; this just stops paying for it.)
    if (lp.y > top || lp.y < uCloudLevel) break;
    opticalDepth += densityAt(lp) * uLightStepSize;
  }

  // texelFetch, not texture(): this cell's own value must be the stored one
  // exactly, with no filtering against neighbours. Trilinear at a texel centre
  // is the texel in exact arithmetic, but only in exact arithmetic.
  float own = texelFetch(uCloudShape, ivec3(int(texel.x), int(texel.y), int(uLayer)), 0).r;

  // Two copies of (own, depth) in RG and BA, so a relight can be faded in
  // (cloudsVolume.js's header, LIGHT FADE).
  float depth = min(opticalDepth, uMaxOpticalDepth);
  if (uGroundBlend < 1.0) depth = mix(texelFetch(uGroundHistory, ivec2(texel), 0).g, depth, uGroundBlend);
  gl_FragColor = vec4(own, depth, own, depth);
}
