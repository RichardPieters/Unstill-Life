import { describe, test, expect } from 'vitest'
import {
  SNOISE_WAVELENGTH, cellSize, maxSafeFrequency, safeOctaveCount, amplitudeNorm,
  windVector, windOffset, windowOriginCell, wrap,
  cellIndexForTexel, texelForCellIndex, nextLightLayer,
  REANCHOR_MARGIN, windowCentre, windowExtent, windowCapacity, frustumHalfAngle, wedgeBox,
  viewRegion, windowContains, windowOriginForBox, EXTENT_PER_DISTANCE, EXTENT_MIN, GROUND_MIN_Y,
  rollStepLimit, ROLL_MAX_SHIFT_CELLS, stepLitWeights,
  enteringRun, splitRun, padRun, refreshRects, lightPad, rectsArea, shouldFullRebake,
  detailOctaveCount, detailStartAmp, detailStartFreq,
  maxSafeWorleyFreq, safeWorleyOctaveCount,
  octaveEdgeCloseness, amplitudeNormFractional,
} from '../../src/clouds/cloudVolumeMath.js'

describe('grid geometry', () => {
  test('cell size divides the extent across the resolution', () => {
    expect(cellSize(4096, 256)).toBe(16)
    expect(cellSize(8192, 256)).toBe(32)
  })
})

describe('Nyquist limit', () => {
  // Ground truth is the definition, computed here independently of the module:
  // a grid of cell c resolves wavelengths down to 2c, and snoise(p*k) has world
  // wavelength SNOISE_WAVELENGTH/k, so k_max = SNOISE_WAVELENGTH/(2c).
  test('max safe frequency is the wavelength over twice the cell', () => {
    for (const c of [8, 16, 32, 64]) {
      expect(maxSafeFrequency(c)).toBeCloseTo(SNOISE_WAVELENGTH / (2 * c), 12)
    }
  })

  test('a frequency at the limit resolves to exactly two samples per period', () => {
    const c = 16
    const k = maxSafeFrequency(c)
    const worldWavelength = SNOISE_WAVELENGTH / k
    expect(worldWavelength / c).toBeCloseTo(2, 12)
  })

  test('finer cells admit higher frequencies, monotonically', () => {
    const cells = [64, 32, 16, 8]
    const ks = cells.map(maxSafeFrequency)
    for (let i = 1; i < ks.length; i++) expect(ks[i]).toBeGreaterThan(ks[i - 1])
  })

  test('octave count keeps every octave at or below the limit', () => {
    for (const cell of [8, 16, 32, 64]) {
      const n = safeOctaveCount(0.006, 2.0, cell)
      const kMax = maxSafeFrequency(cell)
      // Every octave the count admits is safe...
      for (let i = 0; i < n; i++) expect(0.006 * 2 ** i).toBeLessThanOrEqual(kMax)
      // ...and the next one would not have been.
      expect(0.006 * 2 ** n).toBeGreaterThan(kMax)
    }
  })

  test('a coarser grid never admits more octaves than a finer one', () => {
    const counts = [64, 32, 16, 8].map(c => safeOctaveCount(0.006, 2.0, c))
    for (let i = 1; i < counts.length; i++) {
      expect(counts[i]).toBeGreaterThanOrEqual(counts[i - 1])
    }
  })
})

describe('Worley Nyquist limit', () => {
  // Ground truth: one feature point per unit cell of side 1/freq, and the
  // grid can't resolve a feature spacing finer than 2 cells — freq <= 1/(2c),
  // independently derived here rather than mirroring the module's formula.
  test('max safe worley frequency is one over twice the cell', () => {
    for (const c of [8, 16, 32, 64]) {
      expect(maxSafeWorleyFreq(c)).toBeCloseTo(1 / (2 * c), 12)
    }
  })

  test('octave count keeps every octave (doubling each time) at or below the limit', () => {
    // 0.02 clears cell=8's limit (0.0625) for two octaves and fails the third
    // (0.08 > 0.0625) — a freq/cell pair where the boundary binds before the
    // hard cap, unlike a coarser or finer choice which could saturate at 3
    // regardless (covered by the hard-cap test below).
    for (const cell of [8, 16, 32]) {
      const n = safeWorleyOctaveCount(0.02, cell)
      const kMax = maxSafeWorleyFreq(cell)
      for (let i = 0; i < n; i++) expect(0.02 * 2 ** i).toBeLessThanOrEqual(kMax)
      expect(0.02 * 2 ** n).toBeGreaterThan(kMax)
    }
  })

  test('never exceeds the hard cap regardless of how safe the grid is', () => {
    expect(safeWorleyOctaveCount(1e-6, 8, 3)).toBe(3)
  })

  test('a frequency already past the limit admits zero octaves', () => {
    expect(safeWorleyOctaveCount(1, 8)).toBe(0)
  })

  test('returns 0 rather than pretending when the base octave itself aliases', () => {
    // A 400-unit cell cannot carry a 284-unit wavelength.
    expect(safeOctaveCount(0.006, 2.0, 400)).toBe(0)
  })

  test('honours the hard cap on octave count', () => {
    expect(safeOctaveCount(1e-6, 2.0, 16, 3)).toBe(3)
  })

  // Why the march resumes the series analytically: a fixed fBM series reaches
  // frequencies finer than any practical grid can bake.
  test('the finer octaves of a fixed series cannot survive a bake', () => {
    const octaves = [0.006, 0.012, 0.02, 0.04, 0.08, 0.16]
    const survives = cell => octaves.filter(k => k <= maxSafeFrequency(cell)).length
    expect(survives(16)).toBeLessThan(octaves.length)
    expect(survives(32)).toBeLessThan(survives(16))
  })
})

describe('amplitude normalisation', () => {
  test('is the reciprocal of the geometric amplitude sum', () => {
    expect(amplitudeNorm(3, 0.5)).toBeCloseTo(1 / (1 + 0.5 + 0.25), 12)
    expect(amplitudeNorm(1, 0.5)).toBe(1)
  })

  test('keeps the field amplitude stable as octave count changes', () => {
    // The point of the normalisation: peak |fBM| stays ~1 whatever the
    // resolution admits, so density/coverage sliders do not need retuning.
    for (const n of [1, 2, 3, 4, 6]) {
      let sum = 0
      let amp = 1
      for (let i = 0; i < n; i++) { sum += amp; amp *= 0.5 }
      expect(sum * amplitudeNorm(n, 0.5)).toBeCloseTo(1, 12)
    }
  })

  test('zero octaves does not divide by zero', () => {
    expect(amplitudeNorm(0, 0.5)).toBe(1)
  })
})

describe('wind', () => {
  test('drifts 0.6 as fast along z as along x', () => {
    const w = windVector(7.5)
    expect(w.x).toBe(7.5)
    expect(w.z).toBeCloseTo(7.5 * 0.6, 12)
  })

  test('offset is linear in time', () => {
    const a = windOffset(7.5, 2)
    const b = windOffset(7.5, 4)
    expect(b.x).toBeCloseTo(2 * a.x, 12)
    expect(b.z).toBeCloseTo(2 * a.z, 12)
  })
})

describe('window snapping', () => {
  test('origin is the min-corner cell, floored', () => {
    // extent 4096, res 256 -> cell 16. Centre 0 -> min corner -2048 -> cell -128.
    expect(windowOriginCell(0, 0, 4096, 256)).toEqual({ x: -128, z: -128 })
  })

  test('floors toward negative infinity, not toward zero', () => {
    // A centre just below a boundary must not snap the same way as one above.
    const a = windowOriginCell(-1, 0, 4096, 256)
    const b = windowOriginCell(+1, 0, 4096, 256)
    expect(a.x).toBeLessThanOrEqual(b.x)
    expect(Number.isInteger(a.x)).toBe(true)
  })

  test('origin is stable within a cell and advances by exactly one across it', () => {
    const extent = 4096, res = 256, c = cellSize(extent, res)
    const base = windowOriginCell(0, 0, extent, res)
    expect(windowOriginCell(c * 0.99, 0, extent, res)).toEqual(base)
    expect(windowOriginCell(c * 1.01, 0, extent, res).x).toBe(base.x + 1)
  })

  test('drifting one full extent advances the origin by the resolution', () => {
    const o0 = windowOriginCell(0, 0, 4096, 256)
    const o1 = windowOriginCell(4096, 0, 4096, 256)
    expect(o1.x - o0.x).toBe(256)
    expect(o1.z - o0.z).toBe(0)
  })
})

describe('toroidal indexing', () => {
  test('wrap returns a non-negative result for negative input', () => {
    expect(wrap(-1, 256)).toBe(255)
    expect(wrap(-256, 256)).toBe(0)
    expect(wrap(257, 256)).toBe(1)
  })

  test('every texel maps to exactly one cell inside the window', () => {
    const N = 16
    for (const origin of [0, 5, -3, -100, 1000]) {
      const seen = new Set()
      for (let t = 0; t < N; t++) {
        const c = cellIndexForTexel(t, origin, N)
        expect(c).toBeGreaterThanOrEqual(origin)
        expect(c).toBeLessThan(origin + N)
        seen.add(c)
      }
      expect(seen.size).toBe(N)   // a bijection: no cell covered twice, none missed
    }
  })

  test('texel <-> cell index round-trips', () => {
    const N = 16
    for (const origin of [0, 7, -5]) {
      for (let t = 0; t < N; t++) {
        expect(texelForCellIndex(cellIndexForTexel(t, origin, N), N)).toBe(t)
      }
    }
  })

  /**
   * The load-bearing claim of the whole scheme: the sampler needs no window
   * origin, because `uv = pCloud / extent` under RepeatWrapping already
   * addresses the texel that holds that cell.
   *
   * Checked by two INDEPENDENT routes to the same texel — the storage rule
   * (cell index folded by the wrap) versus the sampling path (cloud-space
   * position -> uv -> wrapped -> texel), which is what the GPU actually does.
   */
  test('uv = pCloud/extent addresses the texel that stores that cell', () => {
    const extent = 4096, N = 256, c = cellSize(extent, N)
    for (const cell of [0, 1, 255, 256, 257, -1, -256, -257, 5000, -5000]) {
      const pCloud = (cell + 0.5) * c                 // cloud-space cell centre
      const uv = pCloud / extent                      // what the shader computes
      const sampled = Math.floor(wrap(uv, 1) * N)     // what RepeatWrapping addresses
      expect(sampled).toBe(texelForCellIndex(cell, N))
    }
  })

  test('the half-texel offsets cancel — a cell centre lands mid-texel', () => {
    const extent = 4096, N = 256, c = cellSize(extent, N)
    for (const cell of [0, 3, -3, 300]) {
      const uv = ((cell + 0.5) * c) / extent
      const withinTexel = wrap(uv, 1) * N - Math.floor(wrap(uv, 1) * N)
      expect(withinTexel).toBeCloseTo(0.5, 10)
    }
  })
})

describe('window placement', () => {
  const RES = 256
  const SUN = { x: 0.585, y: 0.45, z: -0.26 }          // the shipped sun
  const view = (over = {}) => {
    const extent = windowExtent(1800)
    return {
      cam: { x: 0, z: 741 }, heading: -Math.PI / 2, halfAngle: frustumHalfAngle(45, 16 / 9, 0.17),
      distance: 1800, plane: { x: 0, z: 0, half: 750 }, sun: SUN, level: 80, height: 140, reach: 408,
      cell: cellSize(extent, RES), capacity: windowCapacity(extent, RES), ...over,
    }
  }
  const inside = (box, x, z) => x >= box.minX && x <= box.maxX && z >= box.minZ && z <= box.maxZ

  test('the extent follows the draw distance, with a floor for the terrain plane', () => {
    expect(windowExtent(1800)).toBe(EXTENT_PER_DISTANCE * 1800)
    expect(windowExtent(3600)).toBe(EXTENT_PER_DISTANCE * 3600)
    expect(windowExtent(1000)).toBe(EXTENT_MIN)
    expect(windowCapacity(3000, RES)).toBeLessThan(3000)
  })

  test('the view cone widens with pitch and spans every heading at the zenith', () => {
    // Level, the cone is wider than the horizontal field of view: the rays at the
    // top and bottom edges are oblique and sweep more azimuth.
    const level = frustumHalfAngle(45, 16 / 9, 0)
    const tanH = Math.tan(22.5 * Math.PI / 180) * 16 / 9
    expect(level).toBeCloseTo(Math.atan(tanH / Math.cos(22.5 * Math.PI / 180)), 12)
    expect(level).toBeGreaterThan(Math.atan(tanH))
    expect(frustumHalfAngle(45, 16 / 9, 0.3)).toBeGreaterThan(level)
    expect(frustumHalfAngle(45, 16 / 9, -0.3)).toBe(frustumHalfAngle(45, 16 / 9, 0.3))
    expect(frustumHalfAngle(45, 16 / 9, 80 * Math.PI / 180)).toBe(Math.PI)
  })

  test('a wedge box holds every point of the wedge, at any heading', () => {
    for (const heading of [0, 0.7, Math.PI / 2, 2.4, Math.PI, -2, -Math.PI / 2]) {
      const half = 0.7, r = 1000, x = 30, z = -40
      const box = wedgeBox(x, z, heading, half, r)
      for (let i = 0; i <= 40; i++) for (let j = 0; j <= 10; j++) {
        const a = heading - half + 2 * half * i / 40, d = r * j / 10
        expect(inside({ minX: box.minX - 1e-9, maxX: box.maxX + 1e-9, minZ: box.minZ - 1e-9, maxZ: box.maxZ + 1e-9 },
          x + d * Math.cos(a), z + d * Math.sin(a))).toBe(true)
      }
    }
    const disc = wedgeBox(10, 20, 1, Math.PI, 500)
    expect(disc).toEqual({ minX: -490, maxX: 510, minZ: -480, maxZ: 520 })
  })

  test('the region holds the view cone and the shadow footprints, found by sampling the reads', () => {
    const o = view()
    const box = viewRegion(o)
    // Camera march: points inside the cone, within the draw distance.
    for (let i = 0; i <= 30; i++) for (let j = 1; j <= 10; j++) {
      const a = o.heading - o.halfAngle + 2 * o.halfAngle * i / 30, d = o.distance * j / 10
      expect(inside(box, o.cam.x + d * Math.cos(a), o.cam.z + d * Math.sin(a))).toBe(true)
    }
    // Ground shadow: the shader reads at p + sun * (rise / sun.y), rise = level - ground height.
    for (const gy of [GROUND_MIN_Y, 0, 55]) for (const px of [-750, 0, 750]) for (const pz of [-750, 0, 750]) {
      const rise = o.level - gy
      expect(inside(box, px + SUN.x * rise / SUN.y, pz + SUN.z * rise / SUN.y), `${px},${pz},${gy}`).toBe(true)
    }
  })

  test('the box fits the window at the shipped camera and sun, margin kept', () => {
    const o = view()
    const box = viewRegion(o)
    const extent = windowExtent(1800)
    const origin = windowOriginForBox(box, extent, RES)
    expect(windowContains(origin, extent, RES, box)).toBe(true)
  })

  test('the wedge wins when the window is too small for the sun footprint', () => {
    const grazing = { x: 0.64, y: 0.05, z: 0 }
    const o = view({ sun: grazing })
    const box = viewRegion(o)
    const wedge = wedgeBox(o.cam.x, o.cam.z, o.heading, o.halfAngle, o.distance)
    expect(box.minX).toBeLessThanOrEqual(wedge.minX)
    expect(box.maxX).toBeGreaterThanOrEqual(wedge.maxX)
    expect(box.minZ).toBeLessThanOrEqual(wedge.minZ)
    expect(box.maxZ).toBeGreaterThanOrEqual(wedge.maxZ)
    // The sun's extension takes only the room the wedge leaves.
    const span = box.maxX - box.minX - 2 * o.cell
    expect(span).toBeLessThanOrEqual(Math.max(o.capacity, wedge.maxX - wedge.minX) + 1e-6)
  })

  test('windowContains keeps the margin free; the origin for a box is stable', () => {
    const extent = 3000
    const box = { minX: -1000, maxX: 1000, minZ: -1000, maxZ: 1000 }
    const origin = windowOriginForBox(box, extent, RES)
    expect(windowOriginForBox(box, extent, RES)).toEqual(origin)
    expect(windowContains(origin, extent, RES, box)).toBe(true)
    const near = REANCHOR_MARGIN * extent
    const edge = { ...box, maxX: origin.x * cellSize(extent, RES) + extent - near + 1 }
    expect(windowContains(origin, extent, RES, edge)).toBe(false)
  })

  test('window centre is half an extent past the origin corner', () => {
    const origin = windowOriginCell(0, 0, 4096, RES)
    const c = windowCentre(origin, 4096, RES)
    expect(c.x).toBeCloseTo(0, 6)
    expect(c.z).toBeCloseTo(0, 6)
  })
})

describe('roll step limit', () => {
  test('a roll that spans its frames of change stays within the one-cell spread', () => {
    for (const perFrame of [1, 2, 4, 8, 32]) {
      const frames = Math.ceil(32 / perFrame)
      const spread = rollStepLimit(256, 32, perFrame) * frames
      // _rollStaysInvisible: corner (sqrt(1/2) * extent) * spread < one cell (extent / resolution)
      expect(spread, `${perFrame} layers per frame`).toBeLessThan(ROLL_MAX_SHIFT_CELLS / (Math.SQRT1_2 * 256))
    }
  })

  test('more layers per frame allow a faster change', () => {
    expect(rollStepLimit(256, 32, 8)).toBeGreaterThan(rollStepLimit(256, 32, 4))
    expect(rollStepLimit(256, 32, 4)).toBeGreaterThan(rollStepLimit(256, 32, 1))
  })
})

describe('light pass amortisation', () => {
  test('every layer comes up once per cycle', () => {
    const layers = 32
    const seen = new Set()
    let l = 0
    for (let i = 0; i < layers; i++) { seen.add(l); l = nextLightLayer(l, layers) }
    expect(seen.size).toBe(layers)
    expect(l).toBe(0)   // back to the start after exactly one cycle
  })

  test('the order is interleaved: the neighbours of a layer are half a cycle apart', () => {
    const layers = 32
    const order = []
    let l = 0
    for (let i = 0; i < layers; i++) { order.push(l); l = nextLightLayer(l, layers) }
    // 0, 16, 8, 24, 4, ... so no fresh/stale front sweeps up the volume.
    expect(order.slice(0, 6)).toEqual([0, 16, 8, 24, 4, 20])
    const at = []
    order.forEach((layer, i) => { at[layer] = i })
    for (let k = 0; k + 1 < layers; k += 2) {
      expect(Math.abs(at[k] - at[k + 1]), `layers ${k} and ${k + 1}`).toBe(layers / 2)
    }
  })

  test('a layer count that is not a power of two runs bottom to top', () => {
    expect(nextLightLayer(0, 24)).toBe(1)
    expect(nextLightLayer(23, 24)).toBe(0)
  })
})

describe('incremental edge updates', () => {
  const N = 16

  test('nothing entered when the window did not move', () => {
    expect(enteringRun(5, 5, N)).toBeNull()
    expect(refreshRects({ x: 5, z: 5 }, { x: 5, z: 5 }, N)).toEqual([])
  })

  test('a one-cell move brings in exactly one column', () => {
    expect(enteringRun(0, 1, N)).toEqual({ start: wrap(N, N), count: 1 })
    expect(enteringRun(0, -1, N)).toEqual({ start: wrap(-1, N), count: 1 })
  })

  test('a move at or past the resolution resweeps everything', () => {
    expect(enteringRun(0, N, N)).toEqual({ start: 0, count: N })
    expect(enteringRun(0, -N - 3, N)).toEqual({ start: 0, count: N })
  })

  test('splitRun splits exactly at the wrap and nowhere else', () => {
    expect(splitRun(2, 3, N)).toEqual([[2, 3]])
    expect(splitRun(14, 4, N)).toEqual([[14, 2], [0, 2]])
    expect(splitRun(0, N, N)).toEqual([[0, N]])
  })

  test('padRun widens both sides and saturates at a full sweep', () => {
    expect(padRun({ start: 5, count: 2 }, 1, N)).toEqual({ start: 4, count: 4 })
    expect(padRun({ start: 0, count: 2 }, 1, N)).toEqual({ start: N - 1, count: 4 })
    expect(padRun({ start: 5, count: 2 }, N, N)).toEqual({ start: 0, count: N })
    expect(padRun(null, 3, N)).toBeNull()
  })

  /**
   * THE correctness property, and the reason stage 2 is safe to build on stage
   * 1: a texel the rects do NOT cover must still stand for the same cloud-space
   * cell after the shift as before it, so leaving its baked value alone is
   * right. Ground truth is cellIndexForTexel — the storage rule itself — not a
   * restatement of refreshRects's own arithmetic.
   */
  test('every texel outside the rects still holds the same cell', () => {
    const covered = (rects, tx, tz) => rects.some(r =>
      tx >= r.x && tx < r.x + r.w && tz >= r.y && tz < r.y + r.h)

    for (const [dx, dz] of [[1, 0], [0, 1], [3, 2], [-1, 0], [0, -4], [-2, -3], [7, -5], [0, 0]]) {
      const prev = { x: 100, z: -37 }
      const next = { x: prev.x + dx, z: prev.z + dz }
      const rects = refreshRects(prev, next, N)
      let checkedUncovered = 0
      for (let tx = 0; tx < N; tx++) {
        for (let tz = 0; tz < N; tz++) {
          const sameX = cellIndexForTexel(tx, prev.x, N) === cellIndexForTexel(tx, next.x, N)
          const sameZ = cellIndexForTexel(tz, prev.z, N) === cellIndexForTexel(tz, next.z, N)
          if (!covered(rects, tx, tz)) {
            expect(sameX && sameZ,
              `texel ${tx},${tz} changed cell but was not scheduled for a re-bake (shift ${dx},${dz})`).toBe(true)
            checkedUncovered++
          }
        }
      }
      // The test would be vacuous if the rects simply covered everything.
      if (dx !== 0 || dz !== 0) expect(checkedUncovered).toBeGreaterThan(0)
    }
  })

  test('and it covers no more than it has to for a small shift', () => {
    const rects = refreshRects({ x: 0, z: 0 }, { x: 1, z: 0 }, N)
    expect(rectsArea(rects)).toBe(N)          // one column, full depth
  })

  test('a diagonal shift is two bands, overlapping only at the corner', () => {
    const rects = refreshRects({ x: 0, z: 0 }, { x: 2, z: 3 }, N)
    expect(rectsArea(rects)).toBe(2 * N + 3 * N)   // corner counted twice
  })

  test('light padding follows the sun ray\'s horizontal travel', () => {
    // Straight overhead: the ray never leaves the column, so nothing extra.
    expect(lightPad({ x: 0, y: 1, z: 0 }, 480, 16)).toEqual({ x: 0, z: 0 })
    // Low sun reaches much further sideways than a high one.
    const low  = lightPad({ x: 0.9, y: 0.1, z: 0 }, 480, 16)
    const high = lightPad({ x: 0.1, y: 0.9, z: 0 }, 480, 16)
    expect(low.x).toBeGreaterThan(high.x)
  })

  test('light rects are wider than shape rects for the same shift', () => {
    const prev = { x: 0, z: 0 }, next = { x: 1, z: 0 }
    const shape = refreshRects(prev, next, N)
    const light = refreshRects(prev, next, N, 3, 3)
    expect(rectsArea(light)).toBeGreaterThan(rectsArea(shape))
  })

  test('a big shift falls back to a full sweep rather than many rects', () => {
    const rects = refreshRects({ x: 0, z: 0 }, { x: N / 2 + 1, z: 0 }, N)
    expect(shouldFullRebake(rects, N)).toBe(true)
    expect(shouldFullRebake(refreshRects({ x: 0, z: 0 }, { x: 1, z: 0 }, N), N)).toBe(false)
  })
})

describe('analytic detail octaves', () => {
  const BASE = 0.006, LAC = 2.0, GAIN = 0.5, BAKED = 4

  test('detail resumes exactly where the bake stopped', () => {
    expect(detailStartFreq(BASE, LAC, BAKED)).toBeCloseTo(BASE * 2 ** BAKED, 12)
    expect(detailStartAmp(GAIN, BAKED)).toBeCloseTo(GAIN ** BAKED, 12)
  })

  /**
   * The claim that makes stage 3 worth anything: marching at the grid's own
   * cell size can add NO detail, because the march samples no more finely than
   * the grid already stores. Detail has to be bought with march steps.
   */
  test('no detail is available while the march step equals the grid cell', () => {
    const cell = cellSize(4096, 256)                    // 16 u
    expect(detailOctaveCount(BASE, LAC, BAKED, cell)).toBe(0)
  })

  test('halving the march step buys octaves, monotonically', () => {
    const counts = [16, 8, 4, 2].map(step => detailOctaveCount(BASE, LAC, BAKED, step))
    for (let i = 1; i < counts.length; i++) {
      expect(counts[i]).toBeGreaterThanOrEqual(counts[i - 1])
    }
    expect(counts[counts.length - 1]).toBeGreaterThan(counts[0])
  })

  test('every detail octave it admits is resolvable by the march', () => {
    for (const step of [8, 4, 2]) {
      const n = detailOctaveCount(BASE, LAC, BAKED, step)
      const kMax = maxSafeFrequency(step)
      for (let i = 0; i < n; i++) {
        expect(detailStartFreq(BASE, LAC, BAKED) * LAC ** i).toBeLessThanOrEqual(kMax)
      }
    }
  })

  test('detail octaves never duplicate a baked one', () => {
    const bakedTop = BASE * LAC ** (BAKED - 1)
    expect(detailStartFreq(BASE, LAC, BAKED)).toBeGreaterThan(bakedTop)
  })

  test('honours its hard cap', () => {
    expect(detailOctaveCount(BASE, LAC, BAKED, 0.001, 2)).toBe(2)
  })
})

describe('octaveEdgeCloseness — the boundary-octave crossfade weight', () => {
  const kMax = 0.05

  test('0 well inside the safe interior (below edgeStart), 1 at or past kMax', () => {
    expect(octaveEdgeCloseness(kMax * 0.3, kMax)).toBe(0)
    expect(octaveEdgeCloseness(kMax * 0.5, kMax)).toBe(0)
    expect(octaveEdgeCloseness(kMax, kMax)).toBe(1)
    expect(octaveEdgeCloseness(kMax * 1.5, kMax)).toBe(1)
  })

  test('monotonically non-decreasing across the ramp', () => {
    let prev = -Infinity
    for (let f = 0; f <= kMax * 1.2; f += kMax / 40) {
      const w = octaveEdgeCloseness(f, kMax)
      expect(w).toBeGreaterThanOrEqual(prev)
      prev = w
    }
  })

  test('degenerate inputs fall back to fully-faded rather than NaN/negative', () => {
    expect(octaveEdgeCloseness(0.01, 0)).toBe(1)
    expect(octaveEdgeCloseness(-1, kMax)).toBe(1)
  })
})

describe('amplitudeNormFractional — continuous octave-count renormalisation', () => {
  test('reduces to amplitudeNorm(n, gain) at edge=0', () => {
    for (const n of [1, 2, 3, 5]) {
      expect(amplitudeNormFractional(n, 0.5, 0)).toBeCloseTo(amplitudeNorm(n, 0.5), 12)
    }
  })

  test('reduces to amplitudeNorm(n-1, gain) at edge=1 — the exact value the SMALLER octave count computes, matching it at the moment safeOctaveCount would actually drop', () => {
    for (const n of [2, 3, 5]) {
      expect(amplitudeNormFractional(n, 0.5, 1)).toBeCloseTo(amplitudeNorm(n - 1, 0.5), 12)
    }
  })

  test('continuous in edge for a fixed octave count', () => {
    const vals = []
    for (let e = 0; e <= 1; e += 0.1) vals.push(amplitudeNormFractional(4, 0.5, e))
    for (let i = 1; i < vals.length; i++) {
      expect(Math.abs(vals[i] - vals[i - 1])).toBeLessThan(0.1)
    }
  })
})

/**
 * The actual regression this pair exists to fix: crossing the octave-count
 * boundary must not change a FIXED octave's total represented amplitude,
 * wherever it ends up rendered (partly baked + a crossfade supplement, vs.
 * fully marched as the regular first detail term). Reproduces the exact
 * measured defect (scatter dial position 0.32 -> 0.33, baked octaves 4 -> 3)
 * against the pure functions directly, no GPU/browser needed.
 */
describe('the boundary-octave crossfade removes the discontinuity end to end', () => {
  const CELL = 16
  const LAC = 2.0
  const GAIN = 0.5
  const kMax = maxSafeFrequency(CELL)

  function octave3Amplitude(baseFreq) {
    const octaves = Math.max(1, safeOctaveCount(baseFreq, LAC, CELL))
    const lastFreq = baseFreq * Math.pow(LAC, Math.max(0, octaves - 1))
    const edge = octaveEdgeCloseness(lastFreq, kMax)
    const ampNorm = amplitudeNormFractional(octaves, GAIN, edge)
    const boundaryAmp = Math.pow(GAIN, Math.max(0, octaves - 1)) * ampNorm * edge

    if (octaves > 4) return ampNorm * Math.pow(GAIN, 3)                     // plainly baked
    if (octaves === 4) return ampNorm * Math.pow(GAIN, 3) * (1 - edge) + boundaryAmp // crossfading
    if (octaves === 3) return detailStartAmp(GAIN, octaves) * ampNorm       // regular first marched term
    return null
  }

  test('no large jump anywhere across the measured transition (0.0060 baseFreq window)', () => {
    let maxStep = 0
    let prev = null
    for (let f = 0.0060; f <= 0.0070; f += 0.00002) {
      const a = octave3Amplitude(f)
      if (a != null && prev != null) maxStep = Math.max(maxStep, Math.abs(a - prev))
      prev = a
    }
    // Before this fix, the SAME scan showed a step of ~0.0357 (0.0333 -> 0.0714,
    // the measured live-uniform jump) at the exact octave-count boundary. A
    // scan this fine crossing that same boundary must now stay far below it.
    expect(maxStep).toBeLessThan(0.001)
  })

  test('reproduces the exact reported case: scatter 0.32 vs 0.33 no longer differ discontinuously', () => {
    const freqAt = pos => 0.005 + 0.005 * pos
    const a32 = octave3Amplitude(freqAt(0.32))
    const a33 = octave3Amplitude(freqAt(0.33))
    expect(Math.abs(a33 - a32)).toBeLessThan(0.001)
  })
})

describe('stepLitWeights', () => {
  test('moves a weight toward its target by the rate and lands on it', () => {
    const w = Float32Array.from([1, 1]), t = Float32Array.from([0, 1])
    expect(stepLitWeights(w, t, 0.25)).toBe(true)
    expect(w[0]).toBeCloseTo(0.75)
    expect(w[1]).toBe(1)
    for (let i = 0; i < 3; i++) stepLitWeights(w, t, 0.25)
    expect(w[0]).toBe(0)
    expect(stepLitWeights(w, t, 0.25)).toBe(false)
  })

  test('a fade of rate 1/32 settles in 32 steps, one relight cycle', () => {
    const w = Float32Array.from([0]), t = Float32Array.from([1])
    let steps = 0
    while (stepLitWeights(w, t, 1 / 32)) steps++
    expect(steps + 1).toBe(32)
  })
})
