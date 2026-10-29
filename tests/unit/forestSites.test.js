import { describe, test, expect } from 'vitest'
import { forestSiteWindow, forestSiteTableSide } from '../../src/terrain/forestSites.js'

// The forest site table must hold every lattice site whose crown can reach any
// point of the terrain plane — a site left out is a tree that silently
// vanishes (forest.glsl's canCrown skips texels outside the table).
//
// Ground truth is GEOMETRIC, independent of the skewed-floor arithmetic the
// window is computed with: brute-force every lattice site near a point and keep
// the ones whose unskewed position lies within crown reach of it. A crown's
// whole extent, jitter included, is capped at CAN_SUPPORT2 (forest.glsl's
// speciesRadiusCap); the jitter moves the crown but not the site, so the site
// itself can sit up to CAN_SUPPORT2 + max jitter away. Using 2.0 field units
// covers that with margin.
const G2 = (3 - Math.sqrt(3)) / 6      // unskew, independent of the module's constant
const REACH = 2.0                       // field units, >= CAN_SUPPORT2 + jitter
const PLANE = 1500

function sitesReaching(px, pz) {
  const out = []
  const c = Math.round(px), r = Math.round(pz)
  for (let i = c - 8; i <= c + 8; i++) {
    for (let j = r - 8; j <= r + 8; j++) {
      const t = (i + j) * G2
      if (Math.hypot(i - t - px, j - t - pz) <= REACH) out.push([i, j])
    }
  }
  return out
}

describe('forestSiteWindow', () => {
  const cases = [
    { cell: 4, drift: { x: 0, y: 0 } },
    { cell: 4, drift: { x: 1234.5, y: -987.25 } },
    { cell: 1, drift: { x: -50.3, y: 77.7 } },     // the cell slider's minimum
    { cell: 30, drift: { x: 9e4, y: -3.3e4 } },    // its maximum, a long session's drift
  ]
  for (const { cell, drift } of cases) {
    test(`holds every site that can reach the plane (cell ${cell}, drift ${drift.x},${drift.y})`, () => {
      const { origin, size } = forestSiteWindow(PLANE, cell, drift)
      // Points across the plane, corners and edges included, in field units.
      const ts = [-0.5, -0.4999, -0.3, -0.1, 0, 0.17, 0.33, 0.4999, 0.5]
      for (const u of ts) {
        for (const v of ts) {
          const px = (u * PLANE + drift.x) / cell
          const pz = (v * PLANE + drift.y) / cell
          for (const [i, j] of sitesReaching(px, pz)) {
            expect(i - origin[0]).toBeGreaterThanOrEqual(0)
            expect(j - origin[1]).toBeGreaterThanOrEqual(0)
            expect(i - origin[0]).toBeLessThan(size)
            expect(j - origin[1]).toBeLessThan(size)
          }
        }
      }
    })
  }

  test('is not wildly larger than the plane needs', () => {
    // The skewed lattice spans (1 + 2*F2) = sqrt(3) sites per field unit of
    // plane side; anything far beyond that is wasted per-frame work.
    const { size } = forestSiteWindow(PLANE, 4, { x: 0, y: 0 })
    expect(size).toBeLessThan(Math.sqrt(3) * PLANE / 4 + 16)
  })
})

describe('forestSiteTableSide', () => {
  test('always fits what is needed', () => {
    for (const needed of [1, 63, 64, 65, 656, 2600]) {
      expect(forestSiteTableSide(needed, 0)).toBeGreaterThanOrEqual(needed)
    }
  })
  test('keeps the current table while it fits and is not oversized', () => {
    expect(forestSiteTableSide(650, 704)).toBe(704)
    expect(forestSiteTableSide(704, 704)).toBe(704)
  })
  test('reallocates when the table is too small or more than twice too big', () => {
    expect(forestSiteTableSide(705, 704)).toBeGreaterThanOrEqual(705)
    expect(forestSiteTableSide(100, 704)).toBeLessThan(704)
  })
})
