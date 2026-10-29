import { describe, it, expect } from 'vitest'
import {
  coverageFloor, reliefScale, RELIEF_REF_CELL, sigmaForMipLevel, jfaSteps, prepassSize,
  darkestCell, revealPhase, groundBeatProgress, exitFade,
  strokeRedraw, latticeTableSize, dirtyBlocks,
  inFrameBirths, shareAtOrBelow, evenPaced, shareGone, LATTICE_TABLE_ORIGIN,
} from '../../src/artpass/artPassMath.js'

/**
 * Ground truth here is the GEOMETRY, never a restatement of the formula. A test
 * that re-implements the thing it tests drifts in lockstep with it and proves
 * nothing.
 */
describe('coverageFloor', () => {
  // At zero jitter every mark sits at its cell centre, so the farthest a pixel
  // can be from one is the half-diagonal of the cell.
  it('is the cell half-diagonal when nothing jitters', () => {
    expect(coverageFloor(0)).toBeCloseTo(Math.hypot(0.5, 0.5), 12)
  })

  // At full jitter a mark may sit up to half a cell from its centre along EACH
  // axis, so the worst-placed neighbour of a corner sits at (1, 1) cells
  // diagonally — the full cell diagonal, not the half-diagonal plus a half.
  it('is the full cell diagonal at full jitter', () => {
    expect(coverageFloor(1)).toBeCloseTo(Math.hypot(1, 1), 12)
  })

  // The failure this guards: treating the diagonal displacement as if it were
  // axis-aligned gives sqrt(2)/2 + j/2, which agrees at j=0 and understates by
  // 20% at j=1 — so it looks right exactly where it is never checked.
  it('exceeds the axis-aligned form wherever there is any jitter', () => {
    expect(coverageFloor(0.96)).toBeGreaterThan(Math.SQRT2 / 2 + 0.96 / 2)
    expect(coverageFloor(0)).toBeCloseTo(Math.SQRT2 / 2, 12)
  })

  it('grows with jitter', () => {
    expect(coverageFloor(0.5)).toBeGreaterThan(coverageFloor(0.25))
  })
})

/**
 * Relief height has to track mark size, or changing how big the marks are
 * silently changes how thick the paint looks — two axes on one slider.
 *
 * The anchors are tuned by eye (0.35 at cell 3, 1.35 at cell 26) and the
 * exponent is derived from them, so what is assertable is that the curve still
 * passes through both, and that it is SUBLINEAR. Sublinearity is the part with
 * a mechanism behind it: |grad h| goes as H/R, which alone would demand a
 * linear law, but the Sobel radius is fixed in pixels and so under-reads the
 * slope of a small mark.
 */
describe('reliefScale', () => {
  it('is 1 at the reference mark size', () => {
    expect(reliefScale(RELIEF_REF_CELL)).toBeCloseTo(1, 12)
  })

  it('passes through both tuned anchors', () => {
    const atRef = 0.35
    expect(atRef * reliefScale(3)).toBeCloseTo(0.35, 10)
    expect(atRef * reliefScale(26)).toBeCloseTo(1.35, 10)
  })

  it('grows with mark size', () => {
    expect(reliefScale(26)).toBeGreaterThan(reliefScale(12))
    expect(reliefScale(12)).toBeGreaterThan(reliefScale(3))
  })

  // Linear would put cell 26 at 26/3 = 8.67x the reference. It sits well below
  // that and above the square-root law, which is the band the fixed-radius
  // Sobel argument predicts.
  it('is sublinear in mark size but faster than a square root', () => {
    const r = reliefScale(26)
    expect(r).toBeLessThan(26 / RELIEF_REF_CELL)
    expect(r).toBeGreaterThan(Math.sqrt(26 / RELIEF_REF_CELL))
  })

  it('does not blow up at a degenerate mark size', () => {
    expect(Number.isFinite(reliefScale(0))).toBe(true)
    expect(reliefScale(0)).toBeGreaterThan(0)
  })
})

/**
 * The ground-blur slider names a MIP LEVEL, and the gather has to reproduce what
 * a mip fetch of that level actually did or the same number means two different
 * blurs before and after the change.
 *
 * Ground truth is the variance of a box filter, derived independently: a box of
 * width w has variance w^2/12, and level L is approximately a box of width 2^L.
 */
describe('sigmaForMipLevel', () => {
  it('matches the variance of the box filter a mip level approximates', () => {
    for (const level of [0, 1, 3, 4.8, 9]) {
      const boxWidth = Math.pow(2, level)
      const boxVariance = (boxWidth * boxWidth) / 12
      expect(sigmaForMipLevel(level) ** 2).toBeCloseTo(boxVariance, 10)
    }
  })

  // Reading the slider as a RADIUS instead is the bug this replaced: it blurs
  // 1.8x wider than the mip chain at the same setting.
  it('is far narrower than reading the level as a radius', () => {
    expect(sigmaForMipLevel(4.8)).toBeLessThan(Math.pow(2, 4.8) / 2)
  })

  it('doubles per level, as a box of twice the width must', () => {
    expect(sigmaForMipLevel(5) / sigmaForMipLevel(4)).toBeCloseTo(2, 10)
  })
})

/**
 * The jump flood's whole claim is that it covers the frame in O(log N) passes.
 * The property that makes that true is that the FIRST step reaches at least
 * half the larger axis — a seed can then cross the frame in one hop — and that
 * the steps halve down to 1 so no gap is left unsearched.
 */
describe('jfaSteps', () => {
  it('starts at or above half the larger axis', () => {
    for (const [w, h] of [[1280, 720], [640, 360], [900, 1600]]) {
      expect(jfaSteps(w, h)[0]).toBeGreaterThanOrEqual(Math.max(w, h) / 2)
    }
  })

  it('halves down to exactly 1', () => {
    const steps = jfaSteps(1280, 720)
    expect(steps[steps.length - 1]).toBe(1)
    for (let i = 1; i < steps.length; i++) expect(steps[i]).toBe(steps[i - 1] / 2)
  })

  it('is logarithmic in the frame size, not linear', () => {
    expect(jfaSteps(1280, 720).length).toBe(11)
    // Four times the pixels costs two more passes, not four times as many.
    expect(jfaSteps(2560, 1440).length).toBe(jfaSteps(1280, 720).length + 1)
  })

  it('terminates on a degenerate size rather than looping forever', () => {
    expect(jfaSteps(1, 1).length).toBeGreaterThan(0)
    expect(jfaSteps(0, 0).length).toBeGreaterThan(0)
  })
})

/**
 * A zero-sized prepass target is not merely wrong-looking: a framebuffer with a
 * zero dimension fails completeness, which takes down the whole pass.
 */
describe('prepassSize', () => {
  it('scales both axes', () => {
    expect(prepassSize(1280, 720, 0.5)).toEqual({ width: 640, height: 360 })
  })

  it('never returns a zero dimension', () => {
    for (const s of [0.25, 0.05, 0, -1]) {
      const p = prepassSize(4, 2, s)
      expect(p.width).toBeGreaterThanOrEqual(1)
      expect(p.height).toBeGreaterThanOrEqual(1)
    }
  })

  it('never exceeds full resolution', () => {
    expect(prepassSize(1280, 720, 4)).toEqual({ width: 1280, height: 720 })
  })
})

/**
 * Where the reveal's growth starts (artGrowthPick.frag reduces the frame, this
 * picks the winner). Ground truth is a hand-built grid whose darkest cell is
 * known by construction, never a second luminance formula.
 */
describe('darkestCell', () => {
  // A w x h grid from a list of [r,g,b] triples, row 0 first.
  const grid = (w, h, cells) => {
    const buf = new Uint8Array(w * h * 4)
    cells.forEach((c, i) => { buf.set([c[0], c[1], c[2], 255], i * 4) })
    return { buf, w, h }
  }

  it('returns the centre of the one dark cell in a light field', () => {
    const light = [200, 200, 200]
    const cells = Array.from({ length: 9 }, () => light)
    cells[5] = [10, 10, 10]          // x = 2, y = 1 of a 3x3
    const g = grid(3, 3, cells)
    const { u, v } = darkestCell(g.buf, g.w, g.h)
    expect(u).toBeCloseTo(2.5 / 3)
    expect(v).toBeCloseTo(1.5 / 3)
  })

  it('judges by VALUE, not by channel total — a saturated colour is not a dark', () => {
    // Pure green totals 255 across its channels, the same as a dark grey at 85
    // each, but green is far the lighter of the two to look at.
    const g = grid(2, 1, [[0, 255, 0], [85, 85, 85]])
    const { u } = darkestCell(g.buf, g.w, g.h)
    expect(u).toBeCloseTo(1.5 / 2)   // the grey, cell 1
  })

  it('always lands strictly inside the grid, never on its edge', () => {
    const g = grid(2, 2, [[0, 0, 0], [1, 1, 1], [2, 2, 2], [3, 3, 3]])
    const { u, v } = darkestCell(g.buf, g.w, g.h)
    expect(u).toBeGreaterThan(0)
    expect(u).toBeLessThan(1)
    expect(v).toBeGreaterThan(0)
    expect(v).toBeLessThan(1)
  })

  it('is deterministic on a flat frame rather than depending on scan order', () => {
    const flat = Array.from({ length: 4 }, () => [128, 128, 128])
    const g = grid(2, 2, flat)
    expect(darkestCell(g.buf, g.w, g.h)).toEqual(darkestCell(g.buf, g.w, g.h))
  })
})

describe('revealPhase', () => {
  it('is priming until the prime duration is up, and only then spawning', () => {
    // Two sequential steps, not one curve: not a single mark may spawn before
    // the canvas has finished arriving.
    expect(revealPhase(0.5, 2, 10).priming).toBe(true)
    expect(revealPhase(1.999, 2, 10).priming).toBe(true)
    expect(revealPhase(2.001, 2, 10).priming).toBe(false)
  })

  it('primes from nothing to fully arrived across its own duration', () => {
    expect(revealPhase(0, 2, 10).primeProgress).toBe(0)
    // Eased, so the midpoint is not the linear half — only bounded and rising.
    const mid = revealPhase(1, 2, 10).primeProgress
    expect(mid).toBeGreaterThan(0)
    expect(mid).toBeLessThan(1)
    expect(revealPhase(2, 2, 10).primeProgress).toBe(1)
  })

  it('measures spawn progress from the END of priming, not from the start', () => {
    // Independent arithmetic: 5s into a 10s reveal that began after a 2s prime
    // is the 7s mark, and must read as exactly half painted.
    expect(revealPhase(7, 2, 10).progress).toBeCloseTo(0.5, 9)
  })

  it('saturates at 1 and never overshoots, however long it runs', () => {
    expect(revealPhase(12, 2, 10).progress).toBe(1)
    expect(revealPhase(1e6, 2, 10).progress).toBe(1)
  })

  it('a zero duration eases instantly instead of dividing by zero', () => {
    for (const r of [revealPhase(0, 0, 0), revealPhase(1, 0, 0)]) {
      expect(Number.isFinite(r.progress)).toBe(true)
      expect(r.progress).toBeGreaterThanOrEqual(0)
      expect(r.progress).toBeLessThanOrEqual(1)
    }
  })
})

describe('groundBeatProgress', () => {
  it('underpaint-first finishes the ground inside its own beat, ahead of the marks', () => {
    // Beat 0.25 means done a quarter of the way through, while marks keep coming.
    expect(groundBeatProgress(0.125, 0.25, true)).toBeCloseTo(0.5, 9)
    expect(groundBeatProgress(0.25, 0.25, true)).toBe(1)
    expect(groundBeatProgress(0.9, 0.25, true)).toBe(1)
  })

  it('ground-last holds at the live frame until the closing beat', () => {
    // The mirror image: nothing happens until the last quarter begins.
    expect(groundBeatProgress(0.5, 0.25, false)).toBe(0)
    expect(groundBeatProgress(0.75, 0.25, false)).toBe(0)
    expect(groundBeatProgress(0.875, 0.25, false)).toBeCloseTo(0.5, 9)
    expect(groundBeatProgress(1, 0.25, false)).toBe(1)
  })

  it('both directions end settled and stay in range throughout', () => {
    for (const first of [true, false]) {
      for (let p = 0; p <= 1.0001; p += 0.05) {
        const g = groundBeatProgress(p, 0.25, first)
        expect(g).toBeGreaterThanOrEqual(0)
        expect(g).toBeLessThanOrEqual(1)
      }
      expect(groundBeatProgress(1, 0.25, first)).toBe(1)
    }
  })
})

describe('exitFade', () => {
  it('the random rule fades the canvas in direct step with the strokes', () => {
    expect(exitFade(0, { random: true, sweep: 0.2 })).toBe(1)
    expect(exitFade(0.5, { random: true, sweep: 0.2 })).toBeCloseTo(0.5, 9)
    expect(exitFade(1, { random: true, sweep: 0.2 })).toBe(0)
  })

  it('the drift rule holds the canvas until its closing sweep', () => {
    // Outside the sweep window the canvas is untouched; the strokes leave alone.
    expect(exitFade(0.5, { random: false, sweep: 0.2 })).toBe(1)
    expect(exitFade(0.8, { random: false, sweep: 0.2 })).toBe(1)
    expect(exitFade(0.9, { random: false, sweep: 0.2 })).toBeLessThan(1)
  })

  it('both rules end empty — the picture is guaranteed gone at progress 1', () => {
    expect(exitFade(1, { random: false, sweep: 0.2 })).toBe(0)
    expect(exitFade(1, { random: true, sweep: 0.2 })).toBe(0)
  })

  it('never leaves the canvas more present than it started', () => {
    for (const random of [true, false]) {
      let prev = Infinity
      for (let p = 0; p <= 1.0001; p += 0.05) {
        const f = exitFade(p, { random, sweep: 0.2 })
        expect(f).toBeLessThanOrEqual(prev + 1e-9)   // monotonically leaving
        expect(f).toBeGreaterThanOrEqual(0)
        prev = f
      }
    }
  })
})

describe('strokeRedraw', () => {
  it('redraws everything when the target shows nothing valid', () => {
    expect(strokeRedraw(null, 0.4)).toEqual({ mode: 'full', target: 0.4 })
  })

  it('redraws only around new strokes when progress has risen', () => {
    expect(strokeRedraw(0.4, 0.41)).toEqual({ mode: 'incremental', target: 0.41 })
  })

  it('does nothing when the target already shows this progress', () => {
    expect(strokeRedraw(0.4, 0.4)).toEqual({ mode: 'none', target: 0.4 })
    expect(strokeRedraw(1, 1)).toEqual({ mode: 'none', target: 1 })
  })

  it('treats a lower progress as a restart, which only a full redraw can show', () => {
    expect(strokeRedraw(0.8, 0.1).mode).toBe('full')
    expect(strokeRedraw(1, 0).mode).toBe('full')
  })

  it('makes every progress at or below 0 one state, so priming draws once', () => {
    expect(strokeRedraw(null, 0)).toEqual({ mode: 'full', target: -1 })
    expect(strokeRedraw(-1, 0).mode).toBe('none')
    expect(strokeRedraw(-1, -0.2).mode).toBe('none')
  })

  it('lets the stroke born at exactly 0 arrive once progress first rises above 0', () => {
    // A stroke at the growth seed has birth time 0. The mask flags strokes whose
    // birth is above the held value, so "nothing born" has to be below 0.
    const { target } = strokeRedraw(null, 0)
    expect(0).toBeGreaterThan(target)
    expect(strokeRedraw(target, 0.0007).mode).toBe('incremental')
  })
})

describe('lattice table and mask sizes', () => {
  // A pixel searches up to 4 cells either side of its own, and the second
  // sitting's lattice is offset half a cell: the first cell a table must hold
  // is -5 and the last is the frame's last cell plus 5.
  it('cover every cell a pixel of the frame can ask about', () => {
    for (const [extent, cell] of [[1920, 18], [1280, 3], [100, 26], [1081, 7]]) {
      const lastCell = Math.ceil(extent / cell) - 1
      expect(latticeTableSize(extent, cell)).toBeGreaterThanOrEqual(lastCell + 5 - (-5) + 1)
    }
  })

  it('give the mask one block per cell of the stroke size, rounding up', () => {
    expect(dirtyBlocks(1920, 18)).toBe(107)
    expect(dirtyBlocks(1080, 18)).toBe(60)
    expect(dirtyBlocks(18, 18)).toBe(1)
  })
})

describe('even pace', () => {
  // A table the way the bake lays it out: the first texel is cell -5, the
  // frame is cellsX by cellsY cells, birth in R.
  function table(cellsX, cellsY, birthOf) {
    const w = cellsX + 11, h = cellsY + 11
    const buf = new Float32Array(w * h * 4)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      buf[(y * w + x) * 4] = birthOf(x + LATTICE_TABLE_ORIGIN, y + LATTICE_TABLE_ORIGIN)
    }
    return { buf, w, h }
  }

  it('keeps only the cells inside the frame, sorted', () => {
    // Cells inside the frame are born at 0.5; the margin carries 0.99 and 0.
    const t = table(4, 3, (cx, cy) => (cx >= 0 && cx < 4 && cy >= 0 && cy < 3 ? 0.5 : (cx < 0 ? 0.99 : 0)))
    const b = inFrameBirths(t.buf, t.w, t.h, 4, 3)
    expect(b.length).toBe(12)
    expect([...b].every(v => v === 0.5)).toBe(true)
    const mixed = inFrameBirths(table(5, 5, (cx, cy) => ((cx * 7 + cy * 3) % 10) / 10).buf, 16, 16, 5, 5)
    expect([...mixed]).toEqual([...mixed].sort((a, c) => a - c))
  })

  it('counts the share at or below a time', () => {
    const s = Float32Array.from([0.125, 0.25, 0.25, 0.875])
    expect(shareAtOrBelow(s, 0.0625)).toBe(0)
    expect(shareAtOrBelow(s, 0.25)).toBe(0.75)
    expect(shareAtOrBelow(s, 1)).toBe(1)
    expect(shareAtOrBelow(new Float32Array(0), 0.5)).toBe(0)
  })

  it('turns bunched arrival times into a constant number per slice', () => {
    // 1000 strokes bunched into two bursts, near 0.15 and near 0.7.
    const raw = Float32Array.from({ length: 1000 }, (_, i) =>
      (i % 2 ? 0.15 : 0.7) + (((i * 0.6180339887) % 1) - 0.5) * 0.06).sort()
    const slices = new Array(10).fill(0)
    for (const b of raw) slices[Math.min(9, Math.floor(evenPaced(b, raw, 1) * 10))]++
    for (const n of slices) expect(Math.abs(n - 100)).toBeLessThanOrEqual(2)
    // …while with even = 0 the bunching is untouched.
    const rawSlices = new Array(10).fill(0)
    for (const b of raw) rawSlices[Math.min(9, Math.floor(evenPaced(b, raw, 0) * 10))]++
    expect(Math.max(...rawSlices)).toBeGreaterThan(300)
  })

  it('never reorders strokes, at any blend', () => {
    const raw = Float32Array.from({ length: 300 }, (_, i) => ((i * 7919) % 300) / 300 * ((i % 3) / 3 + 0.3)).sort()
    for (const even of [0, 0.3, 0.7, 1]) {
      let prev = -1
      for (const b of raw) {
        const t = evenPaced(b, raw, even)
        expect(t).toBeGreaterThanOrEqual(prev - 1e-9)
        prev = t
      }
    }
  })

  it('blends linearly between the raw and the even time', () => {
    const raw = Float32Array.from([0.1, 0.1, 0.1, 0.9])
    const raw05 = evenPaced(0.1, raw, 0.5), full = evenPaced(0.1, raw, 1)
    expect(raw05).toBeCloseTo((0.1 + full) / 2, 9)
  })
})

describe('shareGone', () => {
  it('counts the strokes inside the frame that have gone, ignoring the margin', () => {
    const w = 6 + 11, h = 4 + 11
    const buf = new Uint8Array(w * h * 4)
    const at = (cx, cy) => ((cy - LATTICE_TABLE_ORIGIN) * w + (cx - LATTICE_TABLE_ORIGIN)) * 4
    for (let cy = 0; cy < 4; cy++) for (let cx = 0; cx < 6; cx++) if (cx < 3) buf[at(cx, cy)] = 255
    // The margin is all gone, which must not count.
    buf[at(-1, 0)] = 255; buf[at(7, 2)] = 255; buf[at(2, -3)] = 255
    expect(shareGone(buf, w, h, 6, 4)).toBe(0.5)
    expect(shareGone(new Uint8Array(w * h * 4), w, h, 6, 4)).toBe(0)
  })
})
