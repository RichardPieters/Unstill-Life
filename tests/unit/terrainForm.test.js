import { describe, test, expect } from 'vitest'
import { FORM_CORNERS, formTargets } from '../../src/drift/terrainForm.js'

// Corner order is [ocean0·mtn0, ocean0·mtn1, ocean1·mtn0, ocean1·mtn1].
const CORNER_COORDS = [[0, 0], [0, 1], [1, 0], [1, 1]]

describe('terrain form dials', () => {
  // The one property that makes this trustworthy: the blend must return the
  // hand-tuned snapshot configurations EXACTLY when the dials sit on a corner.
  // If this drifts, the dials stop reproducing any approved configuration.
  test('every corner reproduces its measured configuration exactly', () => {
    CORNER_COORDS.forEach(([o, m], i) => {
      const t = formTargets(o, m)
      for (const [key, corner] of Object.entries(FORM_CORNERS)) {
        const want = key === 'bedrockOctaves' ? Math.round(corner[i]) : corner[i]
        expect(t[key], `${key} at ocean ${o} / mountains ${m}`).toBeCloseTo(want, 10)
      }
    })
  })

  test('the centre is the mean of all four corners', () => {
    const t = formTargets(0.5, 0.5)
    for (const [key, c] of Object.entries(FORM_CORNERS)) {
      if (key === 'bedrockOctaves') continue          // rounded, checked below
      expect(t[key], key).toBeCloseTo((c[0] + c[1] + c[2] + c[3]) / 4, 10)
    }
  })

  test('octave counts come back as whole numbers', () => {
    for (const o of [0, 0.3, 0.5, 0.77, 1]) {
      for (const m of [0, 0.42, 1]) {
        const v = formTargets(o, m).bedrockOctaves
        expect(Number.isInteger(v), `ocean ${o} / mountains ${m} → ${v}`).toBe(true)
      }
    }
  })

  test('dials outside 0–1 clamp rather than extrapolating', () => {
    // Extrapolating a hand-tuned surface produces values nobody has ever seen —
    // amplitudes past 150, negative relief. Clamp instead.
    expect(formTargets(-3, 5)).toEqual(formTargets(0, 1))
    expect(formTargets(9, -2)).toEqual(formTargets(1, 0))
  })

  test('a non-finite dial reads as 0 rather than turning every target NaN', () => {
    // A NaN target reaches every terrain uniform the form writes.
    expect(formTargets(NaN, undefined)).toEqual(formTargets(0, 0))
  })

  // Direction checks. These are the claims the dial LABELS make, so they are
  // worth pinning: a sign flip here means the control does the opposite of what
  // it says. Signs and orderings only — no thresholds.
  test('raising mountains raises terrain height, at either ocean end', () => {
    for (const o of [0, 1]) {
      const lo = formTargets(o, 0), hi = formTargets(o, 1)
      expect(hi.fbm0Amp, `ocean ${o}`).toBeGreaterThan(lo.fbm0Amp)
    }
  })

  test('raising ocean raises the sea band, at either mountain end', () => {
    for (const m of [0, 1]) {
      const lo = formTargets(0, m), hi = formTargets(1, m)
      expect(hi.seaLow, `mountains ${m}`).toBeGreaterThan(lo.seaLow)
      expect(hi.seaHigh, `mountains ${m}`).toBeGreaterThan(lo.seaHigh)
    }
  })

  test('the sea band never inverts anywhere on the surface', () => {
    for (let o = 0; o <= 1.0001; o += 0.1) {
      for (let m = 0; m <= 1.0001; m += 0.1) {
        const t = formTargets(o, m)
        expect(t.seaHigh, `ocean ${o.toFixed(1)} / mountains ${m.toFixed(1)}`)
          .toBeGreaterThan(t.seaLow)
      }
    }
  })

  test('raising ocean shrinks the landforms — that is how islands are made', () => {
    for (const m of [0, 1]) {
      const lo = formTargets(0, m), hi = formTargets(1, m)
      // Higher frequency = smaller features, and the second instance's
      // amplitude drops away, removing the hills that bridge landmasses.
      expect(hi.fbm0Freq, `mountains ${m}`).toBeGreaterThan(lo.fbm0Freq)
      expect(hi.fbm1Amp, `mountains ${m}`).toBeLessThan(lo.fbm1Amp)
    }
  })

  test('ridge sharpness and crease roundness always move in opposition', () => {
    // Sharpening without softening the crease feeds the erosion stage a kink it
    // amplifies into a field of identical spikes. Checked across the surface,
    // not just at the corners.
    let prevAmt = -Infinity, prevRound = Infinity
    for (let m = 0; m <= 1.0001; m += 0.1) {
      const t = formTargets(0.5, m)
      expect(t.ridgeAmt).toBeGreaterThanOrEqual(prevAmt - 1e-9)
      expect(t.ridgeRound).toBeLessThanOrEqual(prevRound + 1e-9)
      prevAmt = t.ridgeAmt
      prevRound = t.ridgeRound
    }
  })

  test('every target stays finite and inside its corner span', () => {
    // A bilinear blend can never leave the convex hull of its corners; this
    // guards against a typo turning a corner table into something that can.
    for (let o = 0; o <= 1.0001; o += 0.25) {
      for (let m = 0; m <= 1.0001; m += 0.25) {
        const t = formTargets(o, m)
        for (const [key, c] of Object.entries(FORM_CORNERS)) {
          const lo = Math.min(...c), hi = Math.max(...c)
          expect(Number.isFinite(t[key]), key).toBe(true)
          expect(t[key], `${key} @ ${o},${m}`).toBeGreaterThanOrEqual(lo - 0.5)
          expect(t[key], `${key} @ ${o},${m}`).toBeLessThanOrEqual(hi + 0.5)
        }
      }
    }
  })
})
