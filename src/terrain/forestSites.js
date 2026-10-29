/**
 * forestSites.js — which forest lattice sites the per-site table must hold.
 *
 * forest.glsl decides each tree's existence, species and root gradient once per
 * lattice SITE (forestSite), in a pass that writes one texel per site, and the
 * terrain fragments read that table instead of re-deriving the verdict for
 * every crown candidate they can see. The table is a window onto the infinite
 * lattice: texel (0,0) holds site `origin`, and it must hold every site any
 * fragment of the terrain plane can visit. This module computes that window.
 *
 * A fragment at field position p = matXZ / cell sits in skewed cell
 * i = floor(p + (p.x + p.y) * F2) and visits sites i + (a, b) for a, b in
 * [-2, 2] (forestResolve's 5x5 block; the 3-site fast path is a subset). The
 * skew is increasing in both coordinates, so over the plane — matXZ ranging
 * over [-size/2, size/2]² plus the drift — i is smallest at the low corner and
 * largest at the high one.
 *
 * Pure: no THREE, no GL.
 */

// Simplex skew, (sqrt(3)-1)/2 — mirrors forest.glsl's CAN_F2.
export const LATTICE_SKEW = (Math.sqrt(3) - 1) / 2

// How far, in lattice steps, a fragment's sites reach from its own cell:
// forestResolve's 5x5 block spans ±2, and one more absorbs the float32 rounding
// between the GPU's p and the double-precision corners computed here.
export const SITE_REACH = 3

// Table sides are rounded up to this, so a slowly drifting window does not
// reallocate the render target every time it gains a row.
const TABLE_GRANULE = 64

/**
 * The lattice window a frame's site table must cover.
 * @param {number} planeSize  terrain plane side, world units
 * @param {number} cellSize   uForestCell, world units per field unit
 * @param {{x:number, y:number}} drift  uFBM0DriftOffset (material frame = world + drift)
 * @returns {{origin: [number, number], size: number}} site at texel (0,0), and
 *          the side length (in sites) the table needs
 */
export function forestSiteWindow(planeSize, cellSize, drift) {
  const c = Math.max(cellSize, 0.01)   // as forest.glsl divides by it
  const skewedCell = (x, z) => {
    const s = (x + z) * LATTICE_SKEW
    return [Math.floor(x + s), Math.floor(z + s)]
  }
  const half = planeSize / 2
  const lo = skewedCell((-half + drift.x) / c, (-half + drift.y) / c)
  const hi = skewedCell((half + drift.x) / c, (half + drift.y) / c)
  const origin = [lo[0] - SITE_REACH, lo[1] - SITE_REACH]
  const size = Math.max(hi[0] - lo[0], hi[1] - lo[1]) + 2 * SITE_REACH + 1
  return { origin, size }
}

/**
 * Side length to allocate for a table that needs `needed` sites: rounded up to
 * a whole granule, and the current allocation kept while it still fits and is
 * not more than twice what is needed.
 * @param {number} needed   forestSiteWindow(...).size
 * @param {number} current  side of the existing table, 0 if none
 */
export function forestSiteTableSide(needed, current) {
  if (current >= needed && current <= 2 * needed) return current
  return Math.ceil(needed / TABLE_GRANULE) * TABLE_GRANULE
}
