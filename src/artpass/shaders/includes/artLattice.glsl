/**
 * artLattice.glsl — where the strokes of one lattice sit, and how far each can
 * reach.
 *
 * Three programs agree on this geometry: the birth table (artBirth.frag) bakes
 * each cell's centre and arrival time, the dirty mask (artDirty.frag) finds the
 * pixels a newly arrived stroke can touch, and the stroke pass (artPaint.frag)
 * paints. A copy of it in each would drift: a mask that believes a stroke
 * reaches less far than the painter lets it leaves stale pixels behind.
 *
 * Requires artHash.glsl spliced before it.
 *
 * A lattice is cells of `cellPx` screen pixels, offset by `gridOff` cells. A
 * stroke lives near its cell's centre, moved by up to uJitter/2 cells. The
 * three lattices of the pass (the base one, the depth in-fill at half the
 * spacing, the second sitting offset by half a cell) are LayerCfg values; the
 * stroke pass adds the fields only it needs.
 */

uniform float uCellPx;         // lattice spacing, screen pixels
uniform float uDotScale;       // stroke radius as a fraction of the cell
uniform float uJitter;         // how far a stroke may sit from its cell centre
uniform float uAspectRatio;    // stroke elongation along its orientation
uniform float uTaper;          // 0 = symmetric, 1 = one end pinched to nothing
uniform float uWarpAmp;        // domain warp, as a fraction of the stroke radius

// The cells a lattice TABLE holds, per axis: from this index up. A pixel looks
// at the cells within MAX_RING of its own, so the cells it can ask about run
// from one below the frame (the second sitting is offset by half a cell) minus
// the ring.
const int TABLE_ORIGIN = -5;
const int MAX_RING = 4;

struct LayerCfg {
  float cellPx;       // lattice spacing, screen pixels
  float rCellPx;      // the cell size the RADIUS derives from, which is not
                      // cellPx for the depth in-fill: same dots, finer lattice
  float densityGate;  // 1 = spawn in the proportion the depth shrink demands
  vec2  gridOff;      // lattice offset, in cells
  vec2  seedOff;      // added to the cell index before hashing, so a second
                      // pass over the same grid draws different randomness
  float spawnFrac;    // 1 = every cell; below, a fixed-hash subset of them
  float loadBias;     // exponent on the thickness draw; above 1 makes a thick
                      // stroke less likely without changing the range
};

LayerCfg layerCfg(float cellPx, float rCellPx) {
  return LayerCfg(cellPx, rCellPx, 0.0, vec2(0.0), vec2(0.0), 1.0, 1.0);
}

/**
 * The farthest any stroke of a layer can reach from its centre, in pixels
 * (strokeAt in artStroke.glsl). Shrinking with depth only makes a stroke
 * smaller, so the unshrunk radius bounds them all. A stroke is painted where
 * d < 1 + aa in its warped stroke space, with half-axes a (along) and bEff <=
 * b(1 + taper) (across), both raised to 0.5 px at the least. The antialias
 * width aa is at most 0.5 * sqrt(1/a^2 + 1/bEff^2), so in pixels it adds at
 * most 0.5 * sqrt(1 + (a/bEff)^2) along the stroke and 0.5 * sqrt(1 +
 * (bEff/a)^2) across it, and a tapered tip makes bEff as small as b * max(1 -
 * taper, 0.05). The domain warp then moves a point by at most uWarpAmp * min(a,
 * b) along each axis. (The bound holds for the superellipse exponent n >= 1;
 * the slider stops at 1.2.)
 */
float strokeReachPx(float rCellPx) {
  float rMax = rCellPx * uDotScale;
  float aMax = max(rMax, 0.5);
  float bBase = max(rMax / max(uAspectRatio, 0.05), 0.5);
  float bMax = bBase * (1.0 + uTaper);
  float ratioAlong  = max(uAspectRatio, 1.0) / max(1.0 - uTaper, 0.05);
  float ratioAcross = (1.0 + uTaper) * max(1.0 / max(uAspectRatio, 0.05), 1.0);
  float reachAlong  = aMax + 0.5 * sqrt(1.0 + ratioAlong * ratioAlong);
  float reachAcross = bMax + 0.5 * sqrt(1.0 + ratioAcross * ratioAcross);
  return length(vec2(reachAlong, reachAcross)) + 1.4143 * uWarpAmp * min(aMax, bBase);
}

/**
 * How many cells out from its own a pixel searches for strokes that cover it.
 *
 * Not the 3x3 ring a stroke the size of a cell would allow: the shape test
 * scales the across-axis by aspect before comparing against r, so a stroke
 * extends r along its long axis and r/aspect across it, a maximum of
 * r * max(1, 1/aspect). r is rCellPx * dotScale, which is not cellPx when the
 * depth in-fill runs a finer lattice with base-size strokes. The stroke may sit
 * a further jitter/2 cells from its cell centre, and the pixel half a cell from
 * its own. At the shipped defaults that is 1.245 cells, past the one cell a 3x3
 * ring reaches, and the dropped strokes read as a faint rectangular grid over
 * the frame. (The ring ignores the warp and the taper, which the exact reach
 * above includes; widening it would change the picture.)
 *
 * Capped, because the cost is quadratic: 9 candidates at 1, 81 at 4.
 */
int ringRadius(LayerCfg cfg) {
  float reachCells = (cfg.rCellPx / max(cfg.cellPx, 0.5)) * uDotScale
                   * max(1.0, 1.0 / max(uAspectRatio, 0.05))
                   + 0.5 + uJitter * 0.5;
  return int(min(ceil(reachCells), float(MAX_RING)));
}

/** A stroke's anchor in screen pixels: its cell's centre, moved by its jitter.
 *  `hcell` is the SEEDED index, which the jitter is drawn from. */
vec2 strokeCentrePx(vec2 cell, vec2 hcell, LayerCfg cfg) {
  vec2 jit = (hash2(hcell, 1.7) - 0.5) * uJitter;
  return (cell + cfg.gridOff + 0.5 + jit) * cfg.cellPx;
}
