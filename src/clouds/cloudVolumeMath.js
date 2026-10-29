/**
 * cloudVolumeMath.js — pure geometry and scheduling math for the baked cloud
 * volume (`cloudsVolume.js`). No THREE, no DOM, no wall clock, so every rule
 * that decides WHERE a texel sits in the world and WHAT gets re-baked is
 * unit-testable without a GPU.
 *
 * Terminology used throughout:
 *   world space  — the scene's coordinates.
 *   cloud space  — world space translated by the accumulated wind offset. The
 *                  density field is STATIC here; drift is expressed as the
 *                  sampling window moving through it, not as the field moving.
 *   cell         — one texel column of the volume, `cellSize` world units wide.
 *   cell index   — a cell's integer coordinate in cloud space. Unbounded: it
 *                  keeps counting up as the window drifts.
 *   texel        — a cell index folded into [0, resolution) by the toroidal
 *                  wrap. This is what `RepeatWrapping` addresses.
 */

/**
 * snoise's dominant wavelength in INPUT units — MEASURED, not assumed.
 *
 * Obtained by counting zero crossings along 40 random lines through
 * `noise.glsl`'s snoise (see `tests/tools/snoise_wavelength.mjs`): mean
 * crossing spacing 0.851, so the wavelength is twice that. The intuitive
 * `2*pi/k` is wrong for simplex noise by a factor of ~3.7, which matters
 * because everything about what this volume can and cannot represent follows
 * from it.
 */
export const SNOISE_WAVELENGTH = 1.7021

/** World units spanned by one cell. */
export function cellSize(extent, resolution) {
  return extent / resolution
}

/**
 * The highest snoise frequency a grid of this cell size can carry without
 * aliasing: Nyquist needs at least 2 samples per period, and `snoise(p*k)` has
 * world wavelength `SNOISE_WAVELENGTH / k`.
 */
export function maxSafeFrequency(cell) {
  return SNOISE_WAVELENGTH / (2 * cell)
}

/**
 * How many fBM octaves stay Nyquist-safe on this grid.
 *
 * Returns 0 when even the base octave aliases — the caller decides what to do
 * with that (VolumeClouds clamps to 1).
 */
export function safeOctaveCount(baseFreq, lacunarity, cell, hardCap = 8) {
  const kMax = maxSafeFrequency(cell)
  let n = 0
  let k = baseFreq
  while (n < hardCap && k <= kMax) {
    n++
    k *= lacunarity
  }
  return n
}

/**
 * Reciprocal of the fBM's amplitude sum, so the baked field lands in roughly
 * [-1, 1] regardless of octave count. Without it, changing the resolution
 * (which changes the safe octave count) would also change the field's
 * amplitude, and every density/coverage slider would need retuning.
 */
export function amplitudeNorm(octaves, gain) {
  let sum = 0
  let amp = 1
  for (let i = 0; i < octaves; i++) {
    sum += amp
    amp *= gain
  }
  return sum > 0 ? 1 / sum : 1
}

/**
 * Continuous clamp+smoothstep on [0,1], used below and by the boundary-octave
 * crossfade in cloudsVolume.js. Pulled out rather than inlined twice.
 */
function smoothstep01(t) {
  const x = Math.min(1, Math.max(0, t))
  return x * x * (3 - 2 * x)
}

/**
 * How close an octave's frequency sits to this grid's Nyquist limit, 0..1: 0
 * below `edgeStart` (a fraction of kMax), 1 at or past kMax, smooth between.
 *
 * Why: `safeOctaveCount` cuts off with a hard `k <= kMax` test, so the last
 * baked octave always sits right at kMax, where trilinear reconstruction
 * blurs it unpredictably. Dropping it moves it to the march, which renders it
 * sharp, so the octave would flip from blurred to sharp in one step. A wider
 * margin only moves that flip. Crossfading removes it: the octave's baked
 * weight fades out as `edge` rises while a marched term of the same frequency
 * and amplitude fades in, so the octave's own amplitude and position are
 * continuous across the drop.
 */
export function octaveEdgeCloseness(freq, kMax, edgeStart = 0.9) {
  if (!(kMax > 0) || !(freq >= 0)) return 1
  return smoothstep01((freq / kMax - edgeStart) / (1 - edgeStart))
}

/**
 * `amplitudeNorm`, generalised so the LAST octave (index `bakedOctaves - 1`)
 * can count at a FRACTIONAL weight instead of either fully in or fully out.
 * Reduces to `amplitudeNorm(bakedOctaves, gain)` exactly at edge=0 and to
 * `amplitudeNorm(bakedOctaves - 1, gain)` exactly at edge=1 — continuous in
 * `edge`, and therefore continuous across the octave-count boundary itself:
 * right before `safeOctaveCount` drops an octave, edge for that octave has
 * already reached 1, so the renormalisation this produces already equals what
 * the SMALLER octave count computes, and the flip changes nothing.
 */
export function amplitudeNormFractional(bakedOctaves, gain, edge) {
  let sum = 0
  let amp = 1
  for (let i = 0; i < bakedOctaves; i++) {
    const w = (i === bakedOctaves - 1) ? (1 - edge) : 1
    sum += amp * w
    amp *= gain
  }
  return sum > 0 ? 1 / sum : 1
}

/**
 * The wind velocity the baked field drifts at, in world units/sec: `speed` along
 * x and 0.6 × `speed` along z.
 *
 * This is the BASE band's drift. The march's mid and fine detail bands drift at
 * 0.75x and 0.375x of it (cloudsVolume.js's `update`), each through its own
 * `windOffset` call at the scaled speed. A single translating volume cannot
 * carry that inter-band parallax, which is why the baked field has one speed.
 */
export function windVector(speed) {
  return { x: speed, z: speed * 0.6 }
}

/** Accumulated wind translation at `time` seconds: world -> cloud space. */
export function windOffset(speed, time) {
  const w = windVector(speed)
  return { x: w.x * time, z: w.z * time }
}

/**
 * The window's min-corner cell index, snapped to whole cells.
 *
 * Snapping is what makes the rolling buffer possible: the texel grid only ever
 * moves in whole cells, so a shift is a clean re-indexing rather than a
 * resample. The sub-cell remainder is NOT snapped away — it is carried by the
 * sampling coordinate and comes out of the hardware trilinear filter, so the
 * field slides smoothly instead of jittering by a cell.
 */
export function windowOriginCell(centreX, centreZ, extent, resolution) {
  const c = cellSize(extent, resolution)
  return {
    x: Math.floor((centreX - extent / 2) / c),
    z: Math.floor((centreZ - extent / 2) / c),
  }
}

/** Positive-result modulo — GLSL's `mod`, not JS's `%` (which keeps the sign). */
export function wrap(value, n) {
  return ((value % n) + n) % n
}

/**
 * Which cloud-space cell a toroidal texel currently stands for.
 *
 * The volume stores cell index `c` at texel `c mod resolution`, so a texel is
 * reused by infinitely many cells; the one that matters is the single one
 * inside the current window `[origin, origin + resolution)`. This is the
 * mapping the bake shader performs, kept here so it can be proven in JS.
 */
export function cellIndexForTexel(texel, origin, resolution) {
  return origin + wrap(texel - origin, resolution)
}

/** Inverse of `cellIndexForTexel`: which texel holds this cell index. */
export function texelForCellIndex(cellIndex, resolution) {
  return wrap(cellIndex, resolution)
}

/**
 * How much room the window keeps free on each side of the region it holds, as
 * a fraction of the extent. The region may drift this far (with the wind, which
 * carries the whole sky across the window) before the window is moved.
 *
 * Re-anchoring on every whole-cell move would leave the shape volume
 * permanently re-baking and the light volume permanently stale. Measured, flying
 * 8 units/frame over 16-unit cells: per-cell re-anchoring left 30.4 of 32
 * light layers outstanding at all times (cloud opacity wrong by up to 0.13)
 * and 50 re-anchors over 720 units; with a margin, 0 stale layers and 2
 * re-anchors. A full light refresh (one layer per frame, 32 frames) must fit
 * inside the interval between re-anchors.
 */
export const REANCHOR_MARGIN = 0.05

/** World-space centre of the window a given origin describes. */
export function windowCentre(origin, extent, resolution) {
  const c = cellSize(extent, resolution)
  return {
    x: (origin.x + resolution / 2) * c,
    z: (origin.z + resolution / 2) * c,
  }
}

// ─── Window placement ──────────────────────────────────────────────────────
// The window is placed around what is read from the volume, not around the
// camera: the camera march (a wedge in front of the camera), the ground shadow
// (every visible ground point reads the volume at a point offset toward the sun)
// and the light bake (which needs the shape volume further toward the sun). The
// user sets the draw distance; the window's size follows from it.

/** Window size per unit of draw distance: room for the worst-case wedge. */
export const EXTENT_PER_DISTANCE = 1.7
/** Window size floor: room for the terrain plane's shadow footprint. */
export const EXTENT_MIN = 2900
/**
 * How far apart, in cells, the oldest and newest layers of a rolling re-bake may
 * let a feature sit: one cell, the smallest offset the grid can draw.
 */
export const ROLL_MAX_SHIFT_CELLS = 1

/**
 * The most the base frequency may change per frame, as a fraction of itself,
 * for a roll to pass its one-cell test (cloudsVolume.js's _rollStaysInvisible)
 * every time. A roll re-bakes `layers / layersPerFrame` frames' worth of layers,
 * and the layers it has baked so far span that many frames of change. The test
 * allows a relative spread of `ROLL_MAX_SHIFT_CELLS / (sqrt(1/2) * resolution)`
 * (the window's corner is sqrt(1/2) * extent from its centre and a cell is
 * extent / resolution); `margin` keeps the change clear of it.
 */
export function rollStepLimit(resolution, layers, layersPerFrame, margin = 0.7) {
  const frames = Math.ceil(layers / Math.max(layersPerFrame, 1))
  return margin * ROLL_MAX_SHIFT_CELLS / (Math.SQRT1_2 * resolution) / frames
}

/**
 * One frame of the light fade: every layer's weight moves toward its target by
 * at most `rate`. The weight is the share of the layer's first stored copy in
 * what the march reads (1 = only the first, 0 = only the second); the target is
 * the copy the layer's last relight wrote. Returns whether any layer is still
 * moving. Mutates `weights`.
 */
export function stepLitWeights(weights, targets, rate) {
  let moving = false
  for (let i = 0; i < weights.length; i++) {
    const d = targets[i] - weights[i]
    if (d === 0) continue
    weights[i] = Math.abs(d) <= rate ? targets[i] : weights[i] + Math.sign(d) * rate
    if (weights[i] !== targets[i]) moving = true
  }
  return moving
}

/**
 * How far the weather map may drift against the cloud field before the baked
 * light is stale: 1/64 of a map tile (36 units at the default 2300), where the
 * map's bias has moved by well under 0.1 of the coverage threshold.
 */
export function weatherRelightDistance(weatherScale) {
  return weatherScale / 64
}

/** Lowest ground height the cloud shadow can fall on (terrain reaches about -55). */
export const GROUND_MIN_Y = -60

/** The window's horizontal size for a draw distance. */
export function windowExtent(drawDistance) {
  return Math.max(EXTENT_PER_DISTANCE * drawDistance, EXTENT_MIN)
}

/**
 * The largest region (per axis) the window can hold: its extent less the margin
 * on each side, and one cell for the whole-cell snap of the origin.
 */
export function windowCapacity(extent, resolution, margin = REANCHOR_MARGIN) {
  return extent * (1 - 2 * margin) - cellSize(extent, resolution)
}

/**
 * Half the horizontal angle the view cone spans, with the camera pitched. A
 * pitched frustum is widest on its most oblique rays, so the bound is
 * atan(tan(hfov / 2) / cos(|pitch| + vfov / 2)). A frustum that reaches the
 * zenith or nadir (|pitch| + vfov / 2 >= 85 degrees) spans every heading: pi.
 *
 * @param {number} fovDeg   vertical field of view, degrees
 * @param {number} aspect   width / height
 * @param {number} pitch    radians above the horizon (sign ignored)
 */
export function frustumHalfAngle(fovDeg, aspect, pitch) {
  const half = fovDeg * Math.PI / 360
  const tilt = Math.abs(pitch) + half
  if (tilt >= 85 * Math.PI / 180) return Math.PI
  return Math.min(Math.PI, Math.atan(Math.tan(half) * aspect / Math.cos(tilt)))
}

/**
 * Bounding box of a wedge: apex at (x, z), radius `radius`, half-angle `halfAngle`
 * about `heading` (radians, from +x toward +z). A half-angle of pi is a disc.
 */
export function wedgeBox(x, z, heading, halfAngle, radius) {
  const pts = [[x, z]]
  const point = a => pts.push([x + radius * Math.cos(a), z + radius * Math.sin(a)])
  point(heading - halfAngle)
  point(heading + halfAngle)
  // The arc's extremes along the axes, where they fall inside the angle.
  for (let k = 0; k < 4; k++) {
    const axis = k * Math.PI / 2
    let d = (axis - heading) % (2 * Math.PI)
    if (d > Math.PI) d -= 2 * Math.PI
    if (d < -Math.PI) d += 2 * Math.PI
    if (Math.abs(d) <= halfAngle) point(axis)
  }
  const xs = pts.map(p => p[0]), zs = pts.map(p => p[1])
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs) }
}

/** The smallest box holding all of `boxes`. */
function hull(boxes) {
  return {
    minX: Math.min(...boxes.map(b => b.minX)), maxX: Math.max(...boxes.map(b => b.maxX)),
    minZ: Math.min(...boxes.map(b => b.minZ)), maxZ: Math.max(...boxes.map(b => b.maxZ)),
  }
}

const shifted = (b, dx, dz) => ({ minX: b.minX + dx, maxX: b.maxX + dx, minZ: b.minZ + dz, maxZ: b.maxZ + dz })

/**
 * One axis of the region, with the sunward extension limited to the room that
 * is left once the camera wedge is held: the wedge always wins, because it is
 * the clouds the viewer sees.
 */
function clampAxis(wMin, wMax, fMin, fMax, capacity) {
  const slack = Math.max(capacity - (wMax - wMin), 0)
  const lo = wMin - fMin, hi = fMax - wMax          // how far the full region reaches past the wedge
  if (lo + hi <= slack) return [fMin, fMax]
  const k = slack / (lo + hi)
  return [wMin - lo * k, wMax + hi * k]
}

/**
 * The horizontal region of cloud space that is read: the camera wedge, the
 * terrain plane's shadow footprint, and the light bake's reach, each toward the
 * sun, padded by one cell. Everything is in cloud space (world plus wind).
 *
 * @param {object} o
 * @param {{x:number,z:number}} o.cam      camera, cloud space
 * @param {number} o.heading               view heading, radians from +x toward +z
 * @param {number} o.halfAngle             frustumHalfAngle(...)
 * @param {number} o.distance              draw distance (a ray distance bounds the horizontal one)
 * @param {{x:number,z:number,half:number}} o.plane  the terrain plane's centre and half size
 * @param {{x:number,y:number,z:number}} o.sun       the sun vector (horizontal x, z; vertical y)
 * @param {number} o.level                 shell floor height
 * @param {number} o.height                shell thickness
 * @param {number} o.reach                 the light march's path length (steps * step size)
 * @param {number} o.cell                  world units per cell
 * @param {number} o.capacity              windowCapacity(...): the most one axis may span
 * @returns {{minX:number,maxX:number,minZ:number,maxZ:number}}
 */
export function viewRegion(o) {
  const wedge = wedgeBox(o.cam.x, o.cam.z, o.heading, o.halfAngle, o.distance)
  const plane = { minX: o.plane.x - o.plane.half, maxX: o.plane.x + o.plane.half,
                  minZ: o.plane.z - o.plane.half, maxZ: o.plane.z + o.plane.half }
  const horizontal = Math.hypot(o.sun.x, o.sun.z)
  const parts = [wedge, plane]
  if (o.sun.y > 1e-3 && horizontal > 1e-6) {
    const dx = o.sun.x / horizontal, dz = o.sun.z / horizontal
    const perRise = horizontal / o.sun.y                       // horizontal units per unit of rise toward the sun
    const ground = Math.max(o.level - GROUND_MIN_Y, 0) * perRise
    const pad = Math.min(o.reach * horizontal / Math.hypot(o.sun.x, o.sun.y, o.sun.z), o.height * perRise)
    parts.push(shifted(wedge, dx * pad, dz * pad),
               shifted(plane, dx * ground, dz * ground),
               shifted(plane, dx * (ground + pad), dz * (ground + pad)))
  }
  const full = hull(parts)
  const [minX, maxX] = clampAxis(wedge.minX, wedge.maxX, full.minX, full.maxX, o.capacity)
  const [minZ, maxZ] = clampAxis(wedge.minZ, wedge.maxZ, full.minZ, full.maxZ, o.capacity)
  return { minX: minX - o.cell, maxX: maxX + o.cell, minZ: minZ - o.cell, maxZ: maxZ + o.cell }
}

/** Does the window, with its margin kept free on every side, hold the whole box? */
export function windowContains(origin, extent, resolution, box, margin = REANCHOR_MARGIN) {
  const c = cellSize(extent, resolution)
  const minX = origin.x * c + margin * extent, maxX = origin.x * c + extent - margin * extent
  const minZ = origin.z * c + margin * extent, maxZ = origin.z * c + extent - margin * extent
  return box.minX >= minX && box.maxX <= maxX && box.minZ >= minZ && box.maxZ <= maxZ
}

/** The window origin that centres the window on a box. */
export function windowOriginForBox(box, extent, resolution) {
  return windowOriginCell((box.minX + box.maxX) / 2, (box.minZ + box.maxZ) / 2, extent, resolution)
}

/** The low `bits` bits of `i`, in reverse order. */
function reverseBits(i, bits) {
  let r = 0
  for (let b = 0; b < bits; b++) r = (r << 1) | ((i >> b) & 1)
  return r
}

/**
 * The next volume layer due for a re-bake (light and rolling shape), in an
 * interleaved order: for 32 layers 0, 16, 8, 24, 4, 20, ... Every layer comes up
 * once per cycle, and the two neighbours of any layer are always half a cycle
 * apart in age. A bottom-to-top order would sweep one fresh/stale front up
 * through the clouds every cycle, which shows as a band of lighting rolling
 * across the sky; interleaved, the stale layers are spread evenly instead. The
 * order is the bit-reversal of the layer index, which needs a power-of-two
 * layer count; any other count runs bottom to top.
 */
export function nextLightLayer(current, layers) {
  const bits = Math.log2(layers)
  if (!Number.isInteger(bits)) return wrap(current + 1, layers)
  return reverseBits(wrap(reverseBits(current, bits) + 1, layers), bits)
}

// ─── Incremental edge updates ───────────────────────────────────────
// A window shift invalidates only the cells that newly entered it; everything
// still inside holds the same cloud-space cell as before and needs no work.
// These derive exactly which texels that is, so the re-bake can be scissored
// to them instead of sweeping the whole volume.

/**
 * The texel run that newly entered the window along one axis.
 *
 * Returns null when nothing entered, `{start, count}` in texel space
 * otherwise. The run is toroidal — it may wrap past the resolution — because
 * texel index is cell index modulo the resolution.
 */
export function enteringRun(prevOrigin, nextOrigin, resolution) {
  const d = nextOrigin - prevOrigin
  if (d === 0) return null
  // Shifted further than the window is wide: nothing survives, resweep it all.
  if (Math.abs(d) >= resolution) return { start: 0, count: resolution }
  // Moving up, the new cells are the ones past the old far edge; moving down,
  // they are the ones before the new near edge.
  const firstCell = d > 0 ? prevOrigin + resolution : nextOrigin
  return { start: wrap(firstCell, resolution), count: Math.abs(d) }
}

/** Split a toroidal run into 1 or 2 non-wrapping `[start, count]` spans. */
export function splitRun(start, count, resolution) {
  if (count >= resolution) return [[0, resolution]]
  const end = start + count
  return end <= resolution
    ? [[start, count]]
    : [[start, resolution - start], [0, end - resolution]]
}

/** Grow a run by `pad` texels on each side, saturating at a full sweep. */
export function padRun(run, pad, resolution) {
  if (!run) return null
  const count = run.count + 2 * pad
  if (count >= resolution) return { start: 0, count: resolution }
  return { start: wrap(run.start - pad, resolution), count }
}

/**
 * Texel rectangles to re-bake after a window shift: `{x, y, w, h}`, with y/h
 * on the grid's Z axis.
 *
 * At most four — an X band and a Z band, each possibly split once by the wrap.
 * The two bands overlap at the corner, which is re-baked twice; that is a
 * handful of texels and not worth the arithmetic to avoid.
 *
 * `padX`/`padZ` widen the bands for the LIGHT volume, whose invalidation is
 * not the entering cells but everything downsun of them — see lightPad.
 */
export function refreshRects(prev, next, resolution, padX = 0, padZ = 0) {
  const rects = []
  const rx = padRun(enteringRun(prev.x, next.x, resolution), padX, resolution)
  const rz = padRun(enteringRun(prev.z, next.z, resolution), padZ, resolution)
  if (rx) for (const [s, c] of splitRun(rx.start, rx.count, resolution)) {
    rects.push({ x: s, y: 0, w: c, h: resolution })
  }
  if (rz) for (const [s, c] of splitRun(rz.start, rz.count, resolution)) {
    rects.push({ x: 0, y: s, w: resolution, h: c })
  }
  return rects
}

/**
 * How far light invalidation spreads beyond the cells that actually moved.
 *
 * A cell's baked light is the optical depth along its ray TOWARD the sun, so
 * new cells invalidate every cell downsun of them — the entering band swept
 * along -sunDir over the light march's reach. Axis-aligned rectangles cannot
 * express a sheared slab, so each band is widened symmetrically by the sun
 * ray's horizontal travel. That over-covers, and is correct.
 */
export function lightPad(sunDir, reach, cell) {
  const len = Math.hypot(sunDir.x, sunDir.y, sunDir.z) || 1
  return {
    x: Math.ceil((reach * Math.abs(sunDir.x) / len) / cell),
    z: Math.ceil((reach * Math.abs(sunDir.z) / len) / cell),
  }
}

/** Texels the rects touch, counting the corner overlap twice (an upper bound). */
export function rectsArea(rects) {
  return rects.reduce((a, r) => a + r.w * r.h, 0)
}

/**
 * Is a scissored update still worth it, or should the whole volume be swept?
 *
 * Partial updates cost a draw call per rect per layer, so past a certain
 * coverage the draw-call overhead outweighs the fill saved and a single
 * full-viewport draw per layer is simply cheaper.
 */
export function shouldFullRebake(rects, resolution, threshold = 0.5) {
  return rectsArea(rects) >= threshold * resolution * resolution
}

// ─── Analytic high-frequency detail ─────────────────────────────────

/**
 * How many fBM octaves BEYOND the baked ones the per-pixel march can resolve:
 * the continuation of the same series, summed back in analytically.
 *
 * The limit is the march, not the grid: samples along a ray sit
 * `marchStepSize` apart and obey the same Nyquist rule the grid does with its
 * cell size. At a march step equal to the grid cell this returns 0; more
 * detail costs finer steps.
 */
export function detailOctaveCount(baseFreq, lacunarity, bakedOctaves, marchStepSize, hardCap = 4) {
  return safeOctaveCount(
    baseFreq * Math.pow(lacunarity, bakedOctaves), lacunarity, marchStepSize, hardCap)
}

/**
 * Worley's Nyquist limit is feature-point SPACING vs grid cell size, not
 * wavelength (a gradient-noise concept) — a Voronoi seam is a broadband
 * discontinuity with no dominant frequency, so `maxSafeFrequency` does not
 * apply. The relevant quantity instead: one feature point per unit cell of
 * side `1/freq`, and the grid can resolve a feature spacing no finer than 2
 * cells — so `1/freq >= 2*cellSize`, i.e. `freq <= 1/(2*cellSize)`.
 */
export function maxSafeWorleyFreq(cellSize) {
  return 1 / (2 * cellSize)
}

/**
 * How many worleyFbm octaves stay Nyquist-safe on this grid. Each octave
 * doubles frequency (worleyFbm's own fixed 2x/0.5 lacunarity/gain), mirroring
 * safeOctaveCount's structure but against maxSafeWorleyFreq instead.
 */
export function safeWorleyOctaveCount(freq, cellSize, hardCap = 3) {
  const kMax = maxSafeWorleyFreq(cellSize)
  let n = 0
  let k = freq
  while (n < hardCap && k <= kMax) {
    n++
    k *= 2
  }
  return n
}

/** Amplitude the detail series resumes at, continuing the baked geometric run. */
export function detailStartAmp(gain, bakedOctaves) {
  return Math.pow(gain, bakedOctaves)
}

/** Frequency the detail series resumes at. */
export function detailStartFreq(baseFreq, lacunarity, bakedOctaves) {
  return baseFreq * Math.pow(lacunarity, bakedOctaves)
}
