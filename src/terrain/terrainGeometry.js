import * as THREE from 'three'
import { ADAPTIVE_CAM_Z, ADAPTIVE_CAM_Y } from '../shared/sceneConfig.js'

/**
 * terrainGeometry.js — plane-geometry factories for the terrain mesh.
 *
 * Pure geometry construction, no material/uniform/tick concerns. The mesh uses
 * a camera-biased adaptive grid so the near ground is dense and the far
 * distance coarse. The camera-proximity constants
 * come from sceneConfig (derived from CAM_POSITION) so the bias tracks the
 * real camera automatically.
 */

/**
 * Create a non-uniform plane geometry with perspective-correct vertex density.
 * Vertex spacing along Z scales proportionally to distance from the camera,
 * derived from the closed-form integral of 1/d (arcsinh distribution).
 * This ensures the far distance is coarse but not starved, and the near
 * region is dense without wasting triangles directly under the camera.
 *
 * Vertices in XZ plane (y=0) — shader reads pos.xz directly.
 */
export function createAdaptivePlane(size, segs, camZ = ADAPTIVE_CAM_Z, camY = ADAPTIVE_CAM_Y) {
  const half = size / 2
  const N    = segs

  // Cumulative density F(z) = -arcsinh((camZ - z) / camY)
  // Vertex spacing ∝ distance from camera → F is its own inverse via sinh
  const F  = z => -Math.asinh((camZ - z) / camY)
  const F0 = F(-half)
  const Fr = F(half) - F0  // total range

  // Invert: given uniform t ∈ [0,1], return the z with the correct density
  function biasedZ(t) {
    return camZ - camY * Math.sinh(-(F0 + t * Fr))
  }

  const vCount = (N + 1) * (N + 1)
  const pos    = new Float32Array(vCount * 3)
  const indices = []

  let vi = 0
  for (let iz = 0; iz <= N; iz++) {
    const z = biasedZ(iz / N)
    for (let ix = 0; ix <= N; ix++) {
      pos[vi++] = -half + (ix / N) * size
      pos[vi++] = 0
      pos[vi++] = z
    }
  }
  for (let iz = 0; iz < N; iz++) {
    for (let ix = 0; ix < N; ix++) {
      const a = iz * (N + 1) + ix
      const b = a + 1
      const c = a + N + 1
      const d = c + 1
      indices.push(a, c, b, b, c, d)
    }
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  geo.setIndex(indices)
  return geo
}
