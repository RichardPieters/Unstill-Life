/**
 * probe.js — signal-test harness. Pins the full control state, injects an
 * analytic fixture surface, renders the raw signal (uProbeRaw) through an
 * orthographic top-down camera into a Float32 render target, and reads back a
 * grid of raw values with their world (x,z). No display-ramp decode: the probe
 * reads the signal's actual float value.
 *
 * Each Playwright test gets a fresh page (goto), so control state need not be
 * restored between tests — bootSignal + pinned probeGrid give a clean slate.
 */
import { PLANE_SIZE } from '../../src/shared/sceneConfig.js'

/** Boot the app, dismiss the overlay, pause the loop. */
export async function bootSignal(page) {
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto('/')
  await page.waitForFunction(() => !!window.__d)
  await page.mouse.click(640, 360)   // dismiss start overlay
  // Frames, not a sleep: a loaded machine still gets the same settle.
  await page.evaluate(async () => {
    for (let i = 0; i < 10; i++) await new Promise(r => requestAnimationFrame(r))
  })
  await page.evaluate(() => window.__d.pause())
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {object} o
 * @param {{kind:string,params:object}} o.fixture
 * @param {number} o.debugViewId
 * @param {object} [o.controls]  { sunAz:[x,z], sunElevation, heightMax, uniforms:{name:val} }
 * @param {number} [o.grid]      samples per axis
 * @param {number} [o.margin]    world-unit border excluded from sampling
 * @returns {Promise<{samples:{x:number,z:number,v:number[]}[], floatRT:boolean}>}
 */
export async function probeGrid(page, { fixture, debugViewId, controls = {}, grid = 24, margin = 350 }) {
  return page.evaluate(
    ({ fixture, debugViewId, controls, grid, margin, planeSize }) => {
      const { THREE, terrain, renderer, scene, water } = window.__d

      // Surface height — the controlled INPUT. Formula lives here once; params
      // come from the node-side fixture. (Not a signal under test → no mirror.)
      function heightAt(f, x, z) {
        const p = f.params
        switch (f.kind) {
          case 'plane':      return p.ax * x + p.az * z + p.c
          case 'paraboloid': return p.k * (x * x + z * z) + p.c
          case 'saddle':     return p.k * (x * x - z * z) + p.c
          case 'gaussian':   return p.amp * Math.exp(-(x * x + z * z) / (2 * p.sig * p.sig)) + p.c
          default:           return 0
        }
      }

      // ── control variables: pin the full deterministic state ──
      const u = terrain._material.uniforms
      terrain.params.set('frozen', true)
      u.uBandNoiseAmt.value = 0
      u.uRidgeRound.value = 0
      u.uForestOn.value = 0        // forest must never perturb a probed signal
      u.uEnableTimeAxis.value = false
      const az = controls.sunAz ?? [0.5, 0.4]
      u.uSunAzimuth.value.set(az[0], az[1])
      u.uSunElevation.value = controls.sunElevation ?? 1.0
      if (controls.heightMax != null) u.uHeightMax.value = controls.heightMax
      for (const [k, v] of Object.entries(controls.uniforms || {})) u[k].value = v

      // ── fixture surface into the data map; rebuild RT_B from it ──
      terrain.setFixtureHeightfield((x, z) => heightAt(fixture, x, z))
      terrain.renderDataMap()

      // ── raw-signal render: ortho top-down, terrain only, into a float RT ──
      terrain.params.set('debugView', debugViewId)
      terrain.params.set('probeRaw', true)
      const half = planeSize / 2 - margin
      const cam = new THREE.OrthographicCamera(-half, half, half, -half, 0.1, 6000)
      cam.position.set(0, 3000, 0)
      cam.up.set(0, 0, -1)             // top-down: +x → screen right, +z → screen down
      cam.lookAt(0, 0, 0)
      cam.updateMatrixWorld(true)

      const rt = new THREE.WebGLRenderTarget(grid, grid, {
        type: THREE.FloatType, format: THREE.RGBAFormat,
        minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
        depthBuffer: true,
      })
      const wV = water.mesh ? water.mesh.visible : false
      if (water.mesh) water.mesh.visible = false

      const prev = renderer.getRenderTarget()
      renderer.setRenderTarget(rt)
      renderer.render(scene, cam)
      const buf = new Float32Array(grid * grid * 4)
      renderer.readRenderTargetPixels(rt, 0, 0, grid, grid, buf)
      renderer.setRenderTarget(prev)

      if (water.mesh) water.mesh.visible = wV
      terrain.params.set('probeRaw', false)
      terrain.setFixtureHeightfield(null)
      terrain.params.set('debugView', 0)
      const floatRT = rt.texture.type === THREE.FloatType
      rt.dispose()

      // ── decode: readback row 0 = bottom. pixel → world (x,z) ──
      const samples = []
      for (let py = 0; py < grid; py++) {
        for (let px = 0; px < grid; px++) {
          const o = (py * grid + px) * 4
          const u01 = (px + 0.5) / grid
          const v01 = (py + 0.5) / grid
          const x = (u01 * 2 - 1) * half
          const z = ((v01 * 2 - 1) * half)   // sign verified empirically in the height spec
          samples.push({ x, z, v: [buf[o], buf[o + 1], buf[o + 2]] })
        }
      }
      return { samples, floatRT }
    },
    { fixture, debugViewId, controls, grid, margin, planeSize: PLANE_SIZE },
  )
}

/** mean of a scalar signal (v[0]) over all samples. */
export function meanScalar(res) {
  const xs = res.samples.map(s => s.v[0])
  return xs.reduce((a, b) => a + b, 0) / xs.length
}

/** max abs deviation of a scalar signal from a constant. */
export function maxDevScalar(res, target) {
  return Math.max(...res.samples.map(s => Math.abs(s.v[0] - target)))
}
