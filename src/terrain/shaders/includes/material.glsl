// material.glsl — biome classification + painterly colour
//
// Injected into terrain.frag AFTER the uniform/varying/const declarations.
//
// Two foundations:
//  1. classify() returns a material id + its SUNLIT colour + glow mask; the
//     fragment blends shadow↔lit by the cel-stepped shade. Shadow colours are
//     DERIVED (desaturate+darken+violet-push) so the palette is keyed and no
//     material hue is ever multiplied by a light hue → no mud.
//  2. Placement is alpine zonation: forest is the default of the mid-mountain;
//     snow/scree/cliff/alpine-gold/pasture are each
//     carved off by ONE condition (no speckle). Aspect (adret/ubac) comes from
//     the horizontal normal vs sun azimuth, NOT N·L (which conflates facing
//     with flatness).

const float MAT_FOREST   = 0.0;
const float MAT_MEADOW   = 1.0;   // id 2 is unused; the numbering is kept for the debug view and the tests
const float MAT_ROCK     = 3.0;
const float MAT_SNOW     = 4.0;
const float MAT_RIPARIAN = 5.0;
const float MAT_SEABED   = 6.0;  // underwater sand/gravel floor

const float SNOW_CLIFF_SHED = 0.22;  // steepness raises the snowline (cliffs shed)
// Flatness at which ground counts as fully flat. Paired with uCliffFlat as the
// other end (below it classify() returns rock), the two bracket the whole band
// of steepness a tree can stand on. Shared with forest.glsl, which is injected
// after this file and uses the same window to fade crown shape with slope.
const float FLAT_FULL = 0.97;
const float DRAIN_ROCK_FREQ = 0.018;

// ─── Material-field noise (rides terrain drift + time) ────────────────────────
// Takes the sampling position so it can be evaluated away from this fragment —
// the forest needs the SAME edge wobble at each tree root, or the tree boundary
// and the material boundary drift apart by the wobble's amplitude.
float matFieldSignedAt(vec2 matXZ, float freq, float seed) { return snoise(vec3(matXZ * freq, seed + vMatTime)); }
float matFieldSigned(float freq, float seed)  { return matFieldSignedAt(vMatXZ, freq, seed); }

// ─── Topographic concavity: the ONLY hydrology signal ─────────────────
// Ring-mean vs height on the final eroded map. + concave (floor/basin),
// − convex (rib/mass). The erosion ridge map (stripe phase) is a debug output
// only: nothing here reads it.
//
// Radius-independence: the discrete Laplacian ringMean − height ≈ ½r²·∇²h, so
// the raw signal scales with r² and collapses to 0 as the radius shrinks.
// Dividing by (radius/REF)² recovers the true curvature ∇²h, so changing a
// radius sharpens the probed scale without rescaling the signal. REF is the
// radius at which the signal is unscaled.
const float CONCAVE_REF_R = 100.0;   // world units
// The *At forms take the height and ring mean explicitly so a caller can
// evaluate the signal somewhere other than this fragment — the forest needs it
// at each tree's root. The no-argument forms are thin wrappers over the
// varyings, so the formula exists exactly once.
float concaveSmallAt(float h, float smallMean) {
  float k = (CONCAVE_REF_R * CONCAVE_REF_R) / max(uCreaseRadius * uCreaseRadius, 1.0);
  return clamp((smallMean - h) / HEIGHT_MAX * k, -1.0, 1.0);
}
float concaveLargeAt(float h, float coarseMean) {
  float k = (CONCAVE_REF_R * CONCAVE_REF_R) / max(uHollowRadius * uHollowRadius, 1.0);
  return clamp((coarseMean - h) / HEIGHT_MAX * (uHollowRadius/uCreaseRadius) * k, -1.0, 1.0);
}
float concaveSmall() { return concaveSmallAt(vHeight, vSmallMean); }
float concaveLarge() { return concaveLargeAt(vHeight, vCoarseHeight); }

// "Hollowness" — basin-ness in [0,1], high in valley floors, ~0 on ridges.
// Both concavity scales are remapped [−1,1]→[0,1] (0.5 = flat) and MULTIPLIED:
// the product is an AND — a point reads as a hollow only where BOTH the
// gully-scale and the valley-scale agree it's concave, which rejects lone
// ridges and the coast (open on one side reads convex at the large scale).
// pow() sharpens the falloff. Basin-high is the sign its consumers (moisture,
// the rib gate) want.
float hollownessAt(float cS, float cL) {
  float s = cS * 0.5 + 0.5;   // 0 rib  … 1 gully floor
  float l = cL * 0.5 + 0.5;   // 0 mass … 1 basin
  return clamp(pow(s * l, .5), 0.0, 1.0);
}
float hollowness() { return hollownessAt(concaveSmall(), concaveLarge()); }

// Moisture (crease-driven) — feeds the shore sediment gate and the debug view.
float drainMoisture(float flatness) {
  float table  = 1.0 - clamp((vHeight - uSeaLevel) / 25.0, 0.0, 1.0);
  float runoff = 1.0 - flatness;
  return clamp(0.40 + concaveSmall() * 0.5 + hollowness() * 0.35
             + table * 0.15 - runoff * 0.25, 0.0, 1.0);
}

// Aspect: −1 fully shaded face … +1 fully sun-facing. Horizontal normal vs sun
// azimuth, so flatness does NOT read as "sunny" (the N·L bug).
// Takes the height GRADIENT so it can be evaluated away from this fragment
// (the forest needs it at each tree root). normal.xz is antiparallel to the
// gradient, so the no-argument-style wrapper just flips the sign.
float aspectFromGrad(vec2 grad) {
  vec2 nH = -grad;
  float l = length(nH);
  if (l < 1e-4) return 0.0;              // flat ground: neutral aspect
  return dot(nH / l, normalize(uSunAzimuth));
}
float aspect(vec3 normal) { return aspectFromGrad(-normal.xz); }

// The two zonation lines, in tH units, as functions of their inputs so both
// classify() and the forest can evaluate them — classify at the fragment, the
// forest at each tree's root. One formula, two evaluation points.
// Both lines move with aspect and concavity, so on a mountain the lowest snow
// (a shaded hollow) can sit below the highest meadow (a sunny spur). Zonation
// holds in the median: snow is higher than meadow at every snowline setting.
// treeLineAt carries no band noise: classify() tests (tH + bN) > (treeln + bN),
// where bN cancels, so this IS its effective treeline.
float snowLineAt(float asp, float cS, float flatness) {
  return uSnowBase + asp * uSnowAspect - cS * uSnowHollow + (1.0 - flatness) * SNOW_CLIFF_SHED;
}
float treeLineAt(float asp, float cS) {
  return uTreeBase + asp * uTreeAspect - max(0.0, -cS) * uTreeWind + cS * uTreeTongue;
}

// ─── Colour pair derivation ───────────────────────────────────────────────────
// Shadow: desaturate (chroma) → darken (value) → tint toward the palette's
// blue-violet (hue). THREE INDEPENDENT AXES, which is the point — each of the
// three uniforms below must move exactly one of them.
//
// The tint is normalised to the base's OWN luminance, so the hue push changes
// chroma and hue only and the shadow keeps whatever value uShadowValue gave it.
// A tint scaled by a brightness constant instead would carry value as well as
// hue: the "how blue" control would darken the shadow (measured on a mid
// material at uShadowValue 0.75: luminance 0.517 → 0.187 over uShadowHueAmt
// 0 → 1) and double as a second uShadowValue, and at the shipped 0.05 floor the
// blue it added would be about one part in 255 — invisible.
vec3 toShadow(vec3 lit) {
  const vec3 LUMA = vec3(0.299, 0.587, 0.114);
  float l = dot(lit, LUMA);
  vec3 base = mix(lit, vec3(l), uShadowDesat) * uShadowValue;
  // max() guards a black shadow hue, which would otherwise divide by zero and
  // put NaN through every shadowed fragment on the screen.
  vec3 tint = uShadowHue * (dot(base, LUMA) / max(dot(uShadowHue, LUMA), 1e-4));
  return mix(base, tint, uShadowHueAmt);
}
// Highlight: warm toward glow hue (alpenglow), scaled by per-material mask.
vec3 applyGlow(vec3 lit, float mask) { return mix(lit, uGlowHue, uGlow * mask); }
// Final material colour for a cel-stepped shade in [0,1]. shadeMask is the
// per-material shadow susceptibility (symmetric to the glow mask): it sets
// each material's shadow FLOOR — how far its tone is allowed to drop. Snow
// stays luminous in shade, forest drops to near-black mass, sand stays a
// warm shallow shadow — each biome keeps its own local value under light,
// instead of every material compressing by the same global amount.
vec3 shadeMaterial(vec3 lit, float glowMask, float shadeMask, float shade) {
  float s = mix(1.0 - shadeMask, 1.0, shade);
  return mix(toShadow(lit), applyGlow(lit, glowMask), s);
}

// ─── Classification — alpine zonation, forest-as-default ──────────────────────
// One margin, two consumers. `margin > 0` fires classify()'s branch; the SAME
// margin picks the tree-probability floor. Writing each condition once
// is the entire point of this arrangement — a hard test and a soft test derived
// from one expression cannot disagree about a sign or a direction (the failure
// mode: trees on ground classify() has already called rock).
// The gate is HARD, but each tree gets its own threshold, offset by up to half
// a band either way from its own hash (edgeRnd ∈ [-0.5, 0.5], 0 for the
// material itself). That difference matters:
//
//   Ramping the PROBABILITY over the band would make it partial inside the
//   band — so trees appear there whatever the floor is set to, and when the
//   band is narrower than the tree spacing the result is a single-file
//   necklace tracing every biome edge.
//
//   Jittering each tree's THRESHOLD keeps the probability binary. Trees near an
//   edge cross it at different points, so the transition reads as a scatter,
//   its width is `gate softness`, and a floor of 0 means genuinely no trees
//   past that tree's own line.
bool canFires(float margin, float b, float edgeRnd) {
  return margin + edgeRnd * b > 0.0;
}

// ─── Spill shaping — landscape structure for trees OUTSIDE the tree belt ─────
// Inside the belt no gate fires and the probability is 1: a closed forest,
// which is what it should be. The interesting, easily-wrong part is the
// SPILL — the trees the `on rock` / `on snow` / `on meadow` floors allow past a
// biome boundary. A bare floor spills them as a uniform random scatter, which
// reads as trees dropped on the meadow with no reason to be where they are.
//
// These three multiply the FLOOR only, so they give the spill structure without
// touching the forest:
//
//   over      how far past the binding boundary this ground is — the margin of
//             the gate that bound. Spill decays over uForestSpillFade,
//             so a treeline reads as a forest fraying outward instead of a belt
//             plus a detached constellation.
//   cS        small-scale concavity: negative on a convex wind-scoured rib,
//             positive in a sheltered gully. uForestRibThin thins the ribs, so
//             the spill climbs the draws and leaves the spines bare.
//   flatness  the terrain normal's y. uForestSlopeThin thins steep ground over
//             the uCliffFlat…FLAT_FULL window.
//
// The rib and slope terms are a mix from (1 - amount) to 1, NOT a raw ramp: a
// multiplicative term that can reach zero empties whole hillsides, and because
// the terrain morphs continuously it does so intermittently — the forest blinks
// between forest and bare ground. Bounding each keeps the worst case a thinning.
// The `over` term is deliberately NOT bounded: reaching zero is its job, and it
// does so only well outside the boundary, where there should be nothing.
//
// Caveat: `over` mixes units — the height gates measure in tH, the slope gates
// in flatness — so its reach is "distance past the binding gate" in whatever
// that gate measures. Same compromise `gate softness` and `fill padding` make.
float forestSpill(float over, float cS, float flatness) {
  float reach = 1.0 - clamp(over / max(uForestSpillFade, 1e-3), 0.0, 1.0);
  float rib   = mix(1.0 - uForestRibThin,   1.0, clamp(cS * 0.5 + 0.5, 0.0, 1.0));
  float slope = mix(1.0 - uForestSlopeThin, 1.0,
                    smoothstep(min(uCliffFlat, FLAT_FULL - 0.02), FLAT_FULL, flatness));
  return reach * rib * slope;
}

// classifyAt — the real classifier. Takes every input explicitly so it can be
// evaluated somewhere other than this fragment: the forest runs it at each tree
// ROOT to decide whether that tree exists. classify() below is the thin wrapper
// that feeds it this fragment's varyings.
//
// outTreeP is the probability a tree grows here, in [0,1]. It is accumulated
// from the same margins that drive the material verdict, so the two are
// consistent by construction rather than by review.
//
// bN is the band-noise edge wobble, passed in rather than sampled so the forest
// can supply the value at a TREE ROOT rather than at this fragment. It must:
// bN shifts h, so every boundary except the treeline moves with it, and passing
// 0 here offsets the tree boundary from the material boundary by the wobble's
// full amplitude — six times the gate band at the defaults. (It genuinely does
// cancel out of treeln - h, since both carry it. That is one gate out of four.)
float classifyAt(float tH, float flatness, float asp, float cS, float cL,
                 float hollow, float worldY, float bN, float edgeRnd, float marginBias,
                 out vec3 lit, out float glow, out float shadeAmt, out float outTreeP) {
  float b = max(uForestBand, 1e-3);
  float h = tH + bN;

  float snow   = snowLineAt(asp, cS, flatness);
  float treeln = treeLineAt(asp, cS) + bN;
  float pf2    = uPastureFlat * uPastureFlat;

  // One margin per gate. `> 0` means the gate fires — this ground is not forest.
  float mSnow  = h - snow;                        // snowline
  float mScree = h - (snow - uScreeBand);         // bare rock below the snowline
  float mCliff = uCliffFlat - flatness;           // too steep for soil
  float mSea   = (uSeaLevel - worldY) / HEIGHT_MAX;
  float mRib   = .3 - hollow;                     // wind-scoured convex rib
  float mTree  = h - treeln;                      // treeline
  float mFlat  = flatness - pf2;                  // open pasture

  // ── The tree-probability floor — ONE gate binds, floors do not multiply ───
  // A piece of ground belongs to exactly ONE biome, so exactly one floor
  // applies: the first gate that fires, in the same precedence the material
  // verdict below uses. The two chains must stay in step.
  //
  // Multiplying the floors would silently couple every slider to every other
  // one. Snow ground lies above the treeline, so BOTH the snow gate and the
  // treeline gate fire on it, and the probability would be onSnow * onMeadow:
  // `on snow` at 1 would still give nothing unless `on meadow` was also 1. Same
  // for rock, which is usually above the treeline too. Binding one gate makes
  // each slider independently sufficient — at 1 that biome carries a full stand
  // no matter where the others sit.
  //
  // Every gate is still CONSULTED, in order, until one fires. Stopping at the
  // first MATERIAL branch instead would skip the remaining gates, so a tree
  // whose edge jitter let it squeak past gate one would grow in the seam
  // between two biomes that both forbid it. The chain runs on each tree's own
  // jittered margins, so a tree that escapes the snow gate is still asked about
  // scree, cliff, sea, rib, treeline and pasture in turn.
  //
  // marginBias DILATES the region considered habitable without touching the
  // material verdict; the forest uses it to let the solid fill bleed a little
  // past a biome edge so no strip of bare ground shows against the rock.
  // Caveat: the margins are in mixed units (tH for the height gates, flatness
  // for the slope gates), so the bias is "distance past the binding gate" in
  // whatever that gate measures — the same compromise `gate softness` makes.
  float ribFloor = mix(uForestOnRock, uForestOnMeadow, step(uPastureFlat, flatness));
  float mb = marginBias;
  float fl   = 1.0;   // the binding gate's floor; 1 = nothing fired, i.e. forest
  float over = 0.0;   // how far past THAT gate's threshold this ground is
  if      (canFires(mSnow  - mb, b, edgeRnd)) { fl = uForestOnSnow;   over = mSnow  - mb; }
  else if (canFires(mScree - mb, b, edgeRnd)) { fl = uForestOnRock;   over = mScree - mb; }
  else if (canFires(mCliff - mb, b, edgeRnd)) { fl = uForestOnRock;   over = mCliff - mb; }
  else if (canFires(mSea   - mb, b, edgeRnd)) { fl = uForestOnShore;  over = mSea   - mb; }
  else if (canFires(mRib   - mb, b, edgeRnd)) { fl = ribFloor;        over = mRib   - mb; }
  else if (canFires(mTree  - mb, b, edgeRnd)) { fl = uForestOnMeadow; over = mTree  - mb; }
  // Riparian ribbon is the one gate that can RAISE the probability rather than
  // floor it: a streambank is the best growing site on the mountain, so
  // uForestOnRiparian goes past 1 and the clamp below turns that into a fully
  // stocked gallery forest while the hillside around it sits at the forest baseline.
  // (Every other floor is <= 1 and can only thin.) It must also SHORT-CIRCUIT,
  // or the pasture gate below would thin a flat gully floor the material has
  // already called riparian.
  else if (cS - uRiparian > 0.0) { fl = uForestOnRiparian; }
  else if (canFires(mFlat  - mb, b, edgeRnd)) { fl = uForestOnMeadow; over = mFlat  - mb; }

  // Give the SPILL structure — see forestSpill. Only where a gate actually
  // bound, so the forest interior is left exactly as it was. The test is on a
  // discrete quantity (fl is one slider value), so there is no edge to soften
  // here; `over` carries the continuity.
  float p = fl;
  if (fl < 1.0) p *= forestSpill(over, cS, flatness);
  outTreeP = clamp(p, 0.0, 1.0);

  // ── Material verdict — first match wins, on the same margins ──────────────
  if (mSnow  > 0.0) { lit = uColSnow; glow = uGlowSnow; shadeAmt = uShadeSnow; return MAT_SNOW; }
  if (mScree > 0.0) { lit = uColRock; glow = uGlowRock; shadeAmt = uShadeRock; return MAT_ROCK; }
  if (mCliff > 0.0) { lit = uColRock; glow = uGlowRock; shadeAmt = uShadeRock; return MAT_ROCK; }
  if (mSea   > 0.0) {
    if ((worldY - uSeaLevel) / HEIGHT_MAX + (bN + 1.) * .04 < 0.) {
      lit = uColRock; glow = uGlowRock; shadeAmt = uShadeRock; return MAT_SEABED;
    }
    lit = uColSand; glow = uGlowSand; shadeAmt = uShadeSand; return MAT_SEABED;
  }
  if (mRib > 0.0) {
    if (flatness > uPastureFlat) { lit = uColMeadow; glow = uGlowMeadow; shadeAmt = uShadeMeadow; return MAT_MEADOW; }
    lit = uColRock; glow = uGlowRock; shadeAmt = uShadeRock; return MAT_ROCK;
  }
  if (mTree > 0.0) { lit = uColMeadow; glow = uGlowMeadow; shadeAmt = uShadeMeadow; return MAT_MEADOW; }
  // Riparian ribbon: lush green along deep gully floors below the treeline.
  // No tree penalty — gallery forest belongs on a stream bank.
  if (cS - uRiparian > 0.0) { lit = uColRiparian; glow = uGlowRiparian; shadeAmt = uShadeRiparian; return MAT_RIPARIAN; }
  if (mFlat > 0.0) { lit = uColMeadow; glow = uGlowMeadow; shadeAmt = uShadeMeadow; return MAT_MEADOW; }

  // Within the tree belt, FOREST is the default.
  lit = uColForest; glow = uGlowForest; shadeAmt = uShadeForest;
  return MAT_FOREST;
}

// What the classifier reads at this fragment: slope-derived flatness and aspect
// and the two concavity measures, taken from the derive-map texel at the
// fragment's own position, never from the values the rasteriser blends across a
// triangle. The forest site pass classifies tree roots from the same texels, so
// everything that classifies ground agrees on what the ground is. The height is
// the one exception: it is still the interpolated vHeight.
struct GroundField { float flatness; float asp; float cS; float cL; };
GroundField groundFieldHere() {
  vec4 db = texture2D(uDeriveMap, clamp(vWorldXZ / uPlaneSize + 0.5, 0.001, 0.999));
  GroundField g;
  g.flatness = inversesqrt(1.0 + dot(db.rg, db.rg));
  g.asp  = aspectFromGrad(db.rg);
  g.cS   = concaveSmallAt(vHeight, db.a);
  g.cL   = concaveLargeAt(vHeight, db.b);
  return g;
}

// This fragment's verdict — the wrapper that supplies classifyAt with the
// varyings. Existing call sites are unchanged.
float classify(float tH, float flatness, vec3 normal, out vec3 lit, out float glow, out float shadeAmt) {
  float treeP;
  return classifyAt(tH, flatness, aspect(normal), concaveSmall(), concaveLarge(),
                    hollowness(), vHeight,
                    matFieldSigned(uBandNoiseScale, 11.3) * uBandNoiseAmt, 0.0, 0.0,
                    lit, glow, shadeAmt, treeP);
}

// ─── Shoreline sand band ──────────────────────────────────────
// Sand substituted into the material where gentle + sediment-moist + not
// rock/snow, with a noise-varied inland reach.
const float SHORE_GATE_WOBBLE = 0.10;

// Beach = sand substituted into the LIT colour so it shades with everything.
// Returns 1 where sand replaced the material.
float applyShoreMaterial(inout vec3 lit, inout float glow, inout float shadeAmt, float flatness, float matId) {
  // The water edge (inWater, at shoreDist ≈ -1.5) is the TRUE shoreline —
  // fixed, never wobbled. Only the sand's INLAND reach (w, the outer edge)
  // varies with noise, so sand pushes further up the slope in some spots and
  // stays thin in others, without ever detaching from the waterline itself
  // (wobbling the waterline reference would desync it from this band).
  float shoreDist = vHeight - uSeaLevel;
  float inWater   = step(0., shoreDist);
  float moisture  = drainMoisture(flatness);
  float gateN     = matFieldSigned(uBandNoiseScale, 6.1) * SHORE_GATE_WOBBLE;
  float sandAllowed = (matId == MAT_ROCK || matId == MAT_SNOW) ? 0.0 : 1.0;
  float isBeach = sandAllowed
                * step(uBeachFlat,  flatness + gateN)
                * step(uBeachMoist, moisture + gateN);
  // Coarse term (low freq, dominant) makes real fingers/coves of sand reach
  // inland; fine term keeps the edge from looking perfectly smooth.
  float edgeN = matFieldSigned(uBandNoiseScale * 1.5, 3.7) * 0.8
              + matFieldSigned(uBandNoiseScale * 6., 9.1) * 0.2;
  float w     = uShoreWidth * max(0.0, 1.0 + edgeN * uShoreNoiseAmt);
  float band  = inWater * (1.0 - step(w, shoreDist)) * isBeach;
  lit  = mix(lit, uColSand, band);
  glow = mix(glow, uGlowSand, band);
  shadeAmt = mix(shadeAmt, uShadeSand, band);
  return band;
}
