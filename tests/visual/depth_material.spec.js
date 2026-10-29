/**
 * depth_material.spec.js — guards terrain.js's depth-only material
 * (setDepthOnly), which keeps water.depthPrePass from paying the full
 * forest/biome fragment cost just to populate a depth buffer nothing else
 * reads the colour of.
 *
 * The claim under test: swapping to the depth-only material for that one
 * pass produces a PIXEL-IDENTICAL final frame to using the real material
 * there — because both share the exact same vertex shader (so displacement,
 * and therefore depth, is bit-for-bit the same), and terrain.frag never
 * discards a fragment (checked directly — forest blends into colour rather
 * than punching holes), so there's no fragment the two materials could
 * disagree about. If a future change makes the depth material's vertex
 * shader diverge, or adds a discard to terrain.frag, this goes red.
 */
import { test, expect } from '@playwright/test'
import { boot } from './helpers.js'

/**
 * Render the frame twice — pre-pass on the real material, then on the
 * depth-only one — into offscreen targets, and return the largest per-channel
 * difference. Rendered and read back in ONE task: a canvas screenshot captures
 * whatever the render loop presented last, which under load can be a later
 * frame than the one drawn here. Drawing-buffer size, because the water pass
 * samples the pre-pass depth texture allocated at that size.
 */
function maxDiffDepthOnlyVsReal(page) {
  return page.evaluate(() => {
    const { THREE, renderer, scene, camera, terrain, water } = window.__d
    const size = renderer.getDrawingBufferSize(new THREE.Vector2())
    const W = size.x, H = size.y
    const draw = depthOnly => {
      const rt = new THREE.WebGLRenderTarget(W, H)
      terrain.setDepthOnly(depthOnly)
      water.depthPrePass(renderer, scene, camera)
      terrain.setDepthOnly(false)   // the visible render always uses the real material
      water.reflectionPrePass(renderer, scene, camera)
      renderer.setRenderTarget(rt)
      renderer.render(scene, camera)
      const px = new Uint8Array(W * H * 4)
      renderer.readRenderTargetPixels(rt, 0, 0, W, H, px)
      renderer.setRenderTarget(null)
      rt.dispose()
      return px
    }
    const real = draw(false)        // pre-fix behaviour
    const depthOnly = draw(true)    // the fix
    let maxDiff = 0
    for (let i = 0; i < real.length; i++) maxDiff = Math.max(maxDiff, Math.abs(real[i] - depthOnly[i]))
    return maxDiff
  })
}

test('the depth-only material renders water identically to the real material', async ({ page }) => {
  await boot(page, { pause: true })
  const maxDiff = await maxDiffDepthOnlyVsReal(page)
  // Not toEqual: two draws can differ by float-rounding noise. A real depth
  // mismatch would misplace the shoreline/foam band by many pixels, not shift
  // a channel value by a rounding error.
  expect(maxDiff).toBeLessThan(6)
})
