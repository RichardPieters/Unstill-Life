// forest.glsl — Crown Lattice Relief: fragment-stage forest canopy.
//
// Injected into terrain.frag AFTER material.glsl (it reads uCliffFlat and the
// palette uniforms declared there).
//
// What it is: a jittered triangular lattice of crowns, each a rim-faded
// paraboloid, evaluated as a HEIGHT FIELD at the fragment's own xz. A fragment
// visits 3 lattice sites (25 when a crown outgrows the 3-site bound), each
// reading one texel of the per-site table (see "Site table"). Two outputs:
//   • cover  — how much crown is over this point [0,1]; perforates the forest
//              material into clearings, so a thinning treeline reads as
//              individual trees on meadow rather than a wobbled contour.
//   • normal — the crown-relief normal, used for LIGHTING ONLY.
//
// Two normals, deliberately: the TERRAIN normal keeps driving flatness,
// aspect() and classify(), so biome placement never sees crown-scale detail,
// which would read as speckle. The forest normal
// reaches nothing but the shade ladder.
//
// NOT here: parallax, view-ordered occlusion, any silhouette change. A
// fragment shader can only shade fragments the rasterizer produced, so no
// crown can ever break the terrain outline against the sky.

uniform float uForestOn;        // 0 = off (all forest code short-circuits)
uniform float uForestCell;      // lattice pitch, WORLD units
uniform float uForestJitter;    // jitter half-extent, FIELD units
uniform float uForestDepth;     // cel tone steps a crown may swing (see below)
uniform float uForestGrow;      // probability window a tree appears over. Small
                                // = whole tree or none; larger trades that for
                                // temporal calm as the terrain morphs.
uniform float uForestClose;     // density above this → solid forest fill
uniform float uForestFillPad;   // how far past a biome edge the fill bleeds
// Distance fade, in units of screen-footprint / crown radius. That ratio is
// 2 / (crown width in pixels), so 0.5 is a 4-pixel crown and 1.5 is a ~1.3-pixel
// one. Starting the fade while crowns are still many pixels wide is a mistake:
// the far-field term is a binary "mostly forest?" mask that steps across a
// biome border, so ANY lod < 1 mixes part of that step into the crowns and
// slices the ones straddling a border.
uniform float uForestLodHi;     // footprint/radius where crowns are gone entirely; the fade starts at 2/3 of it
uniform float uForestSmooth;    // smooth-max blend width between crowns
// ─── Crown form ──────────────────────────────────────────────────────────────
// Every shape term below is always on; the VALUES are per-species arrays
// (below). uForestWobbleFlat/uForestSlopeForm/uForestHeightFlat are value
// knobs, not toggles — they modulate how strongly a term couples to flatness/
// steepness, and stay live-adjustable.
uniform float uForestWobbleFlat;// flat ground gets the full bite, cliffs less
uniform float uForestSlopeForm; // 0 = shape everywhere · 1 = shape only on slopes
uniform float uForestHeightFlat;// 0 = height ignores slope · 1 = height ∝ flatness

// ─── Species ─────────────────────────────────────────────────────────────────
// A species is a crown shape plus a colour. WHERE each grows is not decided
// here — it falls out of the biome under the tree's root, mapped once in
// speciesFor() below. Values live in src/terrain/treeSpecies.js, which seeds these
// arrays and generates the panel; index order there IS the id here.
//
// Dynamic indexing of a uniform array in the fragment stage needs GLSL ES 3.00,
// which is what we get: three's ShaderMaterial prepends `#version 300 es`
// unconditionally and the renderer is WebGL2-only (the `texture2D`/`varying`
// in these files are three's ESSL1 compatibility defines, not evidence of an
// ESSL1 target).
const int CAN_SPECIES = 2;
uniform float uSpRadius[CAN_SPECIES];   // crown radius, FIELD units
uniform float uSpCone[CAN_SPECIES];     // 0 rounded (d² family) · 1 cone, pointed
uniform float uSpProfile[CAN_SPECIES];  // falloff exponent: 1 = paraboloid ·
                                        // 2 flatter dome · 0.5 half-capsule
uniform float uSpElong[CAN_SPECIES];    // 1 = circular; >1 reads as a spire
uniform float uSpLean[CAN_SPECIES];     // linear tilt → teardrop
uniform float uSpHeight[CAN_SPECIES];   // crown height multiplier
uniform float uSpWobble[CAN_SPECIES];   // ragged-outline bite depth
uniform float uSpWobFreq[CAN_SPECIES];  // lobes around the outline
uniform float uSpSizeVar[CAN_SPECIES];  // radius spread, +/- fraction
uniform float uSpAmpVar[CAN_SPECIES];   // height spread, +/- fraction
uniform vec3  uSpColor[CAN_SPECIES];    // sunlit crown colour
// The data map and the derive map are sampled at each crown's ROOT (forestSite),
// so slope and concavity are the tree's own, not the shading fragment's. They
// are declared in terrain.frag, above material.glsl.
// The drift between the material frame and the world (terrain.vert), so
// forestSite can place a root in both without a fragment's varyings.
uniform vec2      uFBM0DriftOffset;

// Simplex skew constants, used here purely as a LATTICE LOCATOR (no noise).
// The skew maps the integer square grid to an equilateral triangular lattice
// with site spacing a = sqrt(2/3); verified by |e1| = |e2| = |e1+e2| = 0.8165
// and e1·e2/(|e1||e2|) = -0.5.
const float CAN_F2 = 0.36602540378;   // (sqrt(3)-1)/2
const float CAN_G2 = 0.21132486540;   // (3-sqrt(3))/6
const float CAN_A  = 0.81649658;      // site spacing, field units

// 3-tap exactness bound. The nearest lattice site that is NOT one of the three
// triangle corners is one triangle-height away, at an edge midpoint:
// 0.866*a = 0.7071. While radius + jitter stays under that, evaluating only the
// three corners is EXACT — no missed crowns, no seams. Exceed it and crowns
// lose crescent-shaped bites at their rims. forestResolve takes the 3-site path
// only while the widest realised reach stays under it, else the 5x5 block.
const float CAN_SUPPORT = 0.70711;

// Reach of the 5x5 skewed block, the fallback when a crown outgrows the 3-tap
// bound. Measured by brute force, not assumed: a 3x3 block covers exactly the
// same 0.7071 as the three corners (it adds the wrong six neighbours), so the
// next useful step is 5x5, which covers precisely twice the reach.
const float CAN_SUPPORT2 = 1.41421;

// Outer fraction of the radius over which a crown fades out. The bare
// paraboloid h = 1-u has a C0 slope kink at the rim (slope jumps to zero
// outside); fading it out with a smoothstep makes BOTH h and its gradient
// vanish there, so crowns join with no crease — closed by construction.
const float CAN_RIM = 0.18;

// Tip rounding for the cone profile, as a fraction of the crown radius. A true
// cone is C1-discontinuous at its apex (the normal direction flips), which would
// sparkle; this is the smooth-abs sqrt(d² + eps²) remedy uRidgeRound applies to
// ridge crests. With it the gradient goes to zero at the centre
// instead of flipping, so the tip is merely rounded over eps.
const float CAN_TIP = 0.13;

// Highest harmonic the outline wobble can reach, and so the loop's trip count.
// The frequency knob slides a window across k = 1 … this. Two reasons not to
// raise it: every step costs a complex multiply whether it is inside the window
// or not, and a lobe count much past this is finer than a crown's own screen
// footprint at the viewing distances that matter, which aliases rather than
// reading as detail. The frequency slider's top is kept a window-width below
// it so the band never runs off the end and starves the normaliser.
const int CAN_WOB_K = 9;

// Crown form, bundled so canCrown's signature stays readable.
struct CrownForm {
  float cone; float prof; float elong; float lean; float sizeV; float ampV;
  float wob;       // outline bite depth, 0 = a clean ellipse
  float wobFreq;   // lobes around the crown
  float wobFlat;   // how strongly flatness scales the bite depth
  float slope;     // how strongly steepness gates elong + lean
  float hgt;       // crown height multiplier
  float hgtFlat;   // how strongly height tracks flatness
  float radius;    // crown radius, before the per-crown size roll and the clamp
};

// Which species grows on which ground — the ONLY place that mapping lives.
// The input is classifyAt's own material verdict at the tree's ROOT, which
// forestSite already computes for the probability. Deriving the species from it
// means a species can never disagree with the biome about
// where it grows: no new thresholds, and nothing to keep in sync.
//
// The material verdict is used rather than the floor cascade's binding gate on
// purpose. The floor cascade runs on EDGE-JITTERED margins, so near a boundary
// it deliberately disagrees with the ground by up to half a gate band — right
// for deciding whether a tree exists, wrong for deciding what it looks like,
// which would type a scattered tree by a biome it is not standing in.
int speciesFor(float matRoot) {
  return matRoot == MAT_RIPARIAN ? 1 : 0;   // 0 = conifer, the default
}

// This species' form. Every shape term is always on; the value knobs
// (wobFlat/slope/hgtFlat) set how strongly a term couples to flatness/steepness.
CrownForm speciesForm(int sp) {
  CrownForm fm;
  fm.cone    = uSpCone[sp];
  fm.prof    = uSpProfile[sp];
  fm.elong   = uSpElong[sp];
  fm.lean    = uSpLean[sp];
  fm.wob     = uSpWobble[sp];
  fm.wobFreq = uSpWobFreq[sp];
  fm.wobFlat = uForestWobbleFlat;
  fm.sizeV   = uSpSizeVar[sp];
  fm.ampV    = uSpAmpVar[sp];
  fm.slope   = uForestSlopeForm;
  fm.hgt     = uSpHeight[sp];
  fm.hgtFlat = uForestHeightFlat;
  fm.radius  = uSpRadius[sp];
  return fm;
}

// How far a crown of this form reaches, as a multiple of its radius. Elongation
// stretches it and lean shifts it, and both slope fades only ever SHRINK the
// realised values below these (sw is in [0,1]), so this stays an upper bound.
float canExtent(CrownForm fm) {
  return max(fm.elong, 1.0) * (1.0 + abs(fm.lean));
}

// The largest radius this species may actually use. Each species is clamped
// against its OWN reach, not a shared worst case: a round species (elongation
// near 1) can spend the whole support budget on width, while a strongly
// elongated one spends it on length. Sharing one clamp would let the most
// elongated species cap the width of every other one.
//
// Exactness still holds per crown, because the requirement is per crown:
// realised extent = R * canExtent <= (CAN_SUPPORT2 - jitter), for every species
// independently. Only the choice of CANDIDATE SET is global — see forestResolve.
float speciesRadiusCap(CrownForm fm) {
  return min(fm.radius * (1.0 + fm.sizeV),
             (CAN_SUPPORT2 - uForestJitter) / max(canExtent(fm), 1e-3));
}

// ─── Hash ─────────────────────────────────────────────────────────────────────
// hash42 from David Hoskins' "Hash without Sine" (https://www.shadertoy.com/view/4djSRW),
// MIT License, Copyright (c)2014 David Hoskins.; full text in
// LICENSES/hash-without-sine-MIT.txt. Four decorrelated values per cell, no sin (whose
// large-argument behaviour is driver-dependent, and the lattice origin drifts).
// xy = jitter, z = size variation, w = existence roll.
// Precision note: the drift offset grows monotonically, so cell indices grow
// without bound. Fine to ~1e5 cells; beyond that the hash degrades and the
// origin would need splitting into integer + fractional parts JS-side.
vec4 canHash4(vec2 c) {
  vec4 p = fract(c.xyxy * vec4(0.1031, 0.1030, 0.0973, 0.1099));
  p += dot(p, p.wzxy + 33.33);
  return fract((p.xxyz + p.yzzw) * p.zywx);
}

// The tree probability comes from classifyAt() in material.glsl, evaluated at
// the crown's own root. Every gate's condition is written exactly once there and
// drives both the material verdict and this probability, so the forest cannot
// disagree with the biome about where trees may stand.

// ─── Smooth max ───────────────────────────────────────────────────────────────
// Plain max() would make the tallest crown win outright — but its gradient is
// discontinuous where two domes meet, and since crowns must overlap for a
// closed forest, that puts a connected honeycomb of hard creases over the whole
// forest. This blends over a width k and returns the blend weight so the
// gradient can be carried across with it. Inigo Quilez's polynomial smooth
// minimum, mirrored to a maximum (https://iquilezles.org/articles/smin/).
float canSmoothMax(float a, float b, float k, out float w) {
  w = clamp(0.5 + 0.5 * (a - b) / max(k, 1e-5), 0.0, 1.0);
  return mix(b, a, w) + k * w * (1.0 - w);
}

// ─── Site table ───────────────────────────────────────────────────────────────
// One texel per lattice site, rebuilt once per frame by terrain.js's site pass
// (terrain.frag compiled with FOREST_SITE_PASS, which writes forestSite(cell)).
// Texel (0,0) holds lattice site uForestSiteOrigin; terrain.js sizes the table
// to cover every site any fragment of the plane can reach (forestSites.js).
uniform sampler2D uForestSites;
uniform vec2      uForestSiteOrigin;

// The verdict at one lattice site's ROOT: x = existence [0,1], y = species,
// zw = the ground gradient there. Every input is a function of the site alone —
// its hash and its root position — never of the fragment looking at it, which
// is what lets it be computed once per site instead of once per fragment per
// candidate (~11 candidates survive the pre-reject per fragment).
//
// The root in the material (drift) frame is the site's unskewed lattice point
// plus its jitter, in field units, times the cell size; the world frame is the
// same point minus the drift (terrain.vert: vMatXZ = vWorldXZ + uFBM0DriftOffset).
vec4 forestSite(vec2 cell) {
  vec4  hash      = canHash4(cell);
  float cellSize  = max(uForestCell, 0.01);
  vec2  rootField = cell - (cell.x + cell.y) * CAN_G2 + (hash.xy - 0.5) * (2.0 * uForestJitter);
  vec2  rootMat   = rootField * cellSize;
  vec2  rootUV    = clamp((rootMat - uFBM0DriftOffset) / uPlaneSize + 0.5, 0.001, 0.999);
  // The edge wobble at the ROOT. Left out, the tree boundary would sit on the
  // unwobbled line while the material boundary is wobbled by uBandNoiseAmt, and
  // the two would disagree by far more than any gate band — trees would appear
  // past a biome edge no matter how the floors were set.
  float bandNoiseRoot = matFieldSignedAt(rootMat, uBandNoiseScale, 11.3) * uBandNoiseAmt;
  vec4  rootDerive    = texture2D(uDeriveMap, rootUV);
  // Height AT THE ROOT, from the height map — not transported from a fragment.
  // Every input to the verdict is a function of the ROOT POSITION alone, which
  // is what makes a crown one indivisible decision.
  float hTree = texture2D(uDataMap, rootUV).r;
  // The crown's own normalised height — the gates are re-evaluated against it.
  float rootHeightNorm = smoothstep(uHeightLo, uHeightHi,
                            clamp((hTree + HEIGHT_MAX) / (2.0 * HEIGHT_MAX), 0.0, 1.0));
  float rootFlatness = inversesqrt(1.0 + dot(rootDerive.rg, rootDerive.rg));   // = normal.y at the root
  float rootAspect   = aspectFromGrad(rootDerive.rg);
  float rootConcaveSmall = concaveSmallAt(hTree, rootDerive.a);
  float rootConcaveLarge = concaveLargeAt(hTree, rootDerive.b);
  float rootHollowness   = hollownessAt(rootConcaveSmall, rootConcaveLarge);
  // Per-tree edge offset. Must NOT reuse hash.z — that already sets the crown
  // radius, so sharing it would push systematically the larger crowns across
  // every border and the spill would read as a deliberate fringe.
  float edgeJitter = fract(hash.x * 31.7 + hash.w * 17.3) - 0.5;

  vec3 lRoot; float gRoot, sRoot, treeProbability;
  float matRoot = classifyAt(rootHeightNorm, rootFlatness, rootAspect, rootConcaveSmall, rootConcaveLarge, rootHollowness,
                             hTree, bandNoiseRoot, edgeJitter, 0.0, lRoot, gRoot, sRoot, treeProbability);

  // Existence: a stable per-cell roll against the root's probability. The
  // window is a slider — at its floor a tree is simply there or not, at full
  // size, which is what reads correctly when a gate slider is swept.
  float existence = clamp((treeProbability - hash.w) / max(uForestGrow, 1e-4), 0.0, 1.0);
  return vec4(existence, float(speciesFor(matRoot)), rootDerive.rg);
}

// ─── One crown ────────────────────────────────────────────────────────────────
// Rim-faded paraboloid. With v = 1 - d²/R² (1 at the apex, 0 at the rim):
//   rimFade      = smoothstep(0, CAN_RIM, v)          rim fade
//   crownHeight  = amp * v * rimFade
//   dh/dv        = amp * (rimFade + v * rimFade')
//   dv/dd        = -2d / R²
//   grad         = (dh/dv) * (-2d / R²)            <- analytic, in FIELD units
// Both crownHeight and grad vanish at the rim (smoothstep has zero derivative
// at both ends), so the crown is C1 there.
void canCrown(vec2 siteOffset, vec2 cell, float boundAll,
              inout float heightAccum, inout vec2 gradAccum, inout float bestCrownDepth, inout int winningSpecies) {
  vec4  hash        = canHash4(cell);
  vec2  crownOffset = siteOffset - (hash.xy - 0.5) * (2.0 * uForestJitter);

  // Conservative CIRCULAR pre-reject. The real support test is anisotropic and
  // needs the fall line, which comes from the site table below — so reject the
  // hopeless candidates first and only pay for the fetch where a crown can
  // plausibly reach. boundAll is the caller's WORST CASE ACROSS SPECIES, since
  // the species is part of the site's verdict; that makes this test accept a
  // superset, never a subset, which is the safe direction.
  if (dot(crownOffset, crownOffset) > boundAll * boundAll) return;

  // Everything decided at the ROOT — whether the tree exists, its species, the
  // ground gradient under it — is a function of the site alone, so it is read
  // from the per-site table (forestSite, baked once per frame) rather than
  // re-derived here by every fragment that can see this crown.
  ivec2 siteTexel = ivec2(cell - uForestSiteOrigin);
  if (any(lessThan(siteTexel, ivec2(0))) ||
      any(greaterThanEqual(siteTexel, textureSize(uForestSites, 0)))) return;
  vec4  site     = texelFetch(uForestSites, siteTexel, 0);
  float existence = site.x;
  if (existence <= 0.0) return;
  vec2  rootGrad = site.zw;

  // Steepness of the ground under THIS tree, normalised across the whole band
  // of flatness a tree can stand on: 0 where the ground is as flat as
  // FLAT_FULL, 1 at uCliffFlat, where classify() hands the surface over to
  // rock. Both endpoints are ones the biome system already owns, so gating on
  // slope introduces no new threshold. Per-crown (a function of the ROOT
  // gradient alone), so it cannot slice a crown the way a fragment-dependent
  // shape term would.
  float rootFlatness = inversesqrt(1.0 + dot(rootGrad, rootGrad));   // = normal.y at the root
  float flatBlend  = smoothstep(min(uCliffFlat, FLAT_FULL - 0.02),
                            FLAT_FULL, rootFlatness);        // 1 = flat, 0 = cliff
  float steepBlend = 1.0 - flatBlend;

  // Species, and with it this crown's whole form. Resolved from the ROOT's
  // material, so every fragment under one crown agrees — the invariant this
  // file exists to protect.
  int       species = int(site.y + 0.5);
  CrownForm form     = speciesForm(species);
  // Clamp AFTER the per-crown size roll, not before: the bound is on the
  // realised radius, and a size roll would otherwise walk past it.
  float R   = min(form.radius * (1.0 + form.sizeV * (hash.z * 2.0 - 1.0)),
                  speciesRadiusCap(form));
  float r2  = max(R * R, 1e-6);

  // ── Crown shape ───────────────────────────────────────────────────────────
  // Fall-line frame at the ROOT (not this fragment — a fragment-dependent shape
  // would slice the crown, the bug this whole design exists to avoid). The
  // gradient points uphill, so stretching along it makes a crown project like a
  // standing spire on any slope facing the camera, world-stably.
  float gradLen      = length(rootGrad);
  vec2  fallLineAxis = gradLen > 1e-5 ? rootGrad / gradLen : vec2(1.0, 0.0);
  vec2  acrossAxis   = vec2(-fallLineAxis.y, fallLineAxis.x);
  // Elongation and lean read as tree shape on a slope, but on flat ground the
  // fall line is meaningless (its direction is whatever the residual gradient
  // happens to be) and both terms smear the crown into an arbitrary direction.
  // So fade both toward neutral with flatness. form.slope is how much of that
  // fade to apply; 0 = always on.
  float slopeWeight = mix(1.0, steepBlend, form.slope);
  float elongation  = max(mix(1.0, form.elong, slopeWeight), 0.05);
  float lean = form.lean * slopeWeight;
  float alongDist  = dot(crownOffset, fallLineAxis) / elongation;   // along the fall line, stretched
  float acrossDist = dot(crownOffset, acrossAxis);                  // across it
  float distSq = alongDist * alongDist + acrossDist * acrossDist;

  // ── Ragged outline ────────────────────────────────────────────────────────
  // A clean ellipse reads as geometry. Foliage reads as a lumpy edge, so bite
  // into the crown's support by an angular function of the crown-local
  // direction: a band of harmonics with per-tree weights and a per-tree
  // rotation, which is enough that no two crowns share an outline.
  //
  // Two knobs. AMPLITUDE (form.wob) is how deep the bites go. FREQUENCY
  // (form.wobFreq) is how many lobes go round the crown — it slides a triangular
  // weighting window across the harmonic series, so the lobe count moves
  // continuously while every harmonic ORDER stays an integer. That matters: a
  // fractional order is not 2π-periodic, so it would not close up on itself and
  // the crown would have a discontinuity along one radius.
  //
  // Harmonics come from the unit direction by repeated complex multiplication,
  // NOT from atan2. atan2 has a branch cut, and a cut running out of every
  // crown centre is a hard seam in the shading (a C1 failure). The recurrence is polynomial in the
  // direction, so it is smooth the whole way round.
  //
  // The bite only ever SHRINKS the support: wobbleMult >= 1, and a larger u is
  // a smaller crown. A wobble that could grow one would push its real extent
  // past the candidate-set bound, and the crown would lose crescent bites at
  // its rim — the artifact this feature exists to create, but in the wrong
  // place and shaped like the lattice rather than like a tree.
  //
  // Eased by steepness, the same way crown height is: a crown on a cliff is
  // seen nearly edge-on and its outline is compressed into a sliver, so bites
  // taken out of it read as noise on a thin shape rather than as foliage. On
  // flat ground the crown is seen face-on, where the outline is the whole of
  // what the eye has to go on and raggedness earns its keep.
  //   u = mix(d²/R², dSafe/R, cone) + lean*(along/R)
  // The first argument is the rounded d² family; the second is linear in
  // distance, which is what makes a CONE — the d² family cannot reach it, every
  // member of it has zero gradient at the apex. dSafe rounds the tip (CAN_TIP).
  // The lean term is a linear tilt rather than a piecewise scale, so the peak
  // moves off-centre without a crease through the crown.
  float dSafe = sqrt(distSq + CAN_TIP * CAN_TIP * r2);
  float profileBase = mix(distSq / r2, dSafe / R, form.cone) + lean * dot(crownOffset, fallLineAxis) / R;

  // The wobble below only ever multiplies u by wobbleMult >= 1, so where the
  // unwobbled profile is already at or past the rim (profileBase >= 1) this
  // crown cannot reach the fragment whatever its outline does: u >= 1, and the
  // support test further down returns. Return now instead, before paying for
  // the harmonic loop — most surviving candidates are crowns that exist but
  // do not cover this particular fragment. Exact: the same crowns return.
  if (profileBase >= 1.0) return;

  float wobbleAmp  = form.wob * mix(1.0, flatBlend, form.wobFlat);
  float wobbleMult = 1.0;
  vec2  wobbleMultGrad = vec2(0.0);          // d(wobbleMult)/d(crownOffset)
  if (wobbleAmp > 0.0 && distSq > 1e-9) {
    vec2 dirNorm = vec2(alongDist, acrossDist) * inversesqrt(distSq);
    // Per-tree rotation, as a unit vector so no trig is needed: rotating the
    // direction by it is one complex multiply.
    vec2 rot = normalize(vec2(fract(hash.x * 21.7 + hash.w * 4.3),
                              fract(hash.y * 13.9 + hash.z * 7.1)) * 2.0 - 1.0
                         + vec2(1e-3, 2e-3));
    dirNorm = vec2(dirNorm.x * rot.x - dirNorm.y * rot.y, dirNorm.x * rot.y + dirNorm.y * rot.x);

    // Walk k = 1 … CAN_WOB_K, accumulating cos(k*theta) weighted by a window
    // centred on the frequency knob. harmonic holds (cos k*theta, sin k*theta)
    // and advances by one complex multiply per step.
    float wobbleRaw      = 0.0;   // the wobble, before normalising
    float wobbleRawDeriv = 0.0;   // and its derivative in theta
    float wobbleNorm     = 1e-4;  // sum of |weight| — normalises wobbleRaw into [-1, 1]
    vec2  harmonic = dirNorm;
    for (int k = 1; k <= CAN_WOB_K; k++) {
      float fk = float(k);
      // Past the window's upper edge every remaining weight is 0: stop.
      if (fk >= form.wobFreq + 2.0) break;
      // Triangular window, two harmonics wide either side. Its kink is in the
      // SLIDER's response, not in the image: k is a loop constant and the
      // frequency is a uniform, so nothing per-fragment crosses it.
      float win = max(0.0, 1.0 - abs(fk - form.wobFreq) * 0.5);
      if (win > 0.0) {
        // Per-tree, per-harmonic weight. A fract-multiply hash of the cell
        // roll and k — no sin(), whose large-argument behaviour is
        // driver-dependent, and the lattice origin drifts without bound.
        float harmonicWeight = win * (fract((hash.z + fk * 0.7548776662) * 91.7
                                + hash.w * 13.3) * 2.0 - 1.0);
        wobbleRaw      += harmonicWeight * harmonic.x;
        wobbleRawDeriv -= harmonicWeight * fk * harmonic.y;      // d(cos k*theta)/d(theta) = -k sin k*theta
        wobbleNorm     += abs(harmonicWeight);
      }
      harmonic = vec2(harmonic.x * dirNorm.x - harmonic.y * dirNorm.y, harmonic.x * dirNorm.y + harmonic.y * dirNorm.x);
    }
    // |cos| <= 1 for every term, so |wobbleRaw| <= sum|weight| = wobbleNorm and
    // the normalised wobble lands in [-1, 1] whatever the rolls. That is what
    // makes the amplitude slider mean what it says, and what keeps wobbleMult >= 1.
    float inv = 1.0 / wobbleNorm;
    wobbleRaw      *= inv;
    wobbleRawDeriv *= inv;
    wobbleMult = 1.0 + wobbleAmp * 0.5 * (1.0 + wobbleRaw);                     // [1, 1+wobbleAmp]
    // d(theta)/d(crownOffset), mapped out of the anisotropic frame the same way
    // the radial term is. Singular at the centre, but it is multiplied by
    // profileBase below, which vanishes there faster — see the profileGrad assembly.
    vec2 thetaGrad = (-acrossDist) * fallLineAxis / elongation + alongDist * acrossAxis;
    wobbleMultGrad = (wobbleAmp * 0.5 * wobbleRawDeriv / distSq) * thetaGrad;
  }

  float u  = profileBase * wobbleMult;
  float v  = 1.0 - u;
  if (v <= 0.0) return;                       // outside this crown's support

  // ── Which crown owns this fragment's COLOUR ───────────────────────────────
  // A plain argmax on v — how deep inside the crown this fragment sits, 0 at
  // the rim and 1 at the apex. Three properties make v the right key, and each
  // of them is a bug avoided:
  //
  //   Order-independent. v is a function of this crown alone, so the winner
  //   does not depend on how many neighbours were visited first. Keying on the
  //   height ACCUMULATOR instead would, because the smooth-max inflates it by
  //   up to k/4 per overlap: a genuinely taller crown could lose to two
  //   already-blended shorter ones, and the winner would move with the
  //   unrelated `crown blend` slider.
  //
  //   Amplitude-independent. v carries no `existence` and no height
  //   multiplier, so a species does not colonise its neighbours' colour by
  //   being made TALLER, and a tree does not change species while it grows in
  //   through the `grow window` ramp.
  //
  //   Dimensionless. v is the fraction of the way from rim to apex, so it is
  //   comparable between species with very different radii.
  if (v > bestCrownDepth) { bestCrownDepth = v; winningSpecies = species; }

  float t = clamp(v / CAN_RIM, 0.0, 1.0);
  float rimFade      = t * t * (3.0 - 2.0 * t);         // smoothstep(0, CAN_RIM, v)
  float rimFadeDeriv = 6.0 * t * (1.0 - t) / CAN_RIM;   // d(rimFade)/dv

  // Height variance on a channel of its own — sharing hash.z (radius) or the
  // edge-jitter channel would correlate size with height and read as a bias.
  // Crown height. form.hgt is the global knob; form.hgtFlat couples it to the
  // ground, tall on flats and short on steeps — the alpine reading, where the
  // deep stands sit in basins and the cliff trees are stunted. This scales
  // crownHeight itself (not just the shading gradient the way uForestDepth
  // does), so a shorter tree is also a slightly smaller one through the cover
  // threshold and loses the smooth-max against its taller neighbours.
  float heightMult = form.hgt * mix(1.0, flatBlend, form.hgtFlat);
  float heightAmp  = existence * heightMult * (1.0 + form.ampV * (fract(hash.y * 19.7 + hash.z * 11.3) * 2.0 - 1.0));

  float vp = max(v, 1e-5);
  float profilePow   = pow(vp, form.prof);
  float profilePowM1 = pow(vp, form.prof - 1.0);
  float crownHeight      = heightAmp * profilePow * rimFade;
  float crownHeightDeriv = heightAmp * (form.prof * profilePowM1 * rimFade + profilePow * rimFadeDeriv);

  // du/d(crownOffset). radialDir is the anisotropic radial direction; the lean
  // adds a constant pull along the fall line. Finite at crownOffset = 0 because
  // dSafe >= CAN_TIP*R > 0.
  vec2  radialDir  = alongDist * fallLineAxis / elongation + acrossDist * acrossAxis;
  vec2  profileGrad = radialDir * ((1.0 - form.cone) * 2.0 / r2 + form.cone / (R * dSafe))
             + (lean / R) * fallLineAxis;
  // Product rule for u = profileBase * wobbleMult. The second term carries
  // wobbleMultGrad's 1/distSq, but profileBase vanishes at the centre at least
  // as fast as distSq for the rounded family and as fast as |d| for the cone,
  // so the product stays bounded there and the tip is smooth rather than
  // spiking to a black point.
  profileGrad = wobbleMult * profileGrad + profileBase * wobbleMultGrad;
  vec2  crownGrad = crownHeightDeriv * (-profileGrad);

  // The first crown to reach this fragment ASSIGNS. Smooth-maxing it against an
  // empty accumulator would add the blend term's constant (k/4) out of nothing,
  // inflating a lone crown into a hard-edged disc of its full support radius —
  // very visible at large blend widths. Only genuine overlaps blend.
  if (heightAccum <= 0.0) { heightAccum = crownHeight; gradAccum = crownGrad; return; }
  float w;
  float blendedHeight = canSmoothMax(crownHeight, heightAccum, uForestSmooth, w);
  gradAccum   = mix(gradAccum, crownGrad, w);   // gradient follows the blend
  heightAccum = blendedHeight;
}

// ─── Resolve ──────────────────────────────────────────────────────────────────
// p        field coordinate = vMatXZ / uForestCell (the drift frame the erosion
//          and material fields already ride — world space would let the
//          mountain slide out from under the trees)
// nTerrain the analytic terrain normal — NOT modified, only read
// g        the ground field at this fragment (groundFieldHere), which the dense-
//          stand fill and far-field coverage are classified from
// outCover  crown coverage [0,1], LOD-faded toward a solid mass with distance
// outSp     which SPECIES colours this fragment — the crown whose core is
//           nearest, or the ground's own species where no crown reaches
// returns   the crown-relief normal for lighting
vec3 forestResolve(vec2 p, vec3 nTerrain, float tH,
                   GroundField g, out float outCover, out int outSp) {
  outCover = 0.0;
  outSp    = 0;
  if (uForestOn < 0.5) return nTerrain;

  // Conservative reject, with margin: a crown centre can sit ~2 wu from this
  // fragment, which is worth up to ~0.065 of tH, so rejecting on the fragment's
  // own probability would clip crowns near the treeline. Reject only well
  // outside any gate's ramp.
  if (vHeight < uSeaLevel - 5.0) return nTerrain;

  // Terrain height gradient, world units. n = normalize(-gx, 1, -gz), so
  // -n.xz/n.y recovers (dh/dx, dh/dz). n.y is bounded away from zero here.
  vec2 terrainGrad = -nTerrain.xz / max(nTerrain.y, 0.15);

  float s  = (p.x + p.y) * CAN_F2;
  vec2  i  = floor(p + s);
  float t  = (i.x + i.y) * CAN_G2;
  vec2  x0 = p - (i - t);

  // ── The candidate set is a GLOBAL decision, so it takes the worst case ────
  // Each species clamps its own radius against its own reach (see
  // speciesRadiusCap), which is what keeps every individual crown inside the
  // support. But which SITES to visit has to be decided before any species is
  // known — the species comes out of a root classify that happens inside
  // canCrown — so the choice must cover the widest-reaching species. Two
  // consequences, both real and neither hidden:
  //
  //   One far-reaching species flips the WHOLE draw from 3 taps to 25, on every
  //   fragment, including ground where that species never grows.
  //   The pre-reject inside canCrown uses the same worst case, so rounder
  //   species pay for root fetches they then reject.
  //
  // The branch is still on uniforms only, so there is no per-fragment
  // divergence. tests/unit/forestLattice.test.js asserts the bounds.
  float boundAll = 0.0;   // widest realised extent over all species
  float radAll   = 0.0;   // and their widest realised radius (for LOD)
  for (int s = 0; s < CAN_SPECIES; s++) {
    CrownForm form = speciesForm(s);
    float     rc   = speciesRadiusCap(form);
    boundAll = max(boundAll, rc * canExtent(form));
    radAll   = max(radAll, rc);
  }

  float accumHeight = 0.0;
  vec2  accumGrad   = vec2(0.0);
  float bestCrownDepth  = 0.0;   // deepest-inside-a-crown seen, the colour argmax key
  int   winningSpecies  = -1;    // …and its species; -1 = no crown reached here
  if (boundAll + uForestJitter <= CAN_SUPPORT) {
    // Fast path: the three simplex corners are exactly the sites that can
    // reach. Offsets are the standard simplex corner offsets.
    vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
    canCrown(x0,                      i,       boundAll, accumHeight, accumGrad, bestCrownDepth, winningSpecies);
    canCrown(x0 - i1 + CAN_G2,        i + i1,  boundAll, accumHeight, accumGrad, bestCrownDepth, winningSpecies);
    canCrown(x0 - 1.0 + 2.0 * CAN_G2, i + 1.0, boundAll, accumHeight, accumGrad, bestCrownDepth, winningSpecies);
  } else {
    // Big crowns: 5x5 skewed block. The offset from site (i+a, j+b) reduces to
    // x0 - (a,b) + (a+b)*G2, which is the same expression the three corner
    // cases above are special cases of. canCrown rejects out-of-support sites
    // on its first test, so most of the 25 are cheap.
    for (int b = -2; b <= 2; b++) {
      for (int a = -2; a <= 2; a++) {
        vec2 ab = vec2(float(a), float(b));
        canCrown(x0 - ab + (ab.x + ab.y) * CAN_G2, i + ab, boundAll, accumHeight, accumGrad, bestCrownDepth, winningSpecies);
      }
    }
  }

  vec3 lF; float gF, sF, fragTreeProbability;
  float matF = classifyAt(tH, g.flatness, g.asp, g.cS, g.cL,
             hollownessAt(g.cS, g.cL), vHeight,
             matFieldSigned(uBandNoiseScale, 11.3) * uBandNoiseAmt, 0.0,
             uForestFillPad, lF, gF, sF, fragTreeProbability);
  // Solid forest fill: above uForestClose the stand reads as one mass and the
  // clearings between crowns are suppressed, so only sparse ground shows
  // individual crowns. Ramped rather than stepped — a hard threshold on a
  // density field that rides the morphing terrain would make hillsides blink.
  // The ramp is deliberately narrow: inside the belt the probability is 1 and
  // outside it is a biome floor (thinned by the spill terms), so a wide ramp
  // would change nothing. uForestFillPad, applied above as a margin bias, is the
  // control that matters: it lets the fill bleed past the biome edge so no strip
  // of bare ground shows against the rock.
  //
  // NOT over snow. The fill paints the forest colour into the gaps between
  // crowns, which is right against rock or meadow — a stand on dark ground
  // should read as one mass — but on snow it replaces the brightest material
  // in the palette with the darkest, so a dense stand above the snowline came
  // out as a flat green field with trees on it. Trees standing ON snow must
  // keep the snow between them; that IS the look. Distance is unaffected: the
  // far-field term below pushes cover toward 1 on its own, so a snow forest
  // still reads as a mass from far away, just not as green ground up close.
  float fillOK = matF == MAT_SNOW ? 0.0 : 1.0;
  accumHeight = mix(accumHeight, 1.0, fillOK * smoothstep(uForestClose, uForestClose + 0.02, fragTreeProbability));

  // ── Species for the fragment ──────────────────────────────────────────────
  // Normally the argmax winner from the crown loop. Two paths produce coverage
  // with NO crown under the fragment, and both need a species anyway: the solid
  // fill above (which paints the gaps between crowns in a dense stand) and the
  // far-field fraction below. Both fall back to the GROUND's own species.
  //
  // The fallback is safe precisely because it only applies where no crown
  // reached. The ground's material varies continuously, so using it under a
  // crown would two-tone that crown along a biome contour — the sliced-crown
  // bug this file is built to prevent. Where a crown exists it always wins, so
  // that never happens; the fallback can only split open GROUND, which is what
  // every other biome boundary does anyway.
  //
  // Note this is a hard choice, never a blend: mixing two species' colours
  // would put off-palette intermediates on screen, and the whole look is
  // posterized flat areas.
  outSp = winningSpecies >= 0 ? winningSpecies : speciesFor(matF);

  // LOD from the true screen footprint of the field coordinate. max(), not the
  // average: distant ground is seen at 2-5°, so a crown is ~14px wide but under
  // a pixel tall — the footprint is ~24:1 anisotropic and it is the compressed
  // axis that aliases. Fades the PERTURBATION (where the aliasing lives) and
  // pushes cover toward 1 so far forest reads as one solid mass rather than
  // dissolving into a brighter, thinner belt.
  //
  // Measured against the WIDEST species' crowns, so the fade starts when the
  // largest crowns in the scene are still resolvable rather than when the
  // smallest are.
  vec2  fw  = vec2(fwidth(p.x), fwidth(p.y));
  float lod = 1.0 - smoothstep(uForestLodHi * (2.0 / 3.0), uForestLodHi,
                               max(fw.x, fw.y) / max(radAll, 1e-3));

  // Far field, where a whole crown is smaller than a pixel and the per-pixel
  // "is there a tree here" test no longer means anything. Fall back to the
  // expected COVERED FRACTION: one crown per cell at probability p, crown area
  // over cell area crownArea, crowns overlapping rather than stacking, so
  // coverage saturates as 1 - exp(-p*crownArea). At the shipped defaults the
  // conifer's crownArea is ~0.85 (p = 0.05 covers ~4% of the ground, p = 1 ~57%)
  // and the broadleaf's ~4.2. Derived from speciesRadiusCap: radius × (1 + sizeVar)
  // against (CAN_SUPPORT2 − uForestJitter 0.2) / canExtent, with the treeSpecies.js
  // radius/elong/lean/sizeVar (conifer cap 0.396, broadleaf 0.883).
  //
  // Then MAJORITY WINS: the area is forest only if it is mostly forest.
  // Thresholding this mean at the near field's per-pixel bar instead would
  // paint a 5%-covered hillside solid green while the same ground up close
  // showed a handful of trees on grass. Keeping it a hard decision rather than
  // blending forest into meadow also keeps every colour a real palette colour.
  // Crown area is the LOCAL species' — a broad-crowned gully covers its ground
  // with far fewer trees than a spire-crowned hillside does, so sharing one
  // area here would misjudge one of them by the square of the radius ratio.
  float speciesRadius = speciesRadiusCap(speciesForm(outSp));
  float crownArea = 3.14159 * speciesRadius * speciesRadius / (0.86603 * CAN_A * CAN_A);
  float coverFrac = 1.0 - exp(-fragTreeProbability * crownArea);
  float far  = smoothstep(0.45, 0.55, coverFrac);
  outCover = mix(far, accumHeight, lod);

  // Field → world gradient. The terrain gradient below is world-space (height
  // per world unit) while accumGrad is height per FIELD unit, so the Jacobian
  // is not optional: without the 1/uForestCell the crown gradient is ~cell
  // times too large, the normal goes near-horizontal and the forest renders as
  // solid black polka dots.
  //
  // uForestDepth is expressed in CEL TONE STEPS rather than world height, so
  // the artist knob is tonal contrast and the amplitude cannot be driven an
  // order of magnitude past the ladder (one full step needs very little
  // gradient, and a physically-proportioned tree overshoots by ~10x).
  float scale = uForestDepth * lod / (max(uForestCell, 0.01) * uLightSteps);
  vec2  forestGradWorld = accumGrad * scale;

  // Rebuild the normal from the summed gradients. n.y is bounded well away from
  // zero inside forest (classify() returns rock below uCliffFlat), so the
  // division is safe.
  return normalize(vec3(-(terrainGrad.x + forestGradWorld.x), 1.0, -(terrainGrad.y + forestGradWorld.y)));
}
