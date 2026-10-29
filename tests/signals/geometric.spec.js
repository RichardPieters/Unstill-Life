/**
 * geometric.spec.js — the exact-tier signals (normal, flatness, aspect, N·L)
 * on tilted planes, plus near-exact height. Ground truth is the analytic math
 * of the plane (fixtures.js), independent of the shader formulas.
 *
 * Why planes give exact normals: a linear height field → a spatially CONSTANT
 * baked gradient in RT_B → any fetch returns it → identical vertex normals →
 * exact interpolation. So normal/flatness/aspect/N·L are constant across the
 * whole surface; the specs assert both the value and its constancy.
 */
import { test, expect } from '@playwright/test'
import { bootSignal, probeGrid, meanScalar } from './probe.js'
import { byId } from './signalRegistry.js'
import {
  tiltedPlane, planeNormal, planeFlatness, planeAspect, planeNdotL, planeHeight,
  TEXEL_WORLD,
} from './fixtures.js'

const SUN_AZ = [0.5, 0.4]
const SUN_ELEV = 1.0
const CONTROLS = { sunAz: SUN_AZ, sunElevation: SUN_ELEV, heightMax: 200 }

// A spread of tilts/azimuths, including flat and a steep face.
const PLANES = [
  { name: 'flat',        f: tiltedPlane(0, 0) },
  { name: '15° → +x',    f: tiltedPlane(15, 0) },
  { name: '30° → +z',    f: tiltedPlane(30, 90) },
  { name: '25° → −x',    f: tiltedPlane(25, 180) },
  { name: '40° diag',    f: tiltedPlane(40, 45) },
]

test.beforeEach(async ({ page }) => { await bootSignal(page) })

test('probe uses a true float RT (tight-eps precondition)', async ({ page }) => {
  const res = await probeGrid(page, {
    fixture: tiltedPlane(20, 0), debugViewId: byId.normal.debugViewId, controls: CONTROLS,
  })
  expect(res.floatRT, 'float RT unavailable — tight-eps specs would be invalid').toBe(true)
  expect(res.samples.length).toBeGreaterThan(100)
})

for (const { name, f } of PLANES) {
  test(`normal — ${name}`, async ({ page }) => {
    const res = await probeGrid(page, { fixture: f, debugViewId: byId.normal.debugViewId, controls: CONTROLS })
    const gt = planeNormal(f.params)
    // per-component mean + constancy across the surface
    for (let c = 0; c < 3; c++) {
      const vals = res.samples.map(s => s.v[c])
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length
      const maxDev = Math.max(...vals.map(v => Math.abs(v - mean)))
      expect(Math.abs(mean - gt[c]), `normal[${c}] value`).toBeLessThan(0.02)
      expect(maxDev, `normal[${c}] constancy`).toBeLessThan(0.02)
    }
  })

  test(`flatness — ${name}`, async ({ page }) => {
    const res = await probeGrid(page, { fixture: f, debugViewId: byId.flatness.debugViewId, controls: CONTROLS })
    expect(Math.abs(meanScalar(res) - planeFlatness(f.params))).toBeLessThan(0.02)
  })

  test(`N·L — ${name}`, async ({ page }) => {
    const res = await probeGrid(page, { fixture: f, debugViewId: byId.NdotL.debugViewId, controls: CONTROLS })
    expect(Math.abs(meanScalar(res) - planeNdotL(f.params, SUN_AZ, SUN_ELEV))).toBeLessThan(0.02)
  })
}

// aspect is undefined on a flat plane (no horizontal normal) — tilted only.
for (const { name, f } of PLANES.filter(p => p.name !== 'flat')) {
  test(`aspect — ${name}`, async ({ page }) => {
    const res = await probeGrid(page, { fixture: f, debugViewId: byId.aspect.debugViewId, controls: CONTROLS })
    expect(Math.abs(meanScalar(res) - planeAspect(f.params, SUN_AZ))).toBeLessThan(0.03)
  })
}

// Near-exact height: slope-scaled eps + absolute floor (flat can't demand
// bit-exactness). Uses a plane tilted purely in x so the world↔pixel mapping
// is checkable on one axis.
test('height — linear field within slope-scaled eps', async ({ page }) => {
  const f = tiltedPlane(25, 0)   // gradient purely in +x
  const res = await probeGrid(page, { fixture: f, debugViewId: byId.height.debugViewId, controls: CONTROLS })
  const grad = Math.hypot(f.params.ax, f.params.az)
  const eps = 0.12 * grad * TEXEL_WORLD + 0.5   // +0.5 wu float/readback floor
  let maxErr = 0
  for (const s of res.samples) {
    maxErr = Math.max(maxErr, Math.abs(s.v[0] - planeHeight(f.params, s.x, s.z)))
  }
  expect(maxErr, `height max error (eps=${eps.toFixed(3)})`).toBeLessThan(eps)
})
