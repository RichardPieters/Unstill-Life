import { test, expect } from '@playwright/test'
import { boot, screenshotPixels, canvasPixelStats, waitFrames } from './helpers.js'

/**
 * Render gate for the divisionist post-process (src/artpass/artPass.js).
 *
 * The art pass is a chain of six GLSL programs, and a GLSL compile failure is
 * silent from the outside: the pass simply renders nothing and the picture
 * looks like the pass is switched off — which is also what it looks like when
 * it IS switched off. So the first thing every case here does is enable it and
 * assert the frame actually changed.
 *
 * Everything asserted is a property, an ordering or an invariant. Nothing pins
 * a tuned number or a pixel, because the whole point of the pass is that its
 * forty-six sliders get retuned.
 */

/**
 * Enable the pass and let the composer draw one frame with it in the chain.
 *
 * markDirty is not optional here. These specs run paused, and the render loop
 * skips every GPU stage while paused unless something says the frame changed —
 * a check driven by a listener on the debug panel, which a change made through
 * window.__d never trips. Without it the canvas keeps showing the frame from
 * before the pass was switched on, and EVERY assertion below reads zero
 * difference, which looks exactly like six shaders failing to compile.
 */
async function paint(page, on = true) {
  await page.evaluate(v => { window.__d.artPass.enabled = v; window.__d.markDirty() }, on)
  await waitFrames(page, 3)
}

/** Change something on the pass and redraw. */
async function tweak(page, fn, arg) {
  await page.evaluate(({ src, a }) => {
    // eslint-disable-next-line no-new-func
    new Function('art', 'a', src)(window.__d.artPass, a)
    window.__d.markDirty()
  }, { src: fn, a: arg })
  await waitFrames(page, 3)
}

/**
 * Mean absolute difference between horizontally adjacent pixels, 0..255.
 *
 * This, not a frame-to-frame difference, is what detects that the pass ran.
 * Divisionism's whole claim is that a stroke's colour is drawn from a palette
 * whose weighted mean returns the TARGET colour exactly — so a painted frame
 * averages back to the picture it replaced, and at 3-pixel marks a downsampled
 * comparison of the two is nearly zero by design. What the paint does add is
 * local contrast: smooth gradients become discrete marks sitting side by side.
 */
function localContrast(px, w) {
  let sum = 0, n = 0
  for (let y = 0; y < w; y++) {
    for (let x = 0; x < w - 1; x++) {
      const i = (y * w + x) * 4
      for (let c = 0; c < 3; c++) { sum += Math.abs(px[i + c] - px[i + 4 + c]); n++ }
    }
  }
  return sum / n
}

/** Mean absolute per-channel difference between two downsampled frames, 0..255. */
function frameDelta(a, b) {
  let sum = 0, n = 0
  for (let i = 0; i < a.length; i += 4) {
    for (let c = 0; c < 3; c++) { sum += Math.abs(a[i + c] - b[i + c]); n++ }
  }
  return sum / n
}

const glErrors = errors => errors.filter(e => /webgl|shader|gl_|three|PAGEERROR|INVALID/i.test(e))

test('painting the frame compiles and changes the picture', async ({ page }) => {
  const errors = await boot(page)
  const before = await screenshotPixels(page, 512)

  await paint(page)
  expect(glErrors(errors), glErrors(errors).join('\n')).toHaveLength(0)

  const after = await screenshotPixels(page, 512)
  // Measured at 512, not 128: the marks are a few pixels across, and a
  // downsample wide enough to average several of them together is exactly the
  // operation the colour engine guarantees will give the original picture back.
  const painted = localContrast(after, 512)
  const plain = localContrast(before, 512)
  expect(painted, `paint did not raise local contrast (${plain.toFixed(2)} -> ${painted.toFixed(2)})`)
    .toBeGreaterThan(plain * 1.5)

  const { mean, variance } = await canvasPixelStats(page)
  expect(variance).toBeGreaterThan(300)   // not a solid colour
  expect(mean).toBeGreaterThan(5)         // not black
  expect(mean).toBeLessThan(250)          // not white / NaN blowout
})

test('switching the pass off restores the unpainted frame', async ({ page }) => {
  await boot(page)
  const before = await screenshotPixels(page, 256)
  await paint(page, true)
  await paint(page, false)
  const after = await screenshotPixels(page, 256)
  // The pass owns its own render targets and must leave the composer's alone.
  // Anything it clobbers would show up here as the frame not coming back.
  expect(frameDelta(before, after)).toBeLessThan(2)
})

/**
 * The four grounds are four different pictures, not four labels on one. Each is
 * checked against `source` AND against its predecessor, because a mode that
 * silently falls through to another renders perfectly and reads as a retune.
 */
test('each ground mode renders and differs from the others', async ({ page }) => {
  const errors = await boot(page)
  await paint(page)
  // Let the ground actually show. At the shipped defaults the marks cover it
  // almost completely, so all four modes render nearly the same picture — which
  // is the pass working as intended, not the modes being interchangeable. The
  // question this test asks is whether the four GROUNDS differ, so it has to
  // open the gaps that reveal them, and take the canvas toning off (it washes
  // every ground toward one colour).
  await tweak(page, "art.params.set('groundMix', 0.6); art.params.set('cell', 9); art.params.set('dotScale', 0.5); art.params.set('revealPrimeLighten', 0)")

  const frames = []
  for (const mode of [0, 1, 2, 3]) {
    await tweak(page, "art.params.set('groundMode', a)", mode)
    frames.push({ mode, px: await screenshotPixels(page, 128) })
  }
  expect(glErrors(errors), glErrors(errors).join('\n')).toHaveLength(0)

  for (let i = 1; i < frames.length; i++) {
    for (let j = 0; j < i; j++) {
      const d = frameDelta(frames[i].px, frames[j].px)
      expect(d, `ground mode ${frames[i].mode} is indistinguishable from ${frames[j].mode}`)
        .toBeGreaterThan(1.5)
    }
  }
})

/**
 * Every diagnostic must render, and must NOT be shaded — a lit diagnostic is
 * not merely odd-looking, it changes the values read back off the canvas, which
 * is how the edge-field view stopped being measurable in the sandbox.
 */
test('each debug view renders something', async ({ page }) => {
  const errors = await boot(page)
  await paint(page)

  for (const view of [0, 1, 2, 3, 4, 5]) {
    await tweak(page, "art.params.set('debugView', a)", view)
    const { mean, variance } = await canvasPixelStats(page)
    expect(mean, `view ${view} is black`).toBeGreaterThan(3)
    expect(mean, `view ${view} is blown out`).toBeLessThan(252)
    expect(variance, `view ${view} is one flat colour`).toBeGreaterThan(20)
  }
  expect(glErrors(errors), glErrors(errors).join('\n')).toHaveLength(0)
})

/**
 * The segment view is the G-buffer's own read-back, and it is the one
 * diagnostic with a known right answer: this scene has sky above a horizon and
 * terrain below it, so the view must contain BOTH its sky colour and its land
 * colour. A G-buffer that failed to render comes back uniformly sky — which
 * otherwise just looks like edge alignment quietly doing nothing.
 */
test('the G-buffer separates sky from land', async ({ page }) => {
  await boot(page)
  await paint(page)
  await tweak(page, "art.params.set('debugView', 4)")

  // The three flat colours artPaint.frag writes for this view, as 8-bit. Asserting
  // the ACTUAL colours rather than "bluish" / "greenish" matters: the unpainted
  // scene is also blue above green, so a loose test passes on a pass that never
  // ran at all.
  const KEY = { sky: [26, 51, 204], water: [26, 204, 204], land: [51, 179, 51] }
  const px = await screenshotPixels(page, 128)
  const near = (i, c) => Math.abs(px[i] - c[0]) < 26 && Math.abs(px[i + 1] - c[1]) < 26
    && Math.abs(px[i + 2] - c[2]) < 26

  let sky = 0, land = 0, known = 0
  for (let i = 0; i < px.length; i += 4) {
    if (near(i, KEY.sky)) { sky++; known++ }
    else if (near(i, KEY.land)) { land++; known++ }
    else if (near(i, KEY.water)) known++
  }
  const total = px.length / 4
  // The rest is the downsampler averaging across segment boundaries.
  expect(known / total, 'the segment view is not made of its own three colours')
    .toBeGreaterThan(0.7)
  expect(sky / total, 'no sky in the segment view').toBeGreaterThan(0.05)
  expect(land / total, 'no land in the segment view — the G-buffer never rendered')
    .toBeGreaterThan(0.05)
})

/**
 * The relief is the whole reason the stroke pass carries a height channel at
 * all, and it fails SILENTLY: the finish pass differentiates an all-zero field,
 * gets a flat normal, and the lighting becomes a no-op. The picture still looks
 * like a plausible painting. Measuring |lit - unlit| is the only thing that
 * catches it — and note it has to measure the LIGHTING, not the paint: an
 * earlier version of this compared stroke colours and reported identical
 * results for lit and unlit alike.
 */
test('paint thickness measurably lights the surface', async ({ page }) => {
  await boot(page)
  await paint(page)

  await tweak(page, "art.params.set('heightScale', 1.5); art.params.set('diffuse', 2.0); art.params.set('ambient', 0.3)")
  const withRelief = await screenshotPixels(page, 128)

  // Flatten the paint. Same colours, same marks, no height — so any difference
  // from here is the relief lighting and nothing else.
  await tweak(page, "art.params.set('heightScale', 0)")
  const flat = await screenshotPixels(page, 128)

  expect(frameDelta(withRelief, flat),
    'relief height changes nothing — the height channel is not reaching the finish pass')
    .toBeGreaterThan(2)
})

/**
 * The pass is anchored to the CANVAS: a mark's screen position is a pure
 * function of its cell index, so wherever the scene under it has not changed,
 * the paint must not move. Without that promise the whole frame crawls.
 */
test('the paint is stable while the scene is held still', async ({ page }) => {
  await boot(page)
  await paint(page)
  const a = await screenshotPixels(page, 128)
  // Force a redraw without touching the scene: an equal set changes nothing,
  // so move the stroke size away and back (each change thaws the hold).
  await tweak(page, "const c = art.params.get('cell'); art.params.set('cell', c + 1); art.params.set('cell', c)")
  const b = await screenshotPixels(page, 128)
  expect(frameDelta(a, b)).toBeLessThan(1)
})
