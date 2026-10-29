precision highp float;

// noise.glsl injected by terrain.js

// ─── Uniforms ─────────────────────────────────────────────────────────────────
uniform float uTime;
uniform vec3  uFogColor;
uniform float uFogNear;
uniform float uFogFar;
uniform float uAerialDesat;   // how much distance washes local hue toward grey [0,1]
uniform float uFogCurve;      // shapes the near->far ramp; 1 = linear (see the fog block in main)
uniform float uFogMaxAlpha;   // ceiling on the ramp's output; 1 = the ramp may reach 100% at uFogFar

// ─── Palette — SUNLIT material colours; shadows derived in-shader ─────
uniform vec3  uColForest;
uniform vec3  uColMeadow;
uniform vec3  uColSnow;
uniform vec3  uColRock;
uniform vec3  uColSand;
uniform vec3  uColRiparian;
// Per-material alpenglow susceptibility
uniform float uGlowForest, uGlowMeadow, uGlowSnow, uGlowRock, uGlowSand, uGlowRiparian;
// Per-material shadow susceptibility — each biome's shadow FLOOR (local value):
// snow stays luminous in shade, forest drops to dark mass (see shadeMaterial)
uniform float uShadeForest, uShadeMeadow, uShadeSnow, uShadeRock, uShadeSand, uShadeRiparian;
// Shadow/glow colour derivation (keyed palette)
uniform vec3  uShadowHue;    // blue-violet shadows are pushed toward
uniform float uShadowValue;  // shadow darkening
uniform float uShadowDesat;  // shadow desaturation
uniform float uShadowHueAmt; // strength of the violet push
uniform vec3  uGlowHue;      // warm pink-gold highlight (alpenglow)
uniform float uGlow;         // global alpenglow amount
uniform float uLightLevel;   // how much light falls on the ground (1 = full sun)

// ─── Cloud shadows ────────────────────────────────────────────────────
// The sun-shadow oracle baked by cloudsVolume.js for its own march, read here
// as well. uCloudGround's .g is the optical depth from a cell toward the sun,
// integrated only inside the cloud shell — so its BOTTOM layer holds the whole
// column's shadow, which is exactly the quantity the ground needs.
//
// uCloudShadowAbs is this shader's OWN absorption and deliberately not the
// cloud's uAbsorption: that one is also what turns density into the clouds'
// on-screen opacity, so borrowing it would mean deepening the shadows and
// thickening every cloud in the sky with one slider. Two effects, two knobs.
uniform sampler2D uCloudGround;   // optical depth of the whole column at each cloud-space cell (.g)
uniform float uCloudShadowAmt;   // 0 = off (also the no-cloud-volume fallback)
uniform float uCloudShadowAbs;   // optical depth -> transmittance, shadows only
uniform float uCloudShadowFloor; // how dark a fully shadowed patch may get
uniform float uCloudShadowTiers; // flat tiers the shadow is quantised into; <2 = smooth
uniform float uCloudLevel;       // shell floor, world Y
uniform float uCloudHeight;
uniform float uCloudExtent;      // world size of one wrap of the volume
uniform vec2  uCloudWind;        // cloud-space scroll, so shadows drift with cloud
uniform vec2  uSunAzimuth;   // horizontal sun direction, for aspect
uniform float uSunElevation; // vertical sun component (1 = high noon, ~0.3 = grazing)
uniform float uShadeLo;      // N·L mapped to shade 0 here — remap start
uniform float uShadeHi;      // N·L mapped to shade 1 here — remap end
uniform float uHeightLo;
uniform float uHeightHi;
uniform float uSeaLevel;
uniform float uShoreWidth;
uniform float uShoreNoiseAmt;
uniform float uBeachFlat;    // slope gate: flatness above → beach possible
uniform float uBeachMoist;   // drainage gate: moisture above → sediment collects
uniform float uLightSteps;
uniform float uBandNoiseAmt;
uniform float uBandNoiseScale;
// Debug / lighting toggles
uniform float uDebugView;       // 0 off | 1 height | 2 flatness | 3 aspect | 4 cS | 5 cL | 6 moisture | 7 ridge | 8 erosion | 9 hollowness | 10 biome id | 11 normal | 12 N·L | 13 forest cover | 14 bedrock select
uniform float uProbeRaw;        // >0.5: debug views emit the RAW signal value (float RT), not the display ramp — signal tests
// >0.5: emit the art pass's G-buffer instead of colour — see artGBuffer.js.
// A uniform rather than a replacement material because the terrain's height
// comes from its OWN vertex shader: any substitute material renders a flat
// plane at y=0 and the geometry is simply wrong (measured, when the art-pass
// capture probe tried exactly that).
uniform float uArtData;
uniform bool  uEnableDiffuse;   // half-Lambert diffuse term
uniform bool  uEnableFog;
// Biome-zonation thresholds (slider-exposed — see index.html Biome panel)
uniform float uCliffFlat;       // flatness below → rock face
uniform float uScreeBand;       // rock belt width below the snowline
uniform float uCreaseRadius;    // small-ring radius (wu) — for radius-independent normalisation
uniform float uHollowRadius;    // large-ring radius (wu)
uniform float uSnowBase, uSnowAspect, uSnowHollow;      // snowline field
uniform float uTreeBase, uTreeAspect, uTreeWind, uTreeTongue; // treeline field
uniform float uPastureFlat;             // flat pocket → meadow
uniform float uRiparian;                // gully-floor lush ribbon threshold
// Forest likelihood — read by classify() in material.glsl, so declared here
// rather than in forest.glsl (which is injected after it). Each is the floor a
// biome gate drops the tree probability to; 0 = trees never grow there.
uniform float uForestBand;      // how far before a threshold the gate closes
uniform float uForestOnRock, uForestOnSnow, uForestOnMeadow, uForestOnShore;
// …and the one that goes the other way: past 1 it STOCKS a gully floor rather
// than thinning it, so gallery forest is denser than the hillside around it.
uniform float uForestOnRiparian;
// …and the spill shaping, which structures trees PAST a biome boundary.
uniform float uForestSpillFade; // how far past a boundary the spill reaches
uniform float uForestRibThin;   // how much convex ribs thin the forest [0,1]
uniform float uForestSlopeThin; // how much steep ground thins the forest [0,1]
// ─── Varyings ─────────────────────────────────────────────────────────────────
#ifdef FOREST_SITE_PASS
// The forest site pass (terrain.js) compiles this same file over a full-screen
// quad, which writes none of the terrain's varyings. Plain globals keep every
// shared function compiling; forestSite() reads none of the per-fragment ones,
// and main() below sets vMatTime, the one it does read (via matFieldSignedAt).
float vHeight;
vec3  vNormal;
vec2  vWorldXZ;
vec2  vMatXZ;
float vMatTime;
float vCoarseHeight;
float vSmallMean;
float vRidge;
float vErosion;
float vBedrock;
uniform bool  uEnableTimeAxis;
uniform float uFBM0TimeSpeed;
#else
varying float vHeight;
varying vec3  vNormal;
varying vec2  vWorldXZ;
// Material-field sampling frame — see terrain.vert
varying vec2  vMatXZ;
varying float vMatTime;
varying float vCoarseHeight;
varying float vSmallMean;
// Erosion data layers — see terrain.vert (neutral when erosion is off)
varying float vRidge;
varying float vErosion;
varying float vBedrock;
#endif

// Populated height range — fBM amplitude sum + erosion margin. Recomputed by
// terrain.js each tick (constant-dependency rule: never hardcode next to amps).
uniform float uHeightMax;
#define HEIGHT_MAX uHeightMax

// The map textures, read by this fragment's ground field (material.glsl) and by
// the forest site pass. Both already live in the terrain material's uniform
// object (vertex stage), and three binds uniforms program-wide.
uniform sampler2D uDataMap;     // RT_A: R = terrain height
uniform sampler2D uDeriveMap;   // RT_B: R d/dx · G d/dz · B coarse ring mean · A small ring mean
uniform float     uPlaneSize;

// material.glsl injected by terrain.js

// forest.glsl injected by terrain.js

/**
 * Quantise the cloud-shadow transmittance into flat tiers.
 *
 * Same antialiased ceil() idiom as terrain.frag's cel ladder, and for the same
 * two reasons: a bare floor() puts a zero-width tonal cliff at every tier edge,
 * and this field DRIFTS with the wind, so an un-antialiased edge crawls pixel by
 * pixel as the cloud moves. Ramping each boundary over its own screen footprint
 * (one fwidth) collapses back to a hard edge wherever the shadow gradient is
 * steep, which is most of the frame.
 *
 * Terrain re-quantises afterwards through the cel ladder, which is harmless —
 * the product of two ladders is a ladder. Water has no ladder of its own, so
 * without this its shadows would be the one smooth thing in a posterized
 * picture. MUST MATCH between the two shaders, the same rule uFogCurve follows.
 */
float posterizeShadow(float t) {
  if (uCloudShadowTiers < 2.0) return t;
  float n = uCloudShadowTiers - 1.0;
  float q = t * n;
  float f = floor(q);
  // CLAMPED on the upper side, exactly as the cel ladder does it. fwidth grows
  // with distance — far pixels cover many world units, so the shadow field can
  // change by more than a whole tier across one pixel. Left unbounded, the
  // smoothstep ramp then spans the entire tier and the ladder degenerates into
  // the smooth wash it exists to prevent, over most of the frame.
  float w = clamp(fwidth(q), 1e-5, 0.5);
  return (f + smoothstep(0.0, w, q - f)) / n;
}

/**
 * How much sun reaches a world point, given the cloud above it. 1 = open sun.
 *
 * Two choices are load-bearing and both were measured rather than assumed:
 *
 *  1. PROJECT ALONG THE SUN RAY, not straight up. The shadow on the ground is
 *     cast by the cloud the sun ray passes through, which at this sun elevation
 *     sits ~102 world units horizontally away from the point at sea level. A
 *     vertical lookup puts every shadow in the wrong place by that much.
 *
 *  2. DO NOT APPLY THE MARCH'S CURVATURE DROP. cloudsVolume.frag sinks the drawn
 *     shell by d²/(2·uPlanetCurve) with horizontal distance — 96 units at the
 *     horizon — but that is a horizon effect on the picture, not a lowering of
 *     the cloud base, so the lookup stays against the flat shell (see below).
 *
 * uCloudGround holds the optical depth of the whole column at each cell, so a
 * ground point needs no height coordinate, and this stays correct for ground
 * that pokes up into the deck.
 */
float cloudSunlight(vec3 pWorld, vec3 sunDir) {
  if (uCloudShadowAmt <= 0.0) return 1.0;
  // Project up the sun ray to the shell floor and read the WHOLE column's
  // shadow there (uCloudGround's depth already integrates everything above it).
  float rise = max(uCloudLevel - pWorld.y, 0.0);
  vec3  p = pWorld + sunDir * (rise / max(sunDir.y, 1e-3));
  vec3  pCloud = vec3(p.x + uCloudWind.x, p.y, p.z + uCloudWind.y);
  // Deliberately against the FLAT shell, NOT the drooped one the march draws.
  // uPlanetCurve sinks the rendered shell by d²/(2·curve) — 96 units at the
  // horizon — but that is a horizon effect applied to the drawn cloud, not a
  // real lowering of the cloud base. Feeding it in would put the curved floor
  // BELOW distant terrain, so far ground would sample high in the shell (where
  // optical depth toward the sun is ~0) and read as standing above the deck in
  // full sun. Measured: it pinned the median shadow factor at exactly 1.0.
  // The cost of ignoring it is that a shadow and the cloud drawn casting it
  // disagree near the horizon, where both are a few pixels tall.
  float opticalDepth = texture(uCloudGround, pCloud.xz / uCloudExtent).g;
  float t = posterizeShadow(exp(-opticalDepth * uCloudShadowAbs));
  // Floor, then fade by amount: a shadow that reaches 0 removes the terrain's
  // own cel banding entirely, which reads as a hole rather than as shade.
  return mix(1.0, max(t, uCloudShadowFloor), uCloudShadowAmt);
}

#ifdef FOREST_SITE_PASS
// One texel per forest lattice site: the root verdict forestSite() computes,
// for the site this texel stands for (see forest.glsl's site table).
void main() {
  vMatTime = uEnableTimeAxis ? uTime * uFBM0TimeSpeed : 0.0;   // as terrain.vert sets it
  gl_FragColor = forestSite(floor(gl_FragCoord.xy) + uForestSiteOrigin);
}
#else
void main() {
  // ── Normal ── analytic vertex normal from the derive-pass gradient (RT_B) ──
  vec3 normal = normalize(vNormal);

  // ── Art-pass G-buffer ────────────────────────────────────────────────────
  // Everything the divisionist pass needs to know about a terrain pixel, and
  // nothing else: the normal's HORIZONTAL part (strokes run along the contour,
  // which is perpendicular to the downhill direction, so only x and z are ever
  // read), a zero water flag, and alpha 1 to say a surface is here at all —
  // the target is cleared to zero, so sky is simply what stays untouched.
  //
  // Returns before classify(), the forest resolve, the lighting ladder and the
  // fog, which is the entire point: this is an extra full-scene pass and it
  // must not pay the fragment cost of the real one. Depth comes from the
  // hardware depth buffer attached to the same target, so it is not encoded
  // here — which is what frees all four channels for the rest.
  if (uArtData > 0.5) {
    gl_FragColor = vec4(normal.x * 0.5 + 0.5, normal.z * 0.5 + 0.5, 0.0, 1.0);
    return;
  }

  float flatness  = clamp(normal.y, 0.0, 1.0);
  vec3  lightDir  = normalize(vec3(uSunAzimuth.x, uSunElevation, uSunAzimuth.y));
  float N_dot_L   = dot(normal, lightDir);

  // Normalised height in [0,1] stretched across the populated fBM range
  float treePFrag;
  float tH = clamp((vHeight + HEIGHT_MAX) / (2.0 * HEIGHT_MAX), 0.0, 1.0);
  tH = smoothstep(uHeightLo, uHeightHi, tH);

  // ── Debug views — raw classify() inputs, no lighting/fog ─────────────────
  //  1 height  2 flatness  3 aspect  4 concaveSmall  5 concaveLarge
  //  6 moisture  7 ridge map  8 erosion delta  9 hollowness  10 biome id
  //  11 surface normal (RGB)  12 raw N·L (diverging)  13 forest cover
  //  14 bedrock/mantle select
  // ramp: dark→bright for [0,1]; diverging: blue(−)·white(0)·red(+) for [−1,1].
  if (uDebugView > 0.5) {
    vec3  dbg;
    vec3  rawProbe = vec3(0.0);   // the underlying signal value (see uProbeRaw)
    if (uDebugView < 1.5) {
      rawProbe = vec3(vHeight);   // world-space height
      dbg = mix(vec3(0.04, 0.05, 0.15), vec3(1.0, 0.97, 0.55), clamp(tH, 0.0, 1.0));
    } else if (uDebugView < 2.5) {
      rawProbe = vec3(flatness);
      dbg = mix(vec3(0.85, 0.20, 0.10), vec3(0.95, 0.97, 1.0), clamp(flatness, 0.0, 1.0)); // steep red → flat white
    } else if (uDebugView < 5.5) {
      // signed axes share the diverging ramp
      float s = (uDebugView < 3.5) ? aspect(normal)
              : (uDebugView < 4.5) ? concaveSmall()
              :                      concaveLarge();
      rawProbe = vec3(s);
      dbg = (s < 0.0) ? mix(vec3(1.0), vec3(0.10, 0.30, 0.95), -s)
                      : mix(vec3(1.0), vec3(0.95, 0.25, 0.10),  s);
    } else if (uDebugView < 6.5) {
      float m = drainMoisture(flatness);
      rawProbe = vec3(m);
      dbg = mix(vec3(0.80, 0.70, 0.42), vec3(0.10, 0.32, 0.90), m); // dry→wet
    } else if (uDebugView < 7.5) {
      rawProbe = vec3(vRidge);
      dbg = mix(vec3(0.05, 0.10, 0.45), vec3(1.0), vRidge * 0.5 + 0.5);
    } else if (uDebugView < 8.5) {
      rawProbe = vec3(vErosion);
      dbg = mix(vec3(0.85, 0.15, 0.10), vec3(0.15, 0.85, 0.25), vErosion * 0.5 + 0.5);
    } else if (uDebugView < 9.5) {
      // combined hollowness (coast-safe): blue ridge → red valley
      float hv = hollowness();
      rawProbe = vec3(hv);
      dbg = (hv < 0.0) ? mix(vec3(1.0), vec3(0.10, 0.30, 0.95), -hv)
                       : mix(vec3(1.0), vec3(0.95, 0.25, 0.10),  hv);
    } else if (uDebugView < 10.5) {
      // biome id — flat colour key per material
      vec3 lit; float glow; float shadeDbg; float pDbg;
      GroundField gd = groundFieldHere();
      float id = classifyAt(tH, gd.flatness, gd.asp, gd.cS, gd.cL,
                            hollownessAt(gd.cS, gd.cL), vHeight,
                            matFieldSigned(uBandNoiseScale, 11.3) * uBandNoiseAmt,
                            0.0, 0.0, lit, glow, shadeDbg, pDbg);
      rawProbe = vec3(id);
      dbg = id < 0.5 ? vec3(0.12, 0.40, 0.15)   // forest
          : id < 1.5 ? vec3(0.55, 0.80, 0.30)   // meadow
          : id < 3.5 ? vec3(0.55, 0.52, 0.48)   // rock
          : id < 4.5 ? vec3(0.98, 0.99, 1.0)    // snow
          : id < 5.5 ? vec3(0.20, 0.85, 0.55)   // riparian
          :            vec3(0.85, 0.75, 0.45);   // seabed
    } else if (uDebugView < 11.5) {
      // surface normal as RGB (x→R, y→G, z→B, remapped [-1,1]→[0,1]):
      // flat ground = green (0.5, 1, 0.5); slopes tint red/blue by facing.
      // Shows exactly the interpolated normal the lighting uses.
      rawProbe = normal;            // raw signed normal (probe wants no remap)
      dbg = normal * 0.5 + 0.5;
    } else if (uDebugView < 12.5) {
      // raw N·L against the live sun direction — the exact scalar the
      // diffuse ladder quantizes. Diverging ramp: blue away · white grazing ·
      // red sunlit.
      rawProbe = vec3(N_dot_L);
      dbg = (N_dot_L < 0.0) ? mix(vec3(1.0), vec3(0.10, 0.30, 0.95), -N_dot_L)
                            : mix(vec3(1.0), vec3(0.95, 0.25, 0.10),  N_dot_L);
    } else if (uDebugView < 13.5) {
      // forest cover — 0 in a clearing (or off-biome) … 1 under a crown apex.
      float cover; int spDbg;
      forestResolve(vMatXZ / max(uForestCell, 0.01), normal, tH, groundFieldHere(), cover, spDbg);
      rawProbe = vec3(cover);
      dbg = mix(vec3(0.55, 0.50, 0.35), vec3(0.06, 0.35, 0.12), cover); // bare → forest
    } else {
      // bedrock/mantle select — 1 where the bedrock field is exposed, 0 where the
      // mantle buries it. The contour between the two IS the soil line, so this view
      // is how you judge whether it reads as a line or as scatter.
      rawProbe = vec3(vBedrock);
      dbg = mix(vec3(0.20, 0.45, 0.30), vec3(0.80, 0.62, 0.42), vBedrock); // mantle → bedrock
    }
    // Signal tests read the raw value from a float RT; humans read the ramp.
    gl_FragColor = uProbeRaw > 0.5 ? vec4(rawProbe, 1.0) : vec4(dbg, 1.0);
    return;
  }

  // ── Biome + painterly colour (see includes/material.glsl) ──────────
  // Shade: N·L remapped through [uShadeLo, uShadeHi] instead of a fixed
  // half-Lambert — with the sun overhead N·L almost never goes negative, so
  // half-Lambert's [-1,1]→[0,1] would waste the lower half of the range and only
  // the top cel bands would fire. Then cel-posterized; blends each material's derived SHADOW colour → its
  // sunlit colour — a hue shift, not a multiply, so no mud.
  // Soft "underwater" shading reaches a hair above the waterline so the
  // shoreline transition isn't a hard line.
  const float UNDERWATER_MARGIN = 1.0;

  // Material is resolved FIRST: the forest needs the forest belt and the
  // treeline distance, and its relief normal must never reach classify()
  // (crown-scale classification is speckle, and it would move the exact-tier
  // signals). classify() does not read shade, so hoisting it is safe.
  vec3  lit;
  float glow;
  float shadeAmt;
  // Classification reads the terrain FIELD (a derive-map texel), not the mesh
  // interpolant. The forest evaluates the same classifier at each tree root
  // from the same texels; if this fragment used the interpolated varyings
  // instead, the two would disagree wherever the mesh is coarser than the map —
  // i.e. on crests, which is exactly where snow patches sit — and trees would
  // appear on ground the material had already called snow.
  // The interpolated `normal` is still what LIGHTS the surface; only the
  // classification moves to the field (groundFieldHere, material.glsl): the
  // slope and the two ring means come from the derive-map texel, the height is
  // still the interpolated vHeight. The forest's own classification (its dense-
  // stand fill and far-field coverage) reads the same field. Only the signal
  // tests' wrappers (classify(), concaveSmall()) still read the varyings.
  GroundField ground = groundFieldHere();
  float matId = classifyAt(tH, ground.flatness, ground.asp, ground.cS, ground.cL,
                           hollownessAt(ground.cS, ground.cL),
                           vHeight, matFieldSigned(uBandNoiseScale, 11.3) * uBandNoiseAmt,
                           0.0, 0.0, lit, glow, shadeAmt, treePFrag);

  // ── Forest (see includes/forest.glsl) ─────────────────────────────────────
  // Trees are placed by their own PROBABILITY field, not clipped to the forest
  // material: a crown near the belt edge is a whole crown standing on meadow,
  // not a crown sliced along a biome contour. So this runs for any land
  // fragment and crowns paint forest wherever they land. Inside the forest belt
  // the probability is 1, so the dense-stand fill covers every gap and no forest
  // ground is left bare.
  //
  // Two different "underwater" questions, deliberately kept apart:
  //
  //   submerged  — is REAL water actually rendered on top of this exact
  //                fragment? The water mesh sits at (roughly) uSeaLevel, so
  //                vHeight < uSeaLevel with NO margin is the honest answer —
  //                ripples move the true surface a little above or below
  //                that flat reference, the same approximation shoreDist
  //                already makes for the sand band below. A submerged
  //                fragment must never paint as a tree: the water is visibly
  //                in front of it, whatever crown happens to reach overhead.
  //
  //   underwater — the SOFTER, padded version (+ UNDERWATER_MARGIN) used only
  //                to blur the water's own shading transition (glow/cel-ladder
  //                below) so the shoreline doesn't read as a hard line. This
  //                padding would push the "no trees" line a metre inland of the
  //                actual water: ordinary DRY sand within that metre of the
  //                shore would have its crowns cut for no visible reason. Trees
  //                are gated on `submerged` alone, never on the padded one.
  bool submerged = vHeight < uSeaLevel;
  bool underwater = vHeight < uSeaLevel + UNDERWATER_MARGIN;

  vec3  shadeNormal = normal;
  float cover = 0.0;
  int   forestSp = 0;
  if (uForestOn > 0.5 && !submerged) {
    shadeNormal = forestResolve(vMatXZ / max(uForestCell, 0.01), normal,
                                tH, ground, cover, forestSp);
  }
  if (underwater) glow = 0.0;  // no alpenglow through the water column

  float shade = smoothstep(uShadeLo, uShadeHi, dot(shadeNormal, lightDir));
  if (underwater) {
    // A submerged floor isn't lit by a crisp directional sun — water scatters
    // it into soft, low-contrast ambient light, and no cel banding (nothing
    // this diffuse posterizes cleanly).
    shade = mix(0.55, shade, 0.3);
  }
  shade = uEnableDiffuse ? clamp(shade, 0.0, 1.0) : 1.0;
  if (uLightSteps >= 1.0 && !underwater) {
    // Antialiased cel ladder. A bare ceil() puts a zero-width tonal cliff at
    // every band boundary; with antialias:false and a per-fragment normal
    // perturbation riding on top, those cliffs crawl. Ramping each boundary
    // over its own screen footprint costs one fwidth and collapses back to the
    // hard step wherever the footprint is small (near field, large flat tone
    // areas), so the posterized look is unchanged where it reads.
    float q = shade * uLightSteps;
    float n = floor(q);
    float w = clamp(fwidth(q), 1e-5, 0.5);
    shade = (n + smoothstep(0.0, w, q - n)) / uLightSteps;
  }
  // Cloud shadow goes AFTER the cel ladder, and that placement is the whole
  // difference between a shadow you can see the shape of and a grey wash.
  //
  // Before it, the ladder's floor() re-buckets the PRODUCT `shade * t`. `shade`
  // varies continuously with the surface normal, so a tier boundary in the
  // shadow lands at a different place on every slope and the shadow's own
  // contour is scattered across the terrain's shading instead of drawn. Measured
  // that way, the on/off ratio over the land spread across 20 buckets with no
  // peaks — a smooth wash.
  //
  // After it, both factors are piecewise constant, so their product is too, and
  // the shadow keeps its own hard (antialiased) edges. It still passes through
  // shadeMaterial below, so a shadowed patch still falls toward each material's
  // OWN authored floor — snow stays luminous in shade, forest drops to mass.
  shade *= cloudSunlight(vec3(vWorldXZ.x, vHeight, vWorldXZ.y), lightDir);
  applyShoreMaterial(lit, glow, shadeAmt, flatness, matId);  // sand → lit (gets shaded)

  // Forest has the last word on material: a crown paints forest wherever it
  // stands. Forest ground itself is always covered, because the classifier and
  // the forest read the same ground field, so a fragment the classifier calls
  // forest has probability 1 and the dense-stand fill covers it.
  // Deliberately AFTER applyShoreMaterial: the sand band keys off height, so
  // resolving the forest before it would let the beach repaint crowns as sand
  // and would strip rock/snow of their sand immunity.
  if (uForestOn > 0.5 && !submerged) {
    if (cover > 0.0) {
      // The tree takes its species' colour, but the same alpenglow/shadow
      // floor as ordinary forest ground.
      matId = MAT_FOREST;
      lit = uSpColor[forestSp]; glow = uGlowForest; shadeAmt = uShadeForest;
    }
  }
  vec3  color = shadeMaterial(lit, glow, shadeAmt, shade);

  // ── How much light is falling here ────────────────────────────────────────
  // A grey day is not only flatter than a sunny one, it is DARKER, and the two
  // are separate axes: uShadowValue lifts the dark end toward the light end
  // (flattening) while this scales both ends together (level). Driving only the
  // first makes overcast read as "the same day with weaker shadows".
  //
  // Physically the land loses far more light than the sky does — a clear day is
  // ~100 klx on the ground against an overcast day's ~5-20 klx, while the
  // overcast sky's own luminance is comparable to or above a clear sky's. So
  // the land/sky ratio INVERTS: the lid reads as glare and the ground goes dark
  // against it. That is why this sits here, after shading and before the aerial
  // block: uFogColor is the sky, and leaving it alone is what produces the
  // inversion rather than a uniform dimming of the whole frame.
  //
  // After shadeMaterial rather than on `lit` before it, because applyGlow mixes
  // toward the CONSTANT uGlowHue: scaling `lit` first would leave the alpenglow
  // at full brightness and let it take over the frame as the light drops.
  color *= uLightLevel;

  // ── Fog (distance desaturation + melt toward sky) ─────────────────────────
  // Distance doesn't just fog — it desaturates local colour and lifts it
  // toward the cool sky tint.
  if (uEnableFog) {
    float depth = gl_FragCoord.z / gl_FragCoord.w;
    float t     = clamp((depth - uFogNear) / (uFogFar - uFogNear), 0.0, 1.0);
    // Reshape the ramp (uFogCurve: >1 stays clear longer then fades quickly,
    // <1 fades early; 1 = linear) and cap how far it can go (uFogMaxAlpha: 1 =
    // full melt at uFogFar). Both must stay identical to water.frag's copy.
    t = pow(t, uFogCurve) * uFogMaxAlpha;
    float lum = dot(color, vec3(0.299, 0.587, 0.114));
    color = mix(color, vec3(lum), t * uAerialDesat);  // haze washes out local hue
    color = mix(color, uFogColor, t);                  // then melt toward sky
  }

  gl_FragColor = vec4(color, 1.0);
}
#endif
