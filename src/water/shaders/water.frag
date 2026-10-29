precision highp float;

// noise.glsl injected by water.js

uniform float uTime;         // the ripple clock, shared with water.vert — drives the foam pulse too
uniform vec3  uWaterDeep;    // deep body colour
uniform vec3  uWaterShallow; // shallow / shoreline colour
uniform vec3  uWaterSpec;    // sun-glint colour
uniform vec3  uSkyReflect;   // sky horizon colour — faux reflection target
uniform float uOpacity;      // base opacity (grazing angles drive it higher)
uniform float uWaterBands;   // posterize the depth gradient into N flat bands; <2 = smooth
uniform float uReflectAmt;   // how much sky reflection to blend in [0,1]
uniform float uSpecAmt;      // specular glint intensity
uniform float uSparkleThreshold; // spec cutoff (momentum-scaled by waterDriver.js) — lower = denser glitter
uniform sampler2D uDepthTexture; // terrain depth pre-pass (for underwater depth)
uniform vec2  uResolution;   // render target size in pixels
uniform float uCameraNear;
uniform float uCameraFar;
uniform float uDepthMax;     // world-unit depth that maps to fully-deep colour (waterDriver.js: a share of the available depth)
uniform float uRippleScale;  // shared with water.vert
uniform float uFoamWidth;    // world units of depth — reach of the shore foam band (waterDriver.js: a share of the available depth, widened by momentum)
uniform float uFoamTiers;    // posterize foam into N bands; <2 = smooth
uniform float uFoamAmt;      // foam blend strength
uniform float uFoamNoiseAmt; // 0 = clean depth band, 1 = ragged/clumped froth
uniform float uWaveNoiseMix; // 0 = pure sine swell, 1 = pure 3D-noise detail (shared with water.vert)
uniform sampler2D uReflectionTex;    // terrain mirrored across sea level (see water.js reflectionPrePass)
uniform mat4      uReflectionMatrix; // mirrored-camera view-projection, for reflection UV
uniform float     uReflectDistort;   // ripple-driven UV wobble on the mirror sample
uniform float     uReflectTerrainAmt; // 0 = flat uSkyReflect, 1 = full mirrored terrain
uniform float     uReflectTiers;     // posterize the fresnel mask into N bands; <2 = smooth
uniform float     uDistortSteps;     // quantize the UV wobble into facets; <1 = smooth

// Fog and light level: the same scene-wide values as terrain's, or the
// shoreline and the horizon show a seam.
uniform vec3  uFogColor;
uniform float uFogNear;
uniform float uFogFar;
uniform float uFogCurve;
uniform float uFogMaxAlpha;
uniform float uLightLevel;

// Cloud shadows: the baked light terrain.frag reads, and it must be the same or
// the shoreline seams.
uniform sampler2D uCloudGround;   // optical depth of the whole column at each cloud-space cell (.g)
uniform float uCloudShadowAmt;
uniform float uCloudShadowAbs;
uniform float uCloudShadowFloor;
uniform float uCloudLevel;
uniform float uCloudExtent;
uniform vec2  uCloudWind;
uniform vec3  uCloudSunDir;
uniform float uCloudShadowTiers;  // must match terrain's

varying vec3 vWorldPos;
varying vec3 vNormal;

/**
 * Quantise the cloud-shadow transmittance into flat tiers, as terrain.frag's cel
 * ladder does. Each tier edge is ramped over one screen pixel (fwidth), so the
 * wind-drifting shadow does not crawl pixel by pixel. MUST MATCH terrain's.
 */
float posterizeShadow(float t) {
  if (uCloudShadowTiers < 2.0) return t;
  float n = uCloudShadowTiers - 1.0;
  float q = t * n;
  float f = floor(q);
  // Clamped: fwidth grows with distance, and an unbounded ramp would smear the tiers.
  float w = clamp(fwidth(q), 1e-5, 0.5);
  return (f + smoothstep(0.0, w, q - f)) / n;
}

// Three.js standard formula: NDC depth [0,1] → view-space Z (negative)
float viewZFromDepth(float d) {
  return (uCameraNear * uCameraFar) / ((uCameraFar - uCameraNear) * d - uCameraFar);
}

// The ripple height of water.vert (same swell and noise detail, without the
// amplitude) at a given time, so the foam can sample ahead of uTime
// (FOAM_LEAD_TIME).
float swell(vec2 p, float time) {
  return sin(p.x * uRippleScale            + time       ) * 0.5
       + sin(p.y * uRippleScale * 1.3      + time * 0.8 ) * 0.5
       + sin((p.x + p.y) * uRippleScale * 0.7 + time * 1.3) * 0.5;
}
float wave(vec2 p, float time) {
  float base   = swell(p, time);
  float detail = snoise(vec3(p * uRippleScale * 1.5, time * 0.6));
  return mix(base, detail, uWaveNoiseMix);
}

// >0.5: emit the art pass's G-buffer instead of the surface (artGBuffer.js).
uniform float uArtData;

void main() {
  // The art pass only needs to know this pixel is water; its strokes run
  // horizontally there whatever the normal, so the normal channels carry the
  // neutral 0.5 and not the ripple.
  if (uArtData > 0.5) {
    gl_FragColor = vec4(0.5, 0.5, 1.0, 1.0);
    return;
  }

  vec3 N = normalize(vNormal);
  vec3 V = normalize(cameraPosition - vWorldPos);

  // Schlick-ish fresnel: more sky reflection at grazing angles
  float facing = clamp(dot(N, V), 0.0, 1.0);
  float fres   = pow(1.0 - facing, 5.0);

  // Vertical water depth: the seabed's world position is rebuilt along the view
  // ray from the depth pre-pass. Differencing the view-space Zs alone gives the
  // ray's path through the water, many times the depth at grazing angles.
  vec2  screenUV     = gl_FragCoord.xy / uResolution;
  float terrainViewZ = viewZFromDepth(texture2D(uDepthTexture, screenUV).r);

  // World-space camera forward: the view matrix's third row, negated.
  vec3  camAxis = -vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]);
  vec3  rayDir  = -V;                                  // camera → this fragment
  // cos between the pixel ray and the camera axis; converts axial Z to ray length.
  float axial   = max(dot(rayDir, camAxis), 1e-4);
  float axialGap = viewZFromDepth(gl_FragCoord.z) - terrainViewZ;  // along the axis
  // ray length through water = axialGap / axial; vertical = that × V.y. The two
  // absolute Zs are large and nearly equal at grazing angles, so they are
  // differenced before scaling.
  float underwaterDepth = max(axialGap * V.y / axial, 0.0);

  float t = clamp(underwaterDepth / uDepthMax, 0.0, 1.0);
  if (uWaterBands >= 2.0) {
    t = floor(t * uWaterBands) / (uWaterBands - 1.0);
  }
  vec3 body = mix(uWaterShallow, uWaterDeep, t);

  // Reflection: the mirror pass's picture, sampled where this fragment projects
  // through the mirror camera. clip.w <= 0 means it is behind that camera, where
  // the divide would streak, so it falls back to the flat sky colour.
  vec4  reflClip    = uReflectionMatrix * vec4(vWorldPos, 1.0);
  float reflValid   = step(0.001, reflClip.w);
  vec2  reflUV      = (reflClip.xy / max(reflClip.w, 0.001)) * 0.5 + 0.5;
  // The ripple normal wobbles the lookup, snapped to a grid so the mirror bends
  // in flat facets rather than smooth liquid warping.
  vec2 distortVec = N.xz;
  if (uDistortSteps >= 1.0) {
    distortVec = floor(distortVec * uDistortSteps + 0.5) / uDistortSteps;
  }
  reflUV += distortVec * uReflectDistort;
  vec3  reflColor   = texture2D(uReflectionTex, clamp(reflUV, 0.0, 1.0)).rgb;
  vec3  reflTarget  = mix(uSkyReflect, reflColor, uReflectTerrainAmt * reflValid);

  // The fresnel mask in discrete tiers, so the mirror reads as flat sheets. It
  // uses the full ripple normal, so the band edges shimmer: intended. The
  // continuous `fres` still drives the glint suppression and opacity below.
  float fresR = fres;
  if (uReflectTiers >= 2.0) {
    fresR = ceil(fresR * uReflectTiers) / uReflectTiers;
  }

  // Capped, so the water keeps its colour instead of washing out.
  vec3 color = mix(body, reflTarget, fresR * uReflectAmt);

  // Shore foam: underwaterDepth ≈ 0 is the coastline. The wave is sampled
  // slightly ahead of uTime so the foam builds in step with the crest instead of
  // trailing it.
  const float FOAM_LEAD_TIME = 0.3;  // seconds of look-ahead
  float leadTime = uTime + FOAM_LEAD_TIME;
  float crest    = wave(vWorldPos.xz, leadTime) * 0.5 + 0.5;   // roughly 0 trough … 1 crest

  // The reach grows from a thin line to full width as a crest arrives. The
  // floor keeps the smoothstep below from having equal edges (undefined in GLSL).
  float reach = max(uFoamWidth * smoothstep(0.2, 0.8, crest), 1e-3);

  // Noise warps the shore-distance signal itself, so the ragged edge is the
  // falloff's own shape and not a second mask clipped over it: a coarse term
  // bends the line into coves, a fine one breaks it into patches. Both ride
  // leadTime, in step with the crest.
  vec2  foamP  = vWorldPos.xz * 0.10;
  float warpBig  = snoise(vec3(foamP,       leadTime * 1.8));
  float warpFine = snoise(vec3(foamP * 0.6 + 5.0, leadTime * 0.3 + 5.0));
  float warp     = mix(warpBig, warpFine, 0.4);

  float warpedDepth = underwaterDepth - warp * reach * 0.6 * uFoamNoiseAmt;
  float foamT = 1.0 - smoothstep(-reach * 0.3, reach, warpedDepth);

  if (uFoamTiers >= 2.0) {
    foamT = ceil(foamT * uFoamTiers) / uFoamTiers;   // cel-band ladder, matches the terrain's style
  }
  vec3 foamColor = mix(uWaterShallow, vec3(1.0), 0.6);
  color = mix(color, foamColor, foamT * uFoamAmt);

  // Sun glint in two tiers, like the terrain's cel shading. Each edge is
  // anti-aliased with fwidth: a hard step() on this very narrow highlight
  // crawls under a moving camera and ripples. The cutoff is momentum-scaled
  // (waterDriver.js): agitated water glitters densely, calm water in a few flecks.
  vec3  H        = normalize(uCloudSunDir + V);   // the scene sun, as terrain shades with
  float spec     = pow(clamp(dot(N, H), 0.0, 1.0), 120.0);
  float sw       = fwidth(spec);
  float t1       = uSparkleThreshold;
  float t2       = mix(t1, 1.0, 0.5);
  float fleck    = smoothstep(t1 - sw, t1 + sw, spec) * 0.6
                 + smoothstep(t2 - sw, t2 + sw, spec) * 0.4;
  fleck         *= 1.0 - fres * 0.5;  // not doubly bright where the sky reflection is strong
  color += uWaterSpec * fleck * uSpecAmt;

  // Cloud shadow, on the composited surface so it dims the glint too (a cloud
  // in front of the sun removes its reflection). Projected as terrain.frag's
  // cloudSunlight does.
  if (uCloudShadowAmt > 0.0) {
    float rise = max(uCloudLevel - vWorldPos.y, 0.0);
    vec3  p = vWorldPos + uCloudSunDir * (rise / max(uCloudSunDir.y, 1e-3));
    vec2  uv = vec2(p.x + uCloudWind.x, p.z + uCloudWind.y) / uCloudExtent;
    float lit = posterizeShadow(exp(-texture(uCloudGround, uv).g * uCloudShadowAbs));
    color *= mix(1.0, max(lit, uCloudShadowFloor), uCloudShadowAmt);
  }

  // Scene light level (terrain.frag's uLightLevel), applied before the fog so
  // the water darkens with the land under cloud but the horizon it melts into
  // does not. The reflected sky darkens with it; the weather's reflect-amount
  // end compensates.
  color *= uLightLevel;

  // Opacity rises at grazing angles (reflective sheen reads as more solid)
  float alpha = clamp(uOpacity + fres * (1.0 - uOpacity), 0.0, 1.0);

  // Distance fog into the horizon colour
  float depth     = gl_FragCoord.z / gl_FragCoord.w;
  float fogFactor = clamp((depth - uFogNear) / (uFogFar - uFogNear), 0.0, 1.0);
  fogFactor = pow(fogFactor, uFogCurve) * uFogMaxAlpha;
  color = mix(color, uFogColor, fogFactor);
  alpha = mix(alpha, 1.0, fogFactor);  // far water reads as solid horizon

  gl_FragColor = vec4(color, alpha);
}
