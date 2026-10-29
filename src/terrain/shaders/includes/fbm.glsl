// fbm.glsl — the terrain's height noise.
//
// Injected AFTER noise.glsl into terrain.vert and heightmap.frag (the data-map
// pass). Declares its own uniforms; terrain.js wires the SAME uniform objects
// into every material by reference, so one tick reaches all passes.
//
// ─────────────────────────────────────────────────────────────────────────────
// HOW THE SURFACE IS BUILT, top down
//
//   1. baseNoise        the noise primitive: value plus its exact gradient
//                       (noise.glsl's snoise_grad). Swapping the primitive means
//                       supplying its analytic gradient too.
//   2. octaveShape      the per-octave transform: how round or creased one scale
//                       of detail is.
//   3. fbmDual          THE accumulation. Walks the octaves once and emits TWO
//                       fields from the same series — bedrock (all octaves) and
//                       mantle (the coarse ones only, scaled down). Everything
//                       that shapes the terrain happens inside this one loop.
//   4. getHeightAndGrad combines them: h = max(mantle, bedrock). Wherever
//                       bedrock stands higher it is exposed and reads as rock;
//                       elsewhere the mantle buries it. The soil line is the
//                       contour where they cross — emergent, not authored.
//
// Two-field placement is always on; there is no single-field terrain path.
// ─────────────────────────────────────────────────────────────────────────────


// ══ 1 · TIME AND GLOBAL SWITCHES ═════════════════════════════════════════════
uniform float uTime;
uniform bool  uEnableBaseFBM;
uniform bool  uEnableTimeAxis;   // false → t = 0 in fbmDual (static; moves only via drift)

// ══ 2 · THE TWO fBM INSTANCES ════════════════════════════════════════════════
// Instance 0 — large-scale landform · instance 1 — medium valleys/hills.
// Summed in world units. DriftOffset = accumulated ∫velocity dNoiseTime
// (terrainDriver). Octaves are the MANTLE count; bedrock gets its own, below.
uniform float uFBM0Freq, uFBM0Amp, uFBM0TimeSpeed, uFBM0Persistence, uFBM0Lacunarity, uFBM0Octaves;
uniform vec2  uFBM0DriftOffset;
uniform float uFBM1Freq, uFBM1Amp, uFBM1TimeSpeed, uFBM1Persistence, uFBM1Lacunarity, uFBM1Octaves;
uniform vec2  uFBM1DriftOffset;

// ══ 3 · OCTAVE SHAPE — how creased one scale of detail is ════════════════════
uniform float uRidgeAmt;         // 0 = smooth fBM · 1 = fully ridged
uniform float uRidgeRound;       // crease roundness ε; 0 is a sharp kink

// ══ 4 · BEDROCK VS MANTLE — which field is exposed where ═════════════════════
uniform float uBedrockOctaves;   // bedrock octave count; clamped up to the mantle's
uniform float uMantleRelief;     // rho — the mantle's relief as a FRACTION of bedrock's.
                                 // A ratio, never an amplitude: scaling both amplitudes
                                 // together leaves the crossing where it is.
uniform float uMantleDC;         // the mean lift max() adds, taken back out.
                                 // terrainMath.mantleDcCoefficient, per tick.

// ══ 5 · SOIL LEVEL ═══════════════════════════════════════════════════════════
uniform float uMantleBias;       // world units added to the mantle. An explicit soil
                                 // level, so it deliberately overrides "the crossing
                                 // places itself". Up = more soil, less exposed rock,
                                 // valleys filled higher. Constant → gradient untouched.

// ══ 6 · ROCK CHARACTER — the octaves that are bedrock's alone ════════════════
// ALWAYS ON. Everything here applies ONLY to octaves i >= the mantle count: the
// detail the mantle does not take. The shared octaves are untouched, so the relief gap and
// the soil-line placement are unchanged by any knob in this block.
//
// Together these are why more octaves can read as rock instead of as noise:
//
//   RIDGE THE RIGHT OCTAVES. The stock ramp uRidgeAmt/(i+1) is strongest at
//   i = 0, so sharpening landed on the big smooth swells and the fine octaves
//   stayed round — backwards for rock. uRockRidge creases the bedrock-only
//   octaves instead, and ignores the per-instance ridgeStrength
//   ("instance 0 is never ridged"), or instance 0's rock detail stays blobby.
//
//   STOP THE SLOPE DIVERGING. Octave i contributes gradient ∝ (p·lac)^i. The
//   shipped 0.65·1.8 = 1.17 and 0.55·1.9 = 1.045 are both ABOVE 1, so each
//   octave adds MORE slope than the last while the amplitude sum saturates at
//   1/(1−p). The surface goes rough everywhere instead of steep somewhere. Keep
//   uRockPersist <= 1/lacunarity (0.556 at lac 1.8) and octaves add texture,
//   not slope.
//
//   JOINT DOMAIN. Rock fractures along preferred planes, which is why it reads
//   as faceted rather than lumpy; isotropic noise cannot. Each rock octave
//   samples through a stretched frame rotated to one of three joint directions
//   60° apart. No floor() quantisation, so nothing marches under the drift.
uniform float uRockRidge;        // ridge blend for the bedrock-only octaves
uniform float uRockPersist;      // their own falloff; <= 1/lacunarity tames slope
uniform float uRockAniso;        // joint stretch; 1 = isotropic, higher = blade-like
uniform float uRockJointAngle;   // base joint orientation, radians

// ══ 7 · HEIGHT GATE — where rock detail is allowed to appear ═════════════════
// Bedrock detail added at equal strength on a valley floor and on a summit is
// most of why more octaves read as noise: real low ground is smooth because
// sediment fills it in. So scale each bedrock-only octave by how high the
// landform sits under it.
//
// The landform is the mantle partial sum, which is complete at the moment the
// first bedrock octave starts — that is what makes the two fields differ — so
// this costs one smoothstep and no extra noise taps.
//
// Gated PER INSTANCE on that instance's own mantle, not on the combined landform
// of both: combining would need a second pass over the mantle octaves (~24 extra
// snoise/texel), and per-instance is the more faithful multifractal rule anyway,
// since detail then rides raised ground at its OWN scale. Always applied —
// uRockGateAmt is the knob that dials it back (0 = ungated).
uniform float uRockGateAmt;      // 0 = ungated · 1 = fully gated
uniform float uRockGateLo;       // landform level below which rock detail is suppressed
uniform float uRockGateHi;       // landform level above which it is at full strength

// ══ 8 · DEBUG ════════════════════════════════════════════════════════════════
uniform float uFieldSolo;        // 0 composed · 1 bedrock alone · 2 mantle alone


// ─── Noise primitive ─────────────────────────────────────────────────────────
// Value and the exact gradient d(value)/dp in one evaluation. The gradient is
// the analytic derivative of the noise kernel, not a finite difference of it.
float baseNoise(vec3 p, out vec3 grad) {
  return snoise_grad(p, grad);
}

// ─── Per-octave shape ────────────────────────────────────────────────────────
// Blends the raw noise n toward a ridge: sharp crests, soft hollows.
// dScale is d(shape)/dn — the gradient path multiplies by it (chain rule).
//
// abs()'s kink at n = 0 would give every ridgeline a gradient sign-flip, and the
// erosion filter carves along slope discontinuities — it latches onto those
// lines as jagged rills. So |n| is rounded to a = √(n²+ε²): C∞, ≈|n| away from
// zero, and its slope passes continuously through 0. ε = uRidgeRound.
float octaveShape(float n, float ridge, out float dScale) {
  float a  = sqrt(n * n + uRidgeRound * uRidgeRound + 1e-8);
  float da = n / a;                                  // continuous at n = 0
  dScale = mix(1.0, -2.0 * da, ridge);
  return mix(n, 2.0 * (1.0 - a) - 1.0, ridge);
}

const int FBM_MAX_OCTAVES = 8;

// Joint frame for rock octave `i`: squash by uRockAniso across a direction that
// cycles through three orientations 60° apart. R(θ)·diag(1/k,k)·R(−θ) is
// symmetric with determinant 1, so it is area-preserving and does not secretly
// rescale the octave's frequency.
mat2 rockJointFrame(int i) {
  float ang = uRockJointAngle + float(i - (i / 3) * 3) * 1.0471975512;   // (i mod 3)·π/3
  float c = cos(ang), s = sin(ang);
  float k = max(uRockAniso, 1e-3);
  return mat2(c, s, -s, c) * mat2(1.0 / k, 0.0, 0.0, k) * mat2(c, -s, s, c);
}

// ─── Bedrock + mantle, one pass ──────────────────────────────────────────────
// ONE loop emitting BOTH partial sums, so each octave's noise is evaluated once
// for both fields. The mantle is the first `mantleOctaves` octaves of the
// bedrock series, scaled by rho: a shrunken copy of the bedrock's big shapes.
//
// The load-bearing detail is the normalisation. `maxAmp` runs over all bedrock
// octaves for BOTH fields, so each shared octave carries the same weight in each
// and the mantle's big shapes are exactly rho times the bedrock's, whatever the
// persistence or the bedrock octave count. Dividing the mantle by its OWN
// smaller total would make the effective ratio rho × (bedrock total / mantle
// total), 1.275 × rho at persistence 0.65 with 3 and 6 octaves, which moves
// with persistence and the octave count and would slide the soil line as the
// form dials move them.
//
// `nAmp` is a second amplitude track walking the STOCK persistence series, used
// for that total alone. Summing the actual amplitudes would make maxAmp a
// function of uRockPersist, and since both fields divide by it, the rock slider
// would rescale the MANTLE's relief too.
//
// @param mantleOctaves   mantle octave count
// @param bedrockOctaves  bedrock octave count (>= mantleOctaves)
// @param rho             the mantle's relief as a fraction of bedrock's
// @returns    bedrock value; mantle in `mantle`; per-field gradients out
float fbmDual(vec2 xz, float timeSpeed, float freq, float mantleOctaves, float bedrockOctaves,
              float persistence, float lacunarity, float ridgeStrength, float rho,
              out float mantle, out vec2 bedrockGrad, out vec2 mantleGrad) {
  float tComp = uEnableTimeAxis ? uTime * timeSpeed : 0.0;
  float bedrockValue = 0.0, mantleValue = 0.0, amp = 1.0, nAmp = 1.0, maxAmp = 0.0, mantleWeightSum = 0.0, f = freq;
  vec2 bedrockGradSum = vec2(0.0), mantleGradSum = vec2(0.0);

  for (int i = 0; i < FBM_MAX_OCTAVES; i++) {
    if (float(i) >= bedrockOctaves) break;
    // An octave the mantle does not take. Rock character applies to exactly
    // these, always.
    bool rock = float(i) >= mantleOctaves;

    maxAmp += nAmp;                                  // shared by both fields, rockPersist-free
    if (!rock) mantleWeightSum += nAmp;               // mantle's own sum, complete by the first rock octave

    // Height gate: how much of this octave the landform underneath allows.
    // mantleValue is final by now, since every mantle octave has already been
    // summed. The gradient deliberately ignores d(gate)/dxz — locally-constant,
    // and the production normal comes from the derive pass, so only erosion sees it.
    float gate = 1.0;
    if (rock) {
      float land = mantleValue / max(mantleWeightSum, 1e-5);   // this instance's landform, about [-1,1]
      gate = mix(1.0, smoothstep(uRockGateLo, uRockGateHi, land), uRockGateAmt);
    }

    // Rock octaves crease harder and sample through the joint frame. p = jointFrame·xz·f,
    // so by the chain rule d/dxz picks up jointFrame TRANSPOSED — which is exactly what
    // GLSL's `rowVector * matrix` computes, hence `noiseGrad.xy * jointFrame`. Backwards
    // here would tilt every normal and send erosion's gullies across the slope.
    float ridge = rock ? uRockRidge : uRidgeAmt / (float(i) + 1.) * ridgeStrength;
    mat2 jointFrame = rock ? rockJointFrame(i) : mat2(1.0, 0.0, 0.0, 1.0);
    vec2 stretchedXZ = rock ? jointFrame * xz : xz;

    vec3 noiseGrad;
    float dScale;
    float s = octaveShape(baseNoise(vec3(stretchedXZ * f, tComp), noiseGrad), ridge, dScale);
    vec2 octaveGradXY = rock ? noiseGrad.xy * jointFrame : noiseGrad.xy;

    float octaveValue    = amp * gate * s;
    vec2  octaveGradTerm = amp * gate * f * dScale * octaveGradXY;
    bedrockValue += octaveValue;  bedrockGradSum += octaveGradTerm;
    if (!rock) { mantleValue += octaveValue;  mantleGradSum += octaveGradTerm; }

    // Rock octaves fall off on their own persistence, applied on the step INTO
    // the first one and between them, so the mantle's amplitudes are untouched.
    amp  *= (float(i) + 1.0 >= mantleOctaves) ? uRockPersist : persistence;
    nAmp *= persistence;
    f    *= lacunarity;
  }

  float inv = 1.0 / max(maxAmp, 1e-5);
  mantle      = rho * mantleValue * inv;
  mantleGrad  = rho * mantleGradSum * inv;
  bedrockGrad = bedrockGradSum * inv;
  return bedrockValue * inv;
}

// ─── The public API ──────────────────────────────────────────────────────────
// THE single source for the surface height, its raw world-xz gradient, and which
// field is exposed. `bedrock` is 1 where the bedrock field wins, 0 where the
// mantle buries it. heightmap.frag (the data-map pass) is the only caller.
float getHeightAndGrad(vec2 xz, out vec2 grad, out float bedrock) {
  if (!uEnableBaseFBM) { grad = vec2(0.0); bedrock = 0.0; return 0.0; }

  // bedrockOctaves is forced >= each instance's own octave count. With FEWER
  // bedrock octaves the loop would clip the mantle to the same set, mantleWorld
  // would degenerate to rho·bedrockWorld, and the crossing would collapse onto
  // the bedrockWorld = 0 contour.
  vec2 bedrockGrad0, mantleGrad0, bedrockGrad1, mantleGrad1;
  float mantleValue0, mantleValue1;
  float bedrockValue0 = fbmDual(xz + uFBM0DriftOffset, uFBM0TimeSpeed, uFBM0Freq,
                     uFBM0Octaves, max(uBedrockOctaves, uFBM0Octaves),
                     uFBM0Persistence, uFBM0Lacunarity, 0., uMantleRelief, mantleValue0, bedrockGrad0, mantleGrad0);
  float bedrockValue1 = fbmDual(xz + uFBM1DriftOffset, uFBM1TimeSpeed, uFBM1Freq,
                     uFBM1Octaves, max(uBedrockOctaves, uFBM1Octaves),
                     uFBM1Persistence, uFBM1Lacunarity, 1., uMantleRelief, mantleValue1, bedrockGrad1, mantleGrad1);
  float bedrockWorld = uFBM0Amp * bedrockValue0 + uFBM1Amp * bedrockValue1;
  float mantleWorld  = uFBM0Amp * mantleValue0  + uFBM1Amp * mantleValue1;
  vec2 bedrockGradWorld = uFBM0Amp * bedrockGrad0 + uFBM1Amp * bedrockGrad1;
  vec2 mantleGradWorld  = uFBM0Amp * mantleGrad0  + uFBM1Amp * mantleGrad1;

  // Soil level: a constant lift of the COMBINED mantle, so both instances move
  // together. Bedrock is untouched — this moves the soil line, nothing else.
  // Constant in mantleWorld, so the gradient is unaffected.
  mantleWorld += uMantleBias;

  float h;
  if (uFieldSolo > 1.5) {
    h = mantleWorld;  grad = mantleGradWorld;  bedrock = 0.0;   // mantle alone
  } else if (uFieldSolo > 0.5) {
    // Bedrock alone: no mantle, no max(), so no uMantleDC either — there is no
    // lift to remove. This is the view for judging the bedrock noise itself.
    h = bedrockWorld;  grad = bedrockGradWorld;  bedrock = 1.0;
  } else {
    bedrock = step(mantleWorld, bedrockWorld);
    // SELECT the winning field's gradient, never blend the two: they correlate
    // only ~0.53, so an average would point ~50° off the exposed slope and
    // erosion would cut gullies ACROSS rock faces instead of down them.
    grad = mix(mantleGradWorld, bedrockGradWorld, bedrock);
    // max() only ever raises the mean (terrainMath.mantleDcCoefficient estimates
    // by how much; measured on the map, 1 to 3 world units at the four form
    // corners). Left in, every biome band would slide against uSnowBase /
    // uTreeBase, so take it straight back out.
    h = max(mantleWorld, bedrockWorld) - uMantleDC;
  }
  return h;
}

