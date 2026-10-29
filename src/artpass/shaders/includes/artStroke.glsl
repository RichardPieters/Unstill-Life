/**
 * artStroke.glsl — the shape of one brush mark, and how thick the paint sits.
 *
 * Everything here is evaluated in STROKE SPACE: the offset from the stroke's
 * centre, rotated so +x runs along the stroke's own direction. That is the
 * frame a brush actually works in, and it is why taper, bristle grooves and the
 * rim all become one-dimensional functions here instead of awkward 2D ones.
 *
 * The references are not ellipses. Magnified, they fall into four families, and
 * two knobs span all of them:
 *
 *   round dabs (Rysselberghe, Angrand) ... n = 2, taper 0
 *   fat oval dabs (Cross's autumn trees) . n = 2, taper 0, high thickness
 *   pressed tiles (Signac 1909, Cross) ... n = 4..8, taper 0
 *   dragged commas (Luce, Signac 1896) .. n = 2..3, taper high
 *
 * `n` is the superellipse exponent: 2 is an ellipse, large is a rectangle with
 * rounded corners — a flat brush pressed down rather than dabbed. `taper` makes
 * one end narrower than the other, which is what a loaded brush leaves as it
 * lifts.
 *
 * Requires artNoise.glsl (hence artHash.glsl) and artLattice.glsl (uTaper,
 * uWarpAmp) spliced before it.
 */

// ─── uniforms ────────────────────────────────────────────────────────────────
uniform float uShapeN;        // superellipse exponent: 2 = ellipse, high = tile
uniform float uWarpScale;     // warp feature size, as a fraction of the radius

uniform float uThickBase;     // paint height of a nominal stroke
uniform float uThickVar;      // spread of per-stroke height: some thin, some thick
uniform float uRim;           // paint piled at the edge where the brush lifted
uniform float uDip;           // scooped centre of a loaded mark
uniform float uGroove;        // bristle grooves along the stroke
uniform float uGrooveFreq;    // how many of them across its width
uniform float uRagged;        // inward-only rim bite, on top of the warp
uniform float uRaggedFreq;

// ─── ragged rim ──────────────────────────────────────────────────────────────
// A clean ellipse reads as geometry; a lumpy edge reads as foliage and paint.
// The harmonics come from the unit direction by the Chebyshev recurrence, so
// they are polynomial in it and smooth all the way round. atan has a branch
// cut, and a cut running out of every stroke centre is a hard shading seam.
//
// It only bites INWARD: the returned factor is >= 1 and a larger factor means a
// smaller stroke, so a stroke can never grow past the radius the candidate set
// was chosen for and bite crescents out of its own neighbours.
float raggedFactor(vec2 dir, vec2 cell) {
  if (uRagged <= 0.0) return 1.0;
  vec4 r = vec4(hash1(cell, 7.3), hash1(cell, 13.9), hash1(cell, 23.1), hash1(cell, 31.7));
  float rot = r.w * 6.2831853;
  float c = dir.x * cos(rot) - dir.y * sin(rot);   // cos of the rotated angle
  float c2 = 2.0 * c * c - 1.0;                    // cos 2θ
  float c3 = (4.0 * c * c - 3.0) * c;              // cos 3θ
  float c5 = ((16.0 * c * c - 20.0) * c * c + 5.0) * c;  // cos 5θ
  vec3 w = vec3(r.x, r.y, r.z) * 2.0 - 1.0;
  w *= vec3(1.0, 0.45, 0.25);   // convex-ish: the 2-lobe term dominates
  float lobes = mix(c2, mix(c3, c5, clamp(uRaggedFreq - 1.0, 0.0, 1.0)),
                    clamp(uRaggedFreq, 0.0, 1.0));
  float wA = (w.x * c2 + w.y * c3 + w.z * lobes) / (abs(w.x) + abs(w.y) + abs(w.z) + 1e-4);
  return 1.0 + uRagged * 0.5 * (1.0 + wA);
}

struct Stroke {
  float alpha;      // coverage, antialiased
  float height;     // paint thickness contributed at this point
};

/**
 * Sample one stroke.
 *
 * `p`    offset from the stroke centre, already rotated into stroke space
 * `a`    half-length along the stroke
 * `b`    half-width across it
 * `cell` the stroke's cell index, the seed for everything per-stroke
 * `loadBias` exponent on the thickness draw; above 1 makes a thick stroke less
 *            likely without changing the range it can take
 */
Stroke strokeAt(vec2 p, float a, float b, vec2 cell, float loadBias) {
  Stroke o;
  a = max(a, 0.5);
  b = max(b, 0.5);

  // Warp the space, not the outline. Scaled by the stroke's own size so the
  // irregularity is proportional at every stroke size — a 3px dab and a 30px
  // tile get the same amount of character, not the same number of pixels of it.
  vec2 q = warp(p, uWarpAmp * min(a, b), uWarpScale * min(a, b),
                hash2(cell, 3.77) * 31.0);

  // Taper narrows one end. Normalised by the mean so the stroke does not also
  // get thinner overall as the taper rises — that would conflate two axes.
  float s = clamp(q.x / a, -1.0, 1.0);
  float bEff = b * max(1.0 - uTaper * s, 0.05) / max(1.0 - uTaper * 0.0, 1e-3);

  vec2 uv = vec2(q.x / a, q.y / bEff);
  // The cheap rim wobble, on top of the warp above. It bites INWARD only, so it
  // can never push a stroke past the radius the candidate set was sized for.
  float rl = length(uv);
  if (rl > 1e-4) uv *= raggedFactor(uv / rl, cell);
  float n = max(uShapeN, 0.6);
  float au = abs(uv.x), av = abs(uv.y);
  float d = pow(pow(au, n) + pow(av, n), 1.0 / n);

  // Analytic edge width, in the units of d. The gradient of a superellipse is
  // d^(1-n) * |(|u|^(n-1)/a, |v|^(n-1)/b)|, and one pixel of screen space is
  // that reciprocal — computed rather than taken from fwidth(), which
  // differentiates across a quad and blows up wherever a quad straddles a cell
  // boundary.
  float gx = pow(max(au, 1e-3), n - 1.0) / a;
  float gy = pow(max(av, 1e-3), n - 1.0) / bEff;
  float grad = pow(max(d, 1e-3), 1.0 - n) * sqrt(gx * gx + gy * gy);
  float aa = 0.5 * max(grad, 1e-4);

  o.alpha = 1.0 - smoothstep(1.0 - aa, 1.0 + aa, d);

  // ── thickness ──────────────────────────────────────────────────────────────
  // Paint is not a slab. A mark is flat-ish across its middle, piles into a rim
  // where the brush edge dragged, and can be scooped in the centre when the
  // brush was heavily loaded. All three are functions of the same d, so the
  // relief stays registered with the outline the warp produced.
  float t = clamp(d, 0.0, 1.2);
  float core = 1.0 - smoothstep(0.55, 1.02, t);
  float rimT = (t - 0.80) / 0.16;
  float rim = uRim * exp(-rimT * rimT);
  float dipT = t / 0.5;
  float dip = uDip * exp(-dipT * dipT);

  // Per-stroke load. This is the "some are thin, others thick" axis, and it is
  // a fixed hash so a stroke's thickness never changes between frames.
  // Raising the exponent skews a uniform draw toward zero while leaving its
  // endpoints alone, so a thick stroke becomes rarer rather than every stroke
  // becoming thinner. That distinction is the whole point where a second pass
  // is burying this one: scaling the load would flatten the layer uniformly,
  // which reads as thin paint rather than as paint underneath paint.
  float load = mix(1.0 - uThickVar, 1.0 + uThickVar,
                   pow(hash1(cell, 12.73), max(loadBias, 0.05)));

  // Bristle grooves run ALONG the stroke, so they vary across it: high
  // frequency in y, low in x. The thick references show these clearly and they
  // are most of what reads as "brush" rather than "blob" under raking light.
  float groove = 1.0;
  if (uGroove > 0.0) {
    vec2 gp = vec2(q.x / max(a, 1.0) * 1.5, q.y / max(b, 1.0) * uGrooveFreq);
    groove = 1.0 + uGroove * (vnoise(gp + hash2(cell, 8.1) * 17.0) - 0.5) * 2.0;
  }

  o.height = max(core + rim - dip, 0.0) * load * groove * uThickBase;
  // Paint outside the mark has no thickness, and the rim sits close enough to
  // the edge that it must be faded with the same curve or it floats free.
  o.height *= smoothstep(1.12, 0.98, t);
  return o;
}
