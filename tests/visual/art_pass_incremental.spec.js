import { test, expect } from '@playwright/test'
import { boot } from './helpers.js'

/**
 * The entrance redraws only the canvas around the strokes that just arrived
 * (artStrokes.js). That is worth having only if the picture it leaves is the
 * picture a full redraw would draw, so these specs compare the two directly on
 * the GPU: the stroke target after a run of incremental frames against the same
 * target redrawn whole at the same progress, over both attachments and every
 * pixel. A mask that left a block out, a table that disagreed with the stroke
 * pass about where a stroke sits, or a clear that wiped the old strokes would
 * each show as differing pixels here and nowhere in a screenshot.
 */

/** Prepasses and growth field built over the live frame, scene held still. */
async function prepare(page) {
  return page.evaluate(() => {
    const d = window.__d, R = d.renderer, A = d.artPass, T = d.THREE
    R.setAnimationLoop(null)
    const W = 640, H = 360
    A.setSize(W, H)
    const beauty = new T.WebGLRenderTarget(W, H, { type: T.HalfFloatType })
    R.setRenderTarget(beauty); R.render(d.scene, d.camera)
    d.artGBuffer.setSize(W, H); d.artGBuffer.render(R, d.scene, d.camera)
    A.pushSceneUniforms(beauty)
    A.stages.prepass.refresh(R, A.params.get('groundMode'))
    A.stages.prepass.buildGrowthField(R)
    A.setSceneStatic(true)
    window.__beauty = beauty
  })
}

test('incremental redraws leave exactly what a full redraw draws, at every stage of the reveal', async ({ page }) => {
  await boot(page)
  await prepare(page)
  const result = await page.evaluate(() => {
    const d = window.__d, R = d.renderer, A = d.artPass, T = d.THREE
    const S = A.stages.strokes, gl = R.getContext()
    const W = 640, H = 360
    const readRt = new T.WebGLRenderTarget(W, H, { type: T.FloatType, depthBuffer: false,
      minFilter: T.NearestFilter, magFilter: T.NearestFilter })
    const snapshot = rt => [0, 1].map(i => {
      A.copyTexture(R, rt.textures[i], readRt)
      const buf = new Float32Array(W * H * 4)
      R.setRenderTarget(readRt)
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.FLOAT, buf)
      return buf
    })
    const differing = (a, b) => { let n = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++; return n }

    const rows = []
    S.invalidate()
    const frames = 60
    const checks = [3, 10, 25, 45, 60]
    for (let i = 0; i <= frames; i++) {
      const spawn = i / frames
      S.update(R, spawn, true)
      if (!checks.includes(i)) continue
      const incremental = snapshot(S.strokeTarget)
      S.invalidate(); S.update(R, spawn, true)
      const whole = snapshot(S.strokeTarget)
      // Something is actually painted by then, or the comparison proves nothing.
      let painted = 0
      for (let p = 3; p < whole[1].length; p += 4) if (whole[1][p] > 0.5) painted++
      rows.push({ spawn, painted, paint: differing(incremental[0], whole[0]), ids: differing(incremental[1], whole[1]) })
    }
    return rows
  })
  expect(result[0].painted, 'by the first check some strokes must have arrived').toBeGreaterThan(0)
  for (const r of result) {
    expect(r.paint, `paint differs at progress ${r.spawn}`).toBe(0)
    expect(r.ids, `stroke ids differ at progress ${r.spawn}`).toBe(0)
  }
  // Coverage rises through the reveal: strokes accumulate, none are lost.
  for (let i = 1; i < result.length; i++) expect(result[i].painted).toBeGreaterThanOrEqual(result[i - 1].painted)
})

test('a frame that adds no strokes redraws nothing; one that adds some redraws a part of the canvas', async ({ page }) => {
  await boot(page)
  await prepare(page)
  const r = await page.evaluate(() => {
    const d = window.__d, R = d.renderer, A = d.artPass
    const S = A.stages.strokes
    const draws = []
    A.onDraw = name => draws.push(name)
    S.invalidate()
    S.update(R, 0.3, true)
    const full = draws.slice(); draws.length = 0
    S.update(R, 0.3, true)
    const same = draws.slice(); draws.length = 0
    S.update(R, 0.31, true)
    const next = draws.slice()
    return { full, same, next, allDirtyAfter: A.uniformValue('uAllDirty') }
  })
  expect(r.full).toContain('paint')
  expect(r.full).toContain('birth')          // a full redraw bakes the tables…
  expect(r.full).not.toContain('dirty')      // …and needs no mask
  expect(r.same).toEqual([])                 // nothing arrived: nothing drawn
  expect(r.next).toEqual(['dirty', 'paint'])  // new strokes: mask, then a masked redraw
  expect(r.allDirtyAfter).toBe(0)
})

test('only settings a stroke is made of invalidate the strokes; the ground and the canvas do not', async ({ page }) => {
  await boot(page)
  await prepare(page)
  const r = await page.evaluate(() => {
    const d = window.__d, R = d.renderer, A = d.artPass
    const S = A.stages.strokes
    S.invalidate(); S.update(R, 0.5, true)
    const shown = () => S.shown
    const held = shown()
    const out = { held }
    for (const [key, value] of [['groundColor', '#112233'], ['weave', 0.3], ['groundBlur', 2], ['colSky', '#445566']]) {
      A.params.set(key, value)
      out[key] = shown()
    }
    A.params.set('cell', 12)
    out.cell = shown()
    S.update(R, 0.5, true)
    out.afterRedraw = shown()
    A.params.set('jitter', 0.3)
    out.jitter = shown()
    return out
  })
  expect(r.held).toBe(0.5)
  for (const key of ['groundColor', 'weave', 'groundBlur', 'colSky']) {
    expect(r[key], `${key} must leave the strokes standing`).toBe(0.5)
  }
  expect(r.cell, 'a new stroke size redraws every stroke').toBeNull()
  expect(r.afterRedraw).toBe(0.5)
  expect(r.jitter).toBeNull()
})

test('a moving scene redraws the strokes, because they follow the frame', async ({ page }) => {
  await boot(page)
  await prepare(page)
  const r = await page.evaluate(() => {
    const d = window.__d, R = d.renderer, A = d.artPass
    const S = A.stages.strokes
    S.invalidate(); S.update(R, 1, false)
    const before = S.shown
    A.setSceneStatic(false)
    return { before, after: S.shown }
  })
  expect(r.before).toBe(1)
  expect(r.after).toBeNull()
})

test('even pace makes marks arrive at a steady rate, and the painted fraction follows the picture', async ({ page }) => {
  await boot(page)
  await prepare(page)
  const r = await page.evaluate(() => {
    const d = window.__d, R = d.renderer, A = d.artPass
    const S = A.stages.strokes
    const measure = even => {
      A.params.set('revealEvenPace', even)
      S.invalidate(); S.update(R, 0.5, true)
      const slices = []
      for (let i = 1; i <= 10; i++) slices.push(S.paintedFraction(i / 10))
      return slices.map((v, i) => v - (i ? slices[i - 1] : 0))
    }
    return { raw: measure(0), even: measure(1) }
  })
  const spread = a => Math.max(...a) - Math.min(...a)
  for (const share of r.even) expect(share).toBeGreaterThan(0.08)
  expect(spread(r.even), 'even pace should flatten the arrival curve').toBeLessThan(0.03)
  expect(spread(r.raw), 'the raw growth order is bursty, or this test proves nothing').toBeGreaterThan(spread(r.even))
})
