import { describe, test, expect } from 'vitest'
import { createAdaptivePlane } from '../../src/terrain/terrainGeometry.js'

// createAdaptivePlane builds a THREE.BufferGeometry — pure data, no GL context
// needed, so it runs under vitest's node env.

describe('createAdaptivePlane', () => {
  const SIZE = 1500, SEGS = 4, CAM_Z = 160, CAM_Y = 45
  const geo = createAdaptivePlane(SIZE, SEGS, CAM_Z, CAM_Y)
  const pos = geo.getAttribute('position').array
  const N = SEGS

  test('vertex count = (segs+1)^2', () => {
    expect(geo.getAttribute('position').count).toBe((N + 1) * (N + 1))
  })
  test('index count = segs^2 · 6 (two triangles per cell)', () => {
    expect(geo.getIndex().count).toBe(N * N * 6)
  })
  test('X spans exactly [-half, +half]', () => {
    const half = SIZE / 2
    expect(pos[0]).toBeCloseTo(-half)                 // first vertex x
    expect(pos[N * 3]).toBeCloseTo(half)              // last vertex of first row x
  })
  test('Z endpoints land exactly on ±half (arcsinh inverse is exact there)', () => {
    const half = SIZE / 2
    const zFirstRow = pos[2]                           // z of row 0
    const zLastRow  = pos[(N * (N + 1)) * 3 + 2]       // z of row N
    expect(zFirstRow).toBeCloseTo(-half)
    expect(zLastRow).toBeCloseTo(half)
  })
  test('Z is monotonically increasing row to row (no fold-over)', () => {
    let prev = -Infinity
    for (let iz = 0; iz <= N; iz++) {
      const z = pos[(iz * (N + 1)) * 3 + 2]
      expect(z).toBeGreaterThan(prev)
      prev = z
    }
  })
  test('all vertices lie in the y=0 plane (shader reads pos.xz)', () => {
    for (let i = 1; i < pos.length; i += 3) expect(pos[i]).toBe(0)
  })
})
