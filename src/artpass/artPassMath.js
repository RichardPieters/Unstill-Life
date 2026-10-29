/**
 * artPassMath.js — the art pass's pure arithmetic. No THREE, no DOM, no
 * wall-clock, so it is unit-testable the way terrainMath.js is for the terrain
 * tick.
 *
 * Everything here answers a question the stroke shader cannot: the reveal and
 * exit curves, how the sliders relate to each other, and how big and how many
 * passes a prepass needs. The shader only ever sees the answers.
 */

/** GLSL smoothstep, in JS, for the reveal and exit curves. */
export function smoothstep01(edge0, edge1, x) {
  const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1)
  return t * t * (3 - 2 * t)
}

/**
 * Where a reveal is, `elapsed` seconds in.
 *
 * Two SEQUENTIAL steps, not one curve: priming finishes in full — the canvas
 * weave has arrived, the wash toward the ground colour has reached its ceiling
 * — before a single mark is allowed to spawn. Each has its own duration
 * slider, because "how long the canvas takes to arrive" and "how long the marks
 * take to appear" are unrelated questions and a single shared knob would force
 * one to answer for both.
 *
 * `priming` says which step is live; during it only `primeProgress` means
 * anything, and after it only `progress` does. Both durations are floored
 * rather than guarded at the call site, so a slider at 0 eases instantly
 * instead of dividing by zero.
 */
export function revealPhase(elapsed, primeDuration, duration) {
  const prime = Math.max(primeDuration, 0.001)
  if (elapsed < prime) {
    return { priming: true, primeProgress: smoothstep01(0, prime, elapsed), progress: 0 }
  }
  return {
    priming: false,
    primeProgress: 1,
    progress: Math.min((elapsed - prime) / Math.max(duration, 0.05), 1),
  }
}

/**
 * How far the ground has settled, at reveal progress `p`.
 *
 * The ground's own beat sits at whichever END the toggle asks for. Both
 * directions reuse the same beat WIDTH, just anchored at 0 or at 1:
 * underpaint-first finishes the ground alone within its own beat, well ahead of
 * the marks which keep arriving across the full duration; ground-last leaves it
 * at the live frame across the whole reveal — marks arrive over the real
 * photograph, never over bare or toned canvas — and only settles into its
 * configured look in the closing beat, after painting is essentially done.
 */
export function groundBeatProgress(p, beat, underpaintFirst) {
  const b = Math.max(beat, 0.01)
  const raw = underpaintFirst ? p / b : (p - (1 - b)) / b
  return Math.min(Math.max(raw, 0), 1)
}

/**
 * How present the canvas surface still is, at exit progress `p`.
 *
 * The two exit rules part company here. The RANDOM rule's own per-stroke draw
 * already guarantees every mark finishes fading by progress 1 (see
 * artDissolve.frag), so a windowed "hold back, then take it all" shape on the
 * canvas would be a sweep this mode doesn't have anywhere else — it instead
 * fades in direct step with progress, exactly like the strokes it sits under.
 * The DRIFT rule genuinely needs its closing sweep (nothing else guarantees a
 * calm passage ever crosses its threshold), so there the canvas goes last, on
 * the same sweep that takes the last strokes — the mirror of the entrance,
 * where it arrived first.
 */
export function exitFade(p, { random, sweep }) {
  // Clamped rather than trusted: progress is the caller's arithmetic, and the
  // direct branch below turns a p of 1 + 2e-16 into a NEGATIVE presence, which
  // is meaningless to every consumer (it scales the canvas weave). The
  // smoothstep branch already clamps internally, so this makes the two agree.
  const t = Math.min(Math.max(p, 0), 1)
  if (random) return 1 - t
  return 1 - smoothstep01(1 - Math.max(sweep, 0.01), 1, t)
}

/**
 * Smallest dot fill that leaves no holes at a given placement jitter.
 *
 * On a jittered lattice of spacing c with jitter fraction j, the worst case is
 * a pixel at a cell corner whose four surrounding strokes have all jittered
 * directly away from it. A stroke's offset from its cell centre is ±j/2 per
 * AXIS, so such a neighbour sits (0.5 + j/2)·c away along x and the same along
 * y — a distance of √2·c·(0.5 + j/2). Dot fill is measured in units of c, so
 * the floor is independent of c: stroke size can be changed freely, jitter
 * cannot.
 *
 * Below this the lattice leaves bare ground, which reads as flat patches — most
 * visible in the sky, where strokes sit closest to the ground colour.
 *
 * The jitter term carries the same √2 as the lattice term, because the
 * displacement is diagonal. `√2/2 + j/2` would treat it as axis-aligned and
 * understate the floor by about 15% at full jitter.
 *
 * This is a GUIDE, not a guarantee in either direction: it compares against a
 * stroke's nominal radius, but elongation divides the minor semi-axis by
 * `aspect` and the ragged rim only ever bites inward, so no stroke reaches its
 * nominal radius in every direction — while 25 candidates at the shipped defaults,
 * not four, are actually in play. The sliders are tuned to this NOMINAL floor,
 * which is why it is the target despite being only a guide.
 */
export function coverageFloor(jitter) {
  return Math.SQRT2 * (0.5 + jitter / 2)
}

/**
 * How far relief height has to move when the stroke size does: the factor on
 * the `relief height` slider, which names the value at RELIEF_REF_CELL.
 *
 * Relief is read from the GRADIENT of the height field, and a stroke of radius
 * R spreads its profile over R pixels — so |grad h| goes as H/R, and holding the
 * apparent slope fixed would need H proportional to the cell size. That would
 * put cell 26 at 3.03 against cell 3's 0.35.
 *
 * The real relation is shallower, and the reason is the Sobel: its radius is
 * fixed in PIXELS, so at a 3px cell the kernel spans a large fraction of the
 * stroke and under-reads its true slope, while at 26px it sits well inside the
 * smooth part of the profile and reads it correctly. Small strokes therefore
 * need proportionally more height than the naive law predicts.
 *
 * Anchored on two tuned points — 0.35 at cell 3, 1.35 at cell 26 — which fixes
 * the exponent at ln(1.35/0.35)/ln(26/3) = 0.625. Every other stroke size is
 * derived, so changing stroke size does not change how thick the paint looks.
 */
export const RELIEF_REF_CELL = 3
export const RELIEF_EXPONENT = Math.log(1.35 / 0.35) / Math.log(26 / 3)

export function reliefScale(cell) {
  return Math.pow(Math.max(cell, 0.5) / RELIEF_REF_CELL, RELIEF_EXPONENT)
}

/**
 * The Gaussian sigma matching a hardware mip level.
 *
 * The ground-blur slider is in mip LEVELS, though the blur is a gather that can
 * reject a tap at an occlusion edge. A mip fetch of level L is approximately a box filter of width 2^L, and a box
 * of width w has variance w²/12 — so sigma = 2^L/√12.
 *
 * Reading the slider as a radius instead would make the gather 1.8x wider than
 * the mip chain at the same number.
 */
export function sigmaForMipLevel(level) {
  return Math.pow(2, level) / Math.sqrt(12)
}

/**
 * The jump-flood step sequence for a target of this size.
 *
 * Starts at half the larger axis rounded up to a power of two, and halves to 1.
 * That first frame-sized hop is what makes the flood O(log N) passes rather
 * than O(N): a seed can travel the whole frame in the first step.
 */
export function jfaSteps(width, height) {
  const steps = []
  const span = Math.max(width, height, 2)
  for (let s = Math.pow(2, Math.ceil(Math.log2(span)) - 1); s >= 1; s /= 2) steps.push(s)
  return steps
}

/**
 * Size of a prepass target at a given resolution scale.
 *
 * The edge field and the ground gather both run below full resolution, because
 * both are read through a wide smooth kernel that cannot resolve the difference
 * — the edge field only inside a stroke-radius band, the ground only after a
 * blur several pixels wide. At least 1 pixel per axis, so a degenerate scale
 * cannot produce a zero-sized target (which fails framebuffer completeness
 * rather than merely looking wrong).
 */
/**
 * The drawing-buffer width at which the pixel-valued sliders (stroke size,
 * weave scale, relief detail, tangent smoothing, growth reach) mean what they
 * say: a 1470 by 923 window at pixel ratio 2, the setup the defaults were tuned on.
 */
export const DESIGN_WIDTH_PX = 2940

/** The frame the camera always shows: the 16:9 composition (main.js). */
const DESIGN_ASPECT = 16 / 9

/** Smallest stroke size, in drawing-buffer pixels: below it strokes alias. */
export const MIN_CELL_PX = 2

/**
 * Drawing-buffer pixels per design pixel. The largest 16:9 rectangle that fits
 * the buffer, over the design width, so the painting holds the same number of
 * strokes across the 16:9 framing at every resolution, pixel ratio and window
 * shape; extra width or height adds strokes of the same size.
 */
export function paintScale(width, height) {
  return Math.min(width, height * DESIGN_ASPECT) / DESIGN_WIDTH_PX
}

/**
 * The share of the buffer's pixels the prepasses (edge field, ground, growth)
 * run at. `scale` is the slider, a share at the design size; dividing by the
 * paint scale keeps the prepass at the same design-relative resolution, so a
 * large buffer does not pay for a larger prepass, capped at the buffer itself.
 */
export function prepassFraction(scale, paintScaleValue) {
  return Math.min(1, scale / Math.max(paintScaleValue, 1e-3))
}

/**
 * How many prepass texels one design pixel spans, relative to the slider's
 * share: 1 unless the buffer is smaller than the prepass wants (then fewer).
 * The prepass settings (tangent smoothing, ground blur, growth reach) are
 * counted in prepass texels at the design size and scale by this.
 */
export function texelScale(scale, paintScaleValue) {
  return prepassFraction(scale, paintScaleValue) * paintScaleValue / scale
}

export function prepassSize(width, height, scale) {
  const s = Math.min(Math.max(scale, 0.05), 1)
  return { width: Math.max(1, Math.round(width * s)), height: Math.max(1, Math.round(height * s)) }
}

/**
 * The darkest cell of an RGBA byte grid, as fractional grid coordinates in
 * [0,1] — where the reveal's growth should start (artGrowthPick.frag).
 *
 * Rec. 709 luminance, not a channel sum: a saturated blue and a mid grey can
 * carry the same channel total while looking nothing alike in value, and it is
 * VALUE a painter blocks in first.
 *
 * Ties go to the first cell scanned, which only matters for a flat frame —
 * where every choice is equally correct and the seed may as well be
 * deterministic rather than depending on float comparison order.
 */
export function darkestCell(rgba, width, height) {
  let best = Infinity
  let bx = 0
  let by = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const lum = 0.2126 * rgba[i] + 0.7152 * rgba[i + 1] + 0.0722 * rgba[i + 2]
      if (lum < best) { best = lum; bx = x; by = y }
    }
  }
  // The CENTRE of the winning cell: its corner would bias every seed up-left
  // by half a cell, which at 32 cells across is a real fraction of the frame.
  return { u: (bx + 0.5) / width, v: (by + 0.5) / height }
}

/** The cell index of a lattice table's first texel, per axis. Mirrors
 *  TABLE_ORIGIN in artLattice.glsl. */
export const LATTICE_TABLE_ORIGIN = -5

/**
 * Cells per axis in a lattice table (artBirth.frag) for a frame `extent` pixels
 * across and cells of `cellPx`: the cells covering the frame plus the margin a
 * pixel's search can reach outside it. Mirrors TABLE_ORIGIN and MAX_RING in
 * artLattice.glsl, which place the first cell at -5 and the last at the frame's
 * last cell plus 5.
 */
export function latticeTableSize(extent, cellPx) {
  return Math.ceil(extent / cellPx) + 11
}

/** Blocks of `cellPx` pixels per axis, the resolution of the dirty mask. */
export function dirtyBlocks(extent, cellPx) {
  return Math.ceil(extent / cellPx)
}

/**
 * What the stroke target needs this frame, to be what a full redraw would draw
 * at reveal progress `spawn`.
 *
 * `held` is the progress the target already shows, or null when it shows
 * nothing valid (never drawn, or invalidated since). Progress 0 and below mean
 * "nothing born yet", all the same picture, so they are one state, -1: the
 * first stroke, born at exactly 0, is then new when progress first rises above 0.
 *
 *   'full'         redraw every pixel: nothing valid to build on
 *   'incremental'  redraw only around the strokes born since `held`
 *   'none'         the target already is that picture
 *
 * Progress only ever rises during an entrance; a lower value than the target
 * holds is a restart and gets a full redraw.
 */
export function strokeRedraw(held, spawn) {
  const target = spawn > 0 ? spawn : -1
  if (held === null || target < held) return { mode: 'full', target }
  if (target === held) return { mode: 'none', target }
  return { mode: 'incremental', target }
}

/**
 * The texels of a lattice table (first texel = cell LATTICE_TABLE_ORIGIN) that
 * hold a cell inside the frame, `cellsX` by `cellsY` cells. The table also holds
 * the margin cells a pixel's search can reach outside the frame; they are never
 * on screen, so anything that counts strokes leaves them out.
 */
function inFrameTexels(width, height, cellsX, cellsY) {
  const out = []
  for (let y = 0; y < height; y++) {
    const cy = y + LATTICE_TABLE_ORIGIN
    if (cy < 0 || cy >= cellsY) continue
    for (let x = 0; x < width; x++) {
      const cx = x + LATTICE_TABLE_ORIGIN
      if (cx >= 0 && cx < cellsX) out.push(y * width + x)
    }
  }
  return out
}

/**
 * The birth times of the strokes inside the frame, sorted. `table` is a baked
 * lattice table read back as RGBA floats, birth in R. Counting the margin
 * cells would spend a share of the reveal on strokes nobody sees.
 */
export function inFrameBirths(table, width, height, cellsX, cellsY) {
  return Float32Array.from(inFrameTexels(width, height, cellsX, cellsY), i => table[i * 4]).sort()
}

/**
 * The share of the strokes inside the frame that have gone, from the count
 * pass's table read back as RGBA bytes (R: 255 once a stroke is gone).
 */
export function shareGone(table, width, height, cellsX, cellsY) {
  const texels = inFrameTexels(width, height, cellsX, cellsY)
  let gone = 0
  for (const i of texels) if (table[i * 4] > 127) gone++
  return texels.length ? gone / texels.length : 0
}

/** The share of `sorted` at or below `b`: the fraction of strokes on screen at
 *  progress `b`. 0 for an empty list. */
export function shareAtOrBelow(sorted, b) {
  let lo = 0, hi = sorted.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (sorted[mid] <= b) lo = mid + 1; else hi = mid
  }
  return sorted.length ? lo / sorted.length : 0
}

/**
 * A birth time, moved toward an even pace.
 *
 * The raw birth times bunch: a growth front crosses a flat colour in a narrow
 * range of times and then waits at a border, so strokes arrive in bursts.
 * Replacing a time by the share of strokes born at or before it (its place in
 * the order, as a fraction) gives every stroke the time at which exactly that
 * share of the picture is up, a constant number of strokes per second. The
 * order is untouched: the map is non-decreasing, so no stroke passes another.
 * `even` blends from the raw times (0) to the even ones (1).
 *
 * @param {number} b       a birth time in [0,1]
 * @param {Float32Array} sorted  inFrameBirths of the same table
 * @param {number} even    [0,1]
 */
export function evenPaced(b, sorted, even) {
  return b + (shareAtOrBelow(sorted, b) - b) * even
}
