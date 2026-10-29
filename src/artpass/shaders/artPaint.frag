/**
 * artPaint.frag — the divisionist stroke pass. The lattice engine.
 *
 * Strokes are anchored to the CANVAS, not to the world: the piece has a stable
 * viewpoint, so a stroke's screen position never moves and only the scene data
 * under it changes. Every property of a stroke is a pure function of its cell
 * index and the G-buffer at its anchor — no temporal state — so any region
 * whose data has not changed reproduces bit-identical strokes, and the paint
 * holds still while the landscape morphs underneath it.
 *
 * What it draws: the STROKES ONLY, with no ground under them. Output is the
 * premultiplied paint (the colours of the strokes over a pixel, each weighted
 * by what is left uncovered by those above it) plus how much of the pixel the
 * strokes cover, so the ground can be put underneath later and changed on its
 * own (artCompose.frag). That keeps the ground's fade, the canvas weave and
 * the weather's colour drift from forcing the strokes to be redrawn.
 *
 * Opaque writes only: this pass draws one winner per pixel, so it needs no
 * blending (which would have to be additive on thickness and interpolating on
 * colour at once, and WebGL2 has no per-attachment blend equation).
 *   attachment 0  RGB the premultiplied paint · A the accumulated thickness as
 *                 a fraction of HEIGHT_MAX, UNCLAMPED
 *   attachment 1  R which stroke owns the pixel · GB where it was anchored · A
 *                 the fraction of the pixel the strokes cover. Nothing live
 *                 needs the id, but the exit dissolve (artDissolve.frag) does,
 *                 once the picture is held.
 *
 * INCREMENTAL. During the entrance a stroke is invisible until its birth time
 * and then there for good, so a frame differs from the last only around the
 * strokes born in between. The target is drawn into WITHOUT clearing, and a
 * pixel whose block the dirty mask (artDirty.frag) did not flag is discarded,
 * keeping what the last frame left. A flagged pixel is redrawn from scratch
 * over every stroke born so far, so what the target holds is exactly what a
 * full redraw would draw. uAllDirty skips the mask for that full redraw.
 */

uniform vec2  uRes;

//#include colour
//#include format
//#include frame
//#include noise
//#include scene
//#include lattice

in  vec2 vUv;
layout(location = 0) out vec4 fragColor;
// R: stroke id (a hash in [0,1), or NO_STROKE_ID). GB: the stroke's own anchor
// uv, for the exit dissolve to measure drift where it was actually painted from
// rather than at whatever pixel happens to be asking. A: how much of the pixel
// the strokes cover.
layout(location = 1) out vec4 fragId;

uniform float uSizeByDepth;    // stroke size grading with distance
uniform float uAerial;         // spread falls with distance (hue variance)

// The abstraction step. Strokes read their colour at a mip level rather than at
// full resolution, so they carry large shapes instead of the terrain's
// per-pixel detail. The references read as three to five flat shapes; divided
// strokes over high-frequency detail read as noise.
uniform sampler2D uBeauty;
uniform float uFlatten;

// A SECOND sitting: the same lattice, half a cell across, with its own
// randomness. 0 paints none of it, 1 paints all of it. Strokes underneath get
// a thickness penalty as it fills in, because a buried stroke is buried.
uniform float uLayer2;

// Spread per segment. One global k cannot serve sky and land at once: pale sky
// solves to mostly lead white plus a rare saturated accent, so the dominant
// family disappears into the ground and only the accent reads.
uniform float uKSky;
uniform float uKWater;
uniform float uKLandNear;
uniform float uKLandFar;
uniform float uGroundMix;      // how much bare ground shows between strokes

// The lattice tables (artBirth.frag): per cell, its birth time and its anchor.
uniform sampler2D uBirthBase;
uniform sampler2D uBirthFill;
uniform sampler2D uBirthLayer2;
// The entrance animation (artPass.js's playReveal). At rest it is 1, so every
// stroke is born; a stroke is drawn once its birth time has been reached.
uniform float uRevealSpawn;      // 0 = nothing painted yet, 1 = everything is

// Incremental redraw: the blocks of uCellPx pixels that need redrawing.
uniform sampler2D uDirty;
uniform float uAllDirty;         // 1 = redraw everything, ignore the mask

//#include stroke
//#include orient

/**
 * The stroke of one lattice cell at this pixel, or nothing.
 *
 * Returns whether the cell's stroke is there to be painted: it exists (a fixed
 * hash subset), is near enough to reach the pixel, has arrived, passes the
 * depth in-fill's density test, and covers the pixel. If so, `st` is its shape
 * and thickness there, `anchorUv` where it was painted from and `dpt` the depth
 * at that anchor (0 near … 1 far).
 */
bool strokeAtPixel(vec2 frag, vec2 cell, vec2 hcell, LayerCfg cfg, sampler2D table,
                   float strokeReachSq, out Stroke st, out vec2 anchorUv, out float dpt) {
  // A fixed-hash subset. Fixed, so raising the slider switches cells on one at
  // a time rather than re-rolling which ones are present — the paint
  // accumulates as the slider moves instead of reshuffling.
  if (cfg.spawnFrac < 0.999 && hash1(hcell, 51.37) > cfg.spawnFrac) return false;

  // The stroke's birth time and anchor, from the lattice table.
  vec3 entry = texelFetch(table, ivec2(cell) - TABLE_ORIGIN, 0).rgb;
  vec2 centrePx = entry.yz;
  vec2 toPixel = frag - centrePx;
  if (dot(toPixel, toPixel) > strokeReachSq) return false;
  // Not yet arrived. The arrival order is the table's (artBirth.frag); a stroke
  // that has arrived stays, at full size, in a single frame.
  if (entry.x > uRevealSpawn) return false;

  anchorUv = clamp(centrePx / uRes, 0.0, 1.0);

  // Distance is measured, not guessed at from screen height. A screen-v proxy
  // is only monotonic in distance for flat ground: a near hilltop and a far
  // shoreline can share a scanline, and the proxy gives them the same stroke
  // size.
  dpt = depth01(anchorUv);

  // Size comes from rCellPx, placement from cellPx. They are the same for every
  // layer except the depth in-fill below, which needs strokes of the base size
  // sitting on a finer lattice — same dots, more of them. Sky is graded too: it
  // sits at the far plane, so it is simply the farthest thing in the frame, and
  // grading it with everything else is the consistent reading.
  float shrink = mix(1.0, 0.45, dpt * uSizeByDepth);
  float r = cfg.rCellPx * uDotScale * shrink;

  // Depth in-fill. Shrinking a stroke without adding strokes drops the covering
  // ratio r/c and opens holes in the far ground. This layer restores the ratio.
  //
  // Coverage needs stroke COUNT per area to rise as 1/shrink^2. A lattice at
  // half the spacing holds four times as many cells, so the fraction of them
  // that has to light up is (1/shrink^2 - 1)/3 — 0 when nothing has shrunk, 1
  // by the time strokes are at half size. Derived, not tuned.
  //
  // The test is a FIXED per-cell hash against that fraction, so cells switch on
  // one at a time as the fraction passes each one's own threshold, scattered
  // over the area. A shared threshold would light a whole region at once. And
  // because it gates only WHETHER a stroke exists, never which cell it belongs
  // to, the canvas anchoring is untouched.
  if (cfg.densityGate > 0.5) {
    float frac = clamp((1.0 / max(shrink * shrink, 1e-3) - 1.0) / 3.0, 0.0, 1.0);
    if (hash1(hcell, 77.3) > frac) return false;
  }

  float ang = orientationAt(anchorUv);

  // Into stroke space: +x along the stroke's own direction. Shape, thickness,
  // taper and the bristle grooves are all one-dimensional there.
  float ca = cos(ang), sa = sin(ang);
  vec2 e = vec2(toPixel.x * ca + toPixel.y * sa, -toPixel.x * sa + toPixel.y * ca);

  st = strokeAt(e, r, r / max(uAspectRatio, 0.05), hcell, cfg.loadBias);
  return st.alpha > 0.0;
}

/**
 * The colour of a stroke: the frame at its anchor, run through the pigment
 * engine with the spread its segment allows.
 */
vec3 colourOfStroke(vec2 anchorUv, float dpt, vec2 hcell) {
  vec3 Csrc = frameLod(uBeauty, anchorUv, uFlatten);

  // Which segment this stroke stands on decides how far its family may sit from
  // the target. Land eases from its near value to its far one with distance.
  float kSeg = (coverAt(anchorUv) < 0.5) ? uKSky
             : (waterAt(anchorUv) > 0.5) ? uKWater
             : mix(uKLandNear, uKLandFar, dpt);
  // Aerial perspective acts on hue VARIANCE, not only on the mean colour:
  // distance thins the number of distinct pigments a passage carries. The mean
  // is already handled by the scene's own fog.
  kSeg *= mix(1.0, 0.25, dpt * uAerial);

  return strokeColour(Csrc, hcell, kSeg);
}

/**
 * The top two strokes at a pixel, and the thickness of all of them.
 *
 * id1/id2 and anchor1/anchor2 exist for the exit dissolve (artDissolve.frag),
 * which needs to know WHICH stroke a pixel belongs to and where that stroke
 * was anchored, not just what colour it painted — see main()'s finalId/
 * finalAnchor below for how a whole pixel resolves to one of them.
 */
struct Layer {
  vec3  c1; float a1; float id1; vec2 anchor1;
  vec3  c2; float a2; float id2; vec2 anchor2;
  float hAcc;
};

Layer paintLayer(vec2 frag, LayerCfg cfg, sampler2D table) {
  float cellPx = cfg.cellPx;

  // While the entrance is priming (spawn 0) no mark has been born, so every
  // candidate below would be skipped by its birth test: the layer is empty.
  if (uRevealSpawn <= 0.0) {
    return Layer(vec3(0.0), 0.0, -1.0, vec2(0.0), vec3(0.0), 0.0, -1.0, vec2(0.0), 0.0);
  }

  // A candidate farther away than this gives alpha 0 and changes nothing, so it
  // is skipped before any work (artLattice.glsl derives the bound).
  float strokeReach = strokeReachPx(cfg.rCellPx);
  float strokeReachSq = strokeReach * strokeReach;

  // Paint is opaque: a later stroke COVERS an earlier one. Averaging the
  // overlaps instead blends them into soft blobs and the picture goes muddy at
  // any useful stroke size. So the two strokes with the highest order win, and
  // the top one is composited over the second — enough for a crisp edge with
  // antialiasing, without sorting every candidate.
  vec3  c1 = vec3(0.0), c2 = vec3(0.0);
  float a1 = 0.0, a2 = 0.0;
  float o1 = -1.0, o2 = -1.0;
  vec2  anchor1 = vec2(0.0), anchor2 = vec2(0.0);

  // Paint thickness, accumulated over every stroke that reaches this pixel.
  // It must NOT be built from a1/a2: those are the top two strokes by render
  // ORDER, which is a random per-cell hash, so a stroke that merely clips a
  // pixel can outrank one that fully covers it. Height then jumps across every
  // rim and the relief lighting traces a hard contour around each stroke.
  // A sum over all candidates has no such ordering discontinuity.
  float hAcc = 0.0;

  // The lattice. Cells are square in screen space and a stroke lives near its
  // cell's centre, but not within one cell of it (ringRadius).
  int R = ringRadius(cfg);

  vec2 cellF = frag / cellPx - cfg.gridOff;
  vec2 base = floor(cellF);

  for (int dy = -MAX_RING; dy <= MAX_RING; dy++) {
    if (dy < -R || dy > R) continue;
    for (int dx = -MAX_RING; dx <= MAX_RING; dx++) {
      if (dx < -R || dx > R) continue;
      vec2 cell = base + vec2(float(dx), float(dy));
      // Geometry uses the cell index; randomness uses the SEEDED index, so a
      // second pass over the same lattice draws its own jitter, colour pick,
      // order and rim rather than repeating the first pass exactly.
      vec2 hcell = cell + cfg.seedOff;

      Stroke st; vec2 anchorUv; float dpt;
      if (!strokeAtPixel(frag, cell, hcell, cfg, table, strokeReachSq, st, anchorUv, dpt)) continue;

      // Height sums over EVERY candidate, never over the top two — see the
      // declaration of hAcc above for why.
      hAcc += st.height;

      // Painter's order from a fixed per-cell hash: deterministic, so the stack
      // never reshuffles between frames — which is what keeps the paint still
      // where the scene has not changed. Only a stroke that makes the top two
      // needs a colour.
      float ord = hash1(hcell, 41.9);
      if (ord > o2) {
        vec3 sc = colourOfStroke(anchorUv, dpt, hcell);
        if (ord > o1) {
          o2 = o1; c2 = c1; a2 = a1; anchor2 = anchor1;
          o1 = ord; c1 = sc; a1 = st.alpha; anchor1 = anchorUv;
        } else {
          o2 = ord; c2 = sc; a2 = st.alpha; anchor2 = anchorUv;
        }
      }
    }
  }

  Layer L;
  L.c1 = c1; L.a1 = a1; L.id1 = o1; L.anchor1 = anchor1;
  L.c2 = c2; L.a2 = a2; L.id2 = o2; L.anchor2 = anchor2;
  L.hAcc = hAcc;
  return L;
}

/**
 * Put a layer's strokes over what is already painted.
 *
 * `paint` is premultiplied: each stroke's colour weighted by what the strokes
 * above it leave uncovered, and `clear` is the fraction of the pixel no stroke
 * covers (what the ground will show through). A stroke of opacity A over a
 * pixel in this state gives
 *   paint' = paint * (1 - A) + colour * A      clear' = clear * (1 - A)
 * which is the usual "over", with the ground left out until artCompose.frag
 * lays it underneath: ground * clear + paint.
 */
void layerOver(inout vec3 paint, inout float clear, Layer L, float g) {
  float A1 = L.a1 * g, A2 = L.a2 * g;
  paint = paint * (1.0 - A2) * (1.0 - A1) + L.c2 * A2 * (1.0 - A1) + L.c1 * A1;
  clear *= (1.0 - A2) * (1.0 - A1);
}

void main() {
  // The pixels of a block the mask did not flag keep what the last frame drew.
  if (uAllDirty < 0.5 && texelFetch(uDirty, ivec2(gl_FragCoord.xy / uCellPx), 0).r < 0.5) {
    discard;
  }

  vec2 frag = vUv * uRes;
  float g = 1.0 - uGroundMix;

  vec3  paint = vec3(0.0);
  float clear = 1.0;
  float hAcc = 0.0;

  // WHICH stroke a pixel belongs to, for the exit dissolve. Unlike the colour,
  // which blends smoothly across a rim, ownership is binary: whichever
  // candidate covers more than half the pixel is who this pixel belongs to. A
  // rim pixel's blended COLOUR is still a genuine blend, but its identity for
  // the purpose of "when does this pixel's paint leave" is the dominant
  // stroke's, not an independent draw of its own, which would leave a
  // ring-shaped residue. Below 50% coverage a layer leaves whatever the
  // previous layer decided alone.
  float finalId = NO_STROKE_ID;
  vec2  finalAnchor = vec2(0.0);

  // As the second pass fills in, strokes underneath it are buried — so a thick
  // one becomes less likely down here. Raising the exponent skews the draw
  // toward zero without narrowing its range, which is what "less likely to be
  // thick" means; scaling the load instead would make every stroke below
  // uniformly thinner, which reads as thin paint rather than as paint
  // underneath paint.
  LayerCfg baseCfg = layerCfg(uCellPx, uCellPx);
  baseCfg.loadBias = 1.0 + 2.0 * uLayer2;
  Layer L = paintLayer(frag, baseCfg, uBirthBase);
  layerOver(paint, clear, L, g);
  hAcc += L.hAcc;
  if (L.a1 * g > 0.5) { finalId = L.id1; finalAnchor = L.anchor1; }
  else if (L.a2 * g > 0.5) { finalId = L.id2; finalAnchor = L.anchor2; }

  // Depth in-fill. Shrinking a stroke without adding strokes drops the covering
  // ratio below the floor and opens holes in the far ground. This lays a second
  // lattice at half the spacing carrying strokes of the BASE size, with only as
  // many of them switched on as the shrink has made necessary — so distance buys
  // finer grain rather than holes.
  //
  // Skipped entirely when the slider is at zero: with no shrink the spawn
  // fraction is zero anyway, and this way the extra search is not paid for.
  if (uSizeByDepth > 0.0) {
    LayerCfg fillCfg = layerCfg(uCellPx * 0.5, uCellPx);
    fillCfg.densityGate = 1.0;
    Layer fill = paintLayer(frag, fillCfg, uBirthFill);
    layerOver(paint, clear, fill, g);
    hAcc += fill.hAcc;
    if (fill.a1 * g > 0.5) { finalId = fill.id1; finalAnchor = fill.anchor1; }
    else if (fill.a2 * g > 0.5) { finalId = fill.id2; finalAnchor = fill.anchor2; }
  }

  // The second sitting: the same lattice again, half a cell across and with its
  // own randomness, painted straight over the first. Only a fixed-hash subset of
  // its cells fire, so the slider walks from none of it to all of it while the
  // cells already showing stay put.
  //
  // Its height ADDS to the first pass's, which is what makes an overlap read as
  // paint over paint rather than as paint beside it — and it is the reason the
  // layer beneath is skewed thinner as this one fills in.
  if (uLayer2 > 0.0) {
    LayerCfg l2 = layerCfg(uCellPx, uCellPx);
    l2.gridOff = vec2(0.5);
    l2.seedOff = vec2(9137.0, 4271.0);
    l2.spawnFrac = uLayer2;
    Layer L2 = paintLayer(frag, l2, uBirthLayer2);
    layerOver(paint, clear, L2, g);
    hAcc += L2.hAcc;
    if (L2.a1 * g > 0.5) { finalId = L2.id1; finalAnchor = L2.anchor1; }
    else if (L2.a2 * g > 0.5) { finalId = L2.id2; finalAnchor = L2.anchor2; }
  }

  // The thickness is stored raw; artCompose.frag scales it by the coverage (a
  // pixel the paint did not cover gets no relief) and clamps it.
  fragColor = vec4(paint, hAcc / HEIGHT_MAX);
  fragId = vec4(finalId, finalAnchor, 1.0 - clear);
}
