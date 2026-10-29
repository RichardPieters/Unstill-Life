import { test, expect } from '@playwright/test'
import { boot as bootApp, screenshotPixels, useRevealClock, advanceReveal } from './helpers.js'

// Every spec here reads the reveal at a stated point in its timeline, so the
// reveal runs on a manual clock (advanceReveal) instead of the wall clock: a
// loaded machine renders fewer frames but lands on exactly the same instant.
async function boot(page, opts) {
  const errors = await bootApp(page, opts)
  await useRevealClock(page)
  return errors
}

/**
 * The entrance animation (ArtPass.playReveal). Only reachable through the
 * debug-panel checkbox — every other way of turning the pass on (tests,
 * scene-snapshot restore) snaps straight to fully painted, which
 * art_pass.spec.js already covers.
 *
 * The interesting failure mode here is not a compile error, it is a FROZEN
 * animation: the render loop skips all GPU work while the sim is paused
 * unless something says a frame is needed, and this pass reads a wall clock
 * every render() call rather than every tick. If the pause-skip in main.js
 * ever stopped checking `artPass.isRevealPlaying()`, the checkbox would draw
 * exactly one frame — the click's own dirty flag — and hang there, which
 * looks identical to "the pass turned on" from a single screenshot. So every
 * case here reads the LIVE UNIFORM VALUE across advanced reveal time, the same
 * direct-uniform-access pattern terrain_reactive.spec.js already uses,
 * because that is the one thing a single frame cannot fake.
 */

const spawn = page => page.evaluate(() => window.__d.artPass.uniformValue('uRevealSpawn'))
const relief = page => page.evaluate(() => window.__d.artPass.uniformValue('uRevealRelief'))
const ground = page => page.evaluate(() => window.__d.artPass.uniformValue('uRevealGround'))
const weave = page => page.evaluate(() => window.__d.artPass.uniformValue('uRevealWeave'))
const lighten = page => page.evaluate(() => window.__d.artPass.uniformValue('uRevealLighten'))

/**
 * A short reveal, so the specs don't each burn several real seconds.
 *
 * revealPrimeDuration AND revealPrimeLighten default to 0 here — every test
 * below except the priming-specific ones was written against a mark-only
 * timeline. Zero duration alone is not enough: even an instantaneous priming
 * step still HOLDS uRevealLighten at whatever revealPrimeLighten is set to
 * for the rest of the reveal (that is the whole point of priming settling
 * rather than reverting), so leaving it at its shipped 0.35 default would
 * wash every mark-phase test toward the ground colour throughout — which is
 * exactly what happened the first time this was tried: it dragged the
 * measured local-contrast/variance numbers in three unrelated specs.
 * Priming's own tests override both explicitly.
 */
async function shortReveal(page, patch = {}) {
  await page.evaluate(p => {
    const a = window.__d.artPass
    a.params.set('revealDuration', 0.3)
    a.params.set('revealPrimeDuration', 0)
    a.params.set('revealPrimeLighten', 0)
    for (const [k, v] of Object.entries(p)) a.params.set(k, v)
  }, patch)
}

test('playing the reveal advances the spawn uniform from 0 to 1 over reveal time, then stops', async ({ page }) => {
  await boot(page)   // paused by default — the animation must survive that
  // A wider duration than the other specs use: this reads a MID-flight sample
  // against both a lower and an upper bound, and a fast reveal leaves too
  // little room between "obviously still running" and "obviously finished"
  // for a headless browser's own scheduling jitter to reliably land inside.
  await shortReveal(page, { revealDuration: 1.2 })

  await page.evaluate(() => window.__d.artPass.playReveal())
  const start = await spawn(page)
  expect(start).toBeLessThan(0.15)

  await advanceReveal(page, 500)
  const mid = await spawn(page)
  expect(mid, 'no progress while the sim is paused — the pause-skip is not honouring isRevealPlaying()')
    .toBeGreaterThan(start)
  expect(mid).toBeLessThan(1)

  await advanceReveal(page, 1000)
  expect(await spawn(page)).toBe(1)

  // Finished must mean FINISHED: a stray timer still nudging the uniform would
  // not show up in one reading, only in a second one taken later.
  await advanceReveal(page, 300)
  expect(await spawn(page)).toBe(1)
  expect(await page.evaluate(() => window.__d.artPass.isRevealPlaying())).toBe(false)
})

test('relief trails the marks rather than rising with them', async ({ page }) => {
  await boot(page)
  // A longer reveal here, not a shorter one: this reads two live uniforms in
  // sequence at roughly the halfway point, and against a fast reveal a
  // headless browser's own scheduling jitter is large enough, relative to the
  // window this needs to land inside, to occasionally land ON the finish line.
  await shortReveal(page, { revealDuration: 1.2 })
  await page.evaluate(() => window.__d.artPass.playReveal())
  await advanceReveal(page, 500)   // comfortably inside a 1.2s reveal

  const { s, r } = await page.evaluate(() => ({
    s: window.__d.artPass.uniformValue('uRevealSpawn'),
    r: window.__d.artPass.uniformValue('uRevealRelief'),
  }))
  expect(s, 'test needs to catch it mid-flight').toBeGreaterThan(0)
  expect(s).toBeLessThan(1)
  expect(r, 'relief must not be ahead of the marks that carry it')
    .toBeLessThan(s)
})

test('"underpaint before marks" finishes the ground well before the marks do', async ({ page }) => {
  await boot(page)
  // Same reasoning as the relief test above: a longer reveal gives the
  // "past the ground beat, well short of the marks finishing" window enough
  // real width that scheduling jitter cannot land the read past either edge.
  await shortReveal(page, { revealDuration: 1.2, revealUnderpaintFirst: true, revealGroundBeat: 0.15 })
  await page.evaluate(() => window.__d.artPass.playReveal())
  await advanceReveal(page, 400)   // ~33% into 1.2s — past the 15% ground beat, short of the end

  const { s, g } = await page.evaluate(() => ({
    s: window.__d.artPass.uniformValue('uRevealSpawn'),
    g: window.__d.artPass.uniformValue('uRevealGround'),
  }))
  expect(s).toBeLessThan(0.8)
  expect(g, 'the ground beat did not finish ahead of the marks').toBe(1)
})

/**
 * With underpaint-first OFF, the ground must come LAST: it holds at the live
 * frame while marks arrive across almost the whole reveal, and only settles
 * into its configured look in a short closing beat. Read at two points —
 * comfortably before that beat starts, and comfortably after the reveal ends
 * — rather than pinning a single mid-flight value, since the closing beat's
 * exact width is itself a tuned slider.
 */
test('ground revealed last: it holds back while marks arrive, then settles at the very end', async ({ page }) => {
  await boot(page)
  await shortReveal(page, { revealDuration: 1.2, revealUnderpaintFirst: false, revealGroundBeat: 0.15 })
  await page.evaluate(() => window.__d.artPass.playReveal())

  // Well before the closing 15% beat: ground must still be untouched while
  // marks are already well underway.
  await advanceReveal(page, 600)
  const { s: sMid, g: gMid } = await page.evaluate(() => ({
    s: window.__d.artPass.uniformValue('uRevealSpawn'),
    g: window.__d.artPass.uniformValue('uRevealGround'),
  }))
  expect(sMid, 'test needs to catch it mid-flight').toBeGreaterThan(0.2)
  expect(gMid, 'ground moved before its closing beat — it is not being held back').toBe(0)

  await advanceReveal(page, 700)   // past the end of a 1.2s reveal
  expect(await ground(page)).toBe(1)
})

/**
 * Setting `.enabled` directly must NOT trigger the animation — every existing
 * render-gate test relies on this. A single frame right after enabling has to
 * already be the finished picture.
 */
test('setting .enabled directly skips the animation entirely', async ({ page }) => {
  await boot(page)
  await page.evaluate(() => { window.__d.artPass.enabled = true; window.__d.markDirty() })
  await advanceReveal(page, 200)
  expect(await spawn(page)).toBe(1)
  expect(await page.evaluate(() => window.__d.artPass.isRevealPlaying())).toBe(false)
})

/**
 * A real, if short, end-to-end look: the reveal must actually introduce
 * visible marks over the frame it started from.
 *
 * NOT a partial-vs-finished comparison — with tiny marks close to their target
 * colour (the shipped defaults), the difference between 50% and 100% painted
 * is genuinely subtle at a coarse sample, for the same reason art_pass.spec.js
 * had to stop comparing a fully painted frame to the unpainted one by raw
 * pixel delta: the colour engine's whole point is that a painted patch's mean
 * returns to the colour it replaced. What is NOT subtle is the true starting
 * point — no pass, no marks at all — against partway through the reveal, so
 * that is the comparison this makes, via LOCAL CONTRAST (adjacent-pixel
 * difference): the unpainted frame is smooth photography, the partway frame
 * already has real mark edges in it.
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

test('the reveal visibly introduces marks over the unpainted frame', async ({ page }) => {
  await boot(page)
  const before = await screenshotPixels(page, 512)   // no pass, no marks

  await shortReveal(page)
  await page.evaluate(() => window.__d.artPass.playReveal())
  await advanceReveal(page, 150)   // roughly half of a 300ms reveal
  const partway = await screenshotPixels(page, 512)

  const c0 = localContrast(before, 512)
  const c1 = localContrast(partway, 512)
  expect(c1, `local contrast did not rise once marks began landing (${c0.toFixed(2)} -> ${c1.toFixed(2)})`)
    .toBeGreaterThan(c0 * 1.1)
})

/**
 * The whole point of the growth field (artGrowthRelax.frag,
 * sampled in artPaint.frag): early in the reveal, painted area should form ONE
 * connected region that is mostly painted near its centre and untouched
 * elsewhere, rather than a fine, even sprinkle. That is a claim about SPATIAL
 * CLUSTERING, not about how much has painted overall — a scattered draw and a
 * growing one cover different amounts at the same moment (measured: ~0.2 of
 * the frame grown vs ~0.4 scattered at 40%) and the comparison must not care.
 *
 * Measured on WHICH PIXELS A MARK OWNS, read straight off the paint pass's id
 * attachment (artPaint.frag's fragId: NO_STROKE_ID = -1 where no spawned mark
 * covers the pixel), not on how rough the screenshot looks. The mask is cut
 * into blocks and scored by the normalised block variance
 *
 *     D = var(block coverage) / (m * (1 - m)),   m = overall coverage
 *
 * — the share of the mask's own pixel variance that survives averaging into
 * blocks. 1 = every block is all-or-nothing (the painted area forms patches
 * larger than a block); near 0 = every block is equally covered (an even
 * sprinkle). m(1-m) is the most a binary mask's block variance can be, so
 * dividing by it puts two masks of different coverage on the same 0..1 scale.
 * It measures clustering at block scale only: it does not prove the patch is
 * ONE region, nor that it started at the seed.
 *
 * This replaces a screenshot statistic (variance of per-block local contrast)
 * that had stopped measuring the reveal at all: the unpainted frame alone
 * scored 4.8 on it, the painting moved it by under 1, and that change tracked
 * how MUCH had painted, not where — so the scatter, having painted twice the
 * area, read as "patchier" than the growth even though by eye (and by this
 * mask) the growth is one clear region and the scatter an even sprinkle.
 */
const PAINTED_BLOCKS = 8   // per axis: 1/8 of the frame, well under the grown region's size

const paintedClustering = page => page.evaluate(K => {
  const { THREE, renderer, artPass: a } = window.__d
  const src = a.paintTarget
  const w = src.width, h = src.height
  // The id lives in the paint target's SECOND attachment, which
  // readRenderTargetPixels cannot address — blit it to a float target first
  // (float, because the "no mark" sentinel is negative).
  const rt = new THREE.WebGLRenderTarget(w, h, { type: THREE.FloatType, depthBuffer: false })
  a.copyTexture(renderer, src.textures[1], rt)
  const buf = new Float32Array(w * h * 4)
  renderer.readRenderTargetPixels(rt, 0, 0, w, h, buf)
  renderer.setRenderTarget(null)
  rt.dispose()

  const cov = []
  for (let by = 0; by < K; by++) {
    for (let bx = 0; bx < K; bx++) {
      const x0 = Math.floor(bx * w / K), x1 = Math.floor((bx + 1) * w / K)
      const y0 = Math.floor(by * h / K), y1 = Math.floor((by + 1) * h / K)
      let painted = 0
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) if (buf[(y * w + x) * 4] >= 0) painted++
      }
      cov.push(painted / ((x1 - x0) * (y1 - y0)))
    }
  }
  const m = cov.reduce((s, c) => s + c, 0) / cov.length
  const v = cov.reduce((s, c) => s + (c - m) ** 2, 0) / cov.length
  return { coverage: m, D: v / Math.max(m * (1 - m), 1e-9) }
}, PAINTED_BLOCKS)

test('early in the reveal, growth clusters into patches rather than scattering evenly', async ({ page }) => {
  await boot(page)

  const captureEarly = async (jitter) => {
    // Stroke size left at its shipped value, which is the slider's largest:
    // bigger marks mean fewer independent draws per block, so that is where
    // scatter reads LEAST even — the hardest case for this comparison.
    // Reach and sample time chosen so the grown region covers a substantial
    // fraction of the frame at the moment this samples it — not so small that
    // it is a speck, and not so large that it has already reached every
    // corner (which reads as even coverage, the very thing this test is
    // trying to tell apart from scatter). Bias 0 so the only thing that
    // differs between the two captures is growth vs independent draw.
    //
    // Blocking in OFF: its beat draws silhouette marks by hash in BOTH
    // captures, and a ridge line of those alone is clustered enough at block
    // scale to pass this test with the growth field completely broken (an
    // unreached field gives every other mark birth 1). With it off, a broken
    // field paints nothing and fails the coverage guard below instead.
    await shortReveal(page, {
      revealDuration: 1.2, revealGrowthJitter: jitter, revealBias: 0,
      revealGrowthReach: 400, revealEdgesFirst: false,
    })
    await page.evaluate(() => window.__d.artPass.playReveal())
    await advanceReveal(page, 480)   // ~40% into a 1.2s reveal
    return { ...(await paintedClustering(page)), spawn: await spawn(page) }
  }

  const grown = await captureEarly(0)       // pure smooth growth field
  const scattered = await captureEarly(1)   // pure independent-per-mark draw

  // Both must be caught mid-flight, read off the reveal's own progress: a
  // finished frame still leaves lattice gaps, so coverage alone cannot say so.
  // And D is undefined for an empty mask, which is also what a growth field
  // that reaches nowhere would leave.
  for (const [name, s] of [['growth', grown], ['scatter', scattered]]) {
    expect(s.spawn, `${name} must be caught mid-flight`).toBeGreaterThan(0)
    expect(s.spawn, `${name} must be caught mid-flight`).toBeLessThan(1)
    expect(s.coverage, `${name} has painted nothing by 40% of the reveal`).toBeGreaterThan(0.02)
  }
  // Measured 0.70–0.73 vs 0.022 (~32x) at the shipped stroke size; run-to-run
  // spread is about ±0.02 on the growth side. 4x is a margin on an ordering,
  // far outside that noise — not a tuned value.
  expect(grown.D, `growth (D ${grown.D.toFixed(3)}) is not more clustered than scatter (D ${scattered.D.toFixed(3)})`)
    .toBeGreaterThan(scattered.D * 4)
})

/**
 * Blocking in (artPaint.frag's uRevealEdgesFirst branch): the reveal opens by
 * DRAWING — for the first `blocking-in beat` only marks lying hard against an
 * occlusion edge may spawn, and the mass is held back until that is over.
 *
 * Measured as DISTANCE TO THE FINISHED PICTURE, not as contrast against the
 * unpainted frame. Contrast-against-unpainted mostly measures whether the pass
 * is switched on at all — the ground, the weave and the finish shading change
 * the whole frame the moment it is, and that swamps the handful of marks a
 * beat has placed (measured: 5.69 vs 5.66 between the two cases, i.e. nothing).
 * The finished picture carries that same ground, so comparing against IT
 * cancels it and what is left is genuinely "how many marks have landed yet".
 *
 * The canvas SURFACE is the exception that does not cancel, and both tests
 * below hold it at zero for that reason — see withoutCanvasSurface.
 */
const distanceToFinished = (a, b) => {
  let sum = 0, n = 0
  for (let i = 0; i < a.length; i += 4) {
    for (let c = 0; c < 3; c++) { sum += Math.abs(a[i + c] - b[i + c]); n++ }
  }
  return sum / n
}

/**
 * Take the canvas surface out of the measurement.
 *
 * distanceToFinished works by cancelling whatever both frames share — but the
 * canvas surface is not shared evenly between them. uCrevice darkens in
 * proportion to how much BARE canvas a frame has, and a barely-painted frame is
 * almost all bare while the finished one is almost none. That term therefore
 * pulls a sparse frame TOWARD the finished picture — the exact opposite of the
 * signal these tests read, and strong enough on its own to erase it (measured
 * 22.75 vs 22.80 between blocking-in and straight, i.e. nothing).
 *
 * These tests are about WHERE MARKS LAND, so the surface under them is a
 * confounder to hold fixed rather than a thing to measure. It was inert until
 * uExitFade got its correct rest value (artPassReveal.js's reset), which is why
 * the metric above read clean when it was first written.
 */
async function withoutCanvasSurface(page) {
  await page.evaluate(() => {
    const a = window.__d.artPass
    a.params.set('weave', 0)
    a.params.set('crevice', 0)
    a.params.set('highKey', 0)
  })
}

/** The fully painted picture: enabling directly skips the animation. */
async function finishedFrame(page) {
  await page.evaluate(() => { window.__d.artPass.enabled = true; window.__d.markDirty() })
  await advanceReveal(page, 400)
  const px = await screenshotPixels(page, 256)
  await page.evaluate(() => { window.__d.artPass.enabled = false; window.__d.markDirty() })
  await advanceReveal(page, 150)
  return px
}

async function revealThen(page, patch, waitMs) {
  await shortReveal(page, patch)
  await page.evaluate(() => window.__d.artPass.playReveal())
  await advanceReveal(page, waitMs)
  return screenshotPixels(page, 256)
}

/** Mean |RGB difference| between two frames — how far apart two pictures are. */
const frameDistance = distanceToFinished

test('blocking in changes which marks land, and only during its own beat', async ({ page }) => {
  await boot(page)

  // ~19% into the reveal is comfortably inside a 35% beat; 1100ms is past it.
  const opts = { revealDuration: 1.2, revealEdgeBeat: 0.35 }
  const at = (edgesFirst, ms) => revealThen(page, { ...opts, revealEdgesFirst: edgesFirst }, ms)

  // The floor is MEASURED, not chosen: two identical runs still differ a little
  // (which marks have grown by the exact wall-clock moment the shot lands), and
  // a hardcoded threshold here would be a tuning number that goes red on a
  // slower machine rather than on a real regression.
  const noise = frameDistance(await at(true, 250), await at(true, 250))

  const during = frameDistance(await at(true, 250), await at(false, 250))
  const after  = frameDistance(await at(true, 1100), await at(false, 1100))

  // Blocking in is a REORDERING, not a withholding: during its beat it puts
  // marks somewhere else (hard against the occlusion edges) than a straight
  // reveal would, and once the beat is over both have placed the same marks.
  //
  // This replaces an assertion that blocking in left the picture measurably
  // LESS painted — further from the finished frame. That stopped being true
  // when the reveal became seed-grown (0cf2705) and the darks/edges stages were
  // decoupled (00c838b), both of which landed after this spec was last touched:
  // the growth front now governs how much has been painted, and edges-first
  // only reorders arrival within it. Measured, the old signal is gone outright
  // (17.90 vs 17.88 from finished), while the reordering below is ~11x the
  // run-to-run floor — so this asserts the effect that actually exists.
  expect(during, `blocking in placed the same marks as a straight reveal (${during.toFixed(2)} vs a ${noise.toFixed(2)} noise floor)`)
    .toBeGreaterThan(Math.max(noise * 2, 0.4))
  expect(after, `the two reveals had not converged after the beat (${after.toFixed(2)}, during the beat ${during.toFixed(2)})`)
    .toBeLessThan(during * 0.5)
})

test('the blocking-in depth limit takes distant edges out of the drawing stage', async ({ page }) => {
  await boot(page)

  const opts = { revealDuration: 1.2, revealEdgeBeat: 0.35, revealEdgesFirst: true }
  const at = (limit, ms) => revealThen(page, { ...opts, revealEdgeMaxDepth: limit }, ms)

  const noise = frameDistance(await at(1, 250), await at(1, 250))
  const during = frameDistance(await at(1, 250), await at(0.05, 250))

  // A limit near the camera leaves almost every edge to the growth, so the
  // drawing beat places different marks than with every edge allowed.
  expect(during, `the depth limit changed nothing (${during.toFixed(2)} vs a ${noise.toFixed(2)} noise floor)`)
    .toBeGreaterThan(Math.max(noise * 2, 0.4))
})

test('the blocking-in stage is a beat, not a permanent restriction', async ({ page }) => {
  await boot(page)
  await withoutCanvasSurface(page)
  const finished = await finishedFrame(page)

  const opts = { revealDuration: 1.2, revealEdgeBeat: 0.35, revealEdgesFirst: true }
  const duringBeat = distanceToFinished(await revealThen(page, opts, 250), finished)
  const afterBeat = distanceToFinished(await revealThen(page, opts, 900), finished)

  expect(afterBeat, `the mass never arrived after the drawing beat (${duringBeat.toFixed(2)} -> ${afterBeat.toFixed(2)} from finished)`)
    .toBeLessThan(duringBeat * 0.75)
})

/**
 * Priming — the step BEFORE any mark exists (artPass.js's _tickReveal).
 *
 * Sequential with the marks step, not concurrent: uRevealSpawn must stay at
 * exactly 0 for the whole priming window, and the weave/lighten uniforms must
 * hold at their settled values once priming ends rather than reverting — a
 * primed canvas stays toned while it is painted, it does not un-prime the
 * moment the first mark lands.
 */
test('priming finishes before any mark spawns, and the marks step starts only after', async ({ page }) => {
  await boot(page)
  await page.evaluate(() => {
    const a = window.__d.artPass
    a.params.set('revealPrimeDuration', 0.5)
    a.params.set('revealPrimeLighten', 0.4)
    a.params.set('revealDuration', 0.5)
  })

  await page.evaluate(() => window.__d.artPass.playReveal())
  await advanceReveal(page, 250)   // partway through the 0.5s priming step
  const mid = await page.evaluate(() => ({
    weave: window.__d.artPass.uniformValue('uRevealWeave'),
    lighten: window.__d.artPass.uniformValue('uRevealLighten'),
    spawn: window.__d.artPass.uniformValue('uRevealSpawn'),
  }))
  expect(mid.spawn, 'a mark spawned during priming').toBe(0)
  expect(mid.weave, 'weave should be partway in').toBeGreaterThan(0)
  expect(mid.weave, 'weave should not be fully in yet').toBeLessThan(1)
  expect(mid.lighten, 'lighten should be partway to its ceiling').toBeGreaterThan(0)
  expect(mid.lighten, 'lighten overshot its own ceiling').toBeLessThanOrEqual(0.4 + 1e-6)

  await advanceReveal(page, 650)   // past priming (0.5s) and partway into marks (0.5s)
  const later = await page.evaluate(() => ({
    weave: window.__d.artPass.uniformValue('uRevealWeave'),
    lighten: window.__d.artPass.uniformValue('uRevealLighten'),
    spawn: window.__d.artPass.uniformValue('uRevealSpawn'),
  }))
  expect(later.spawn, 'marks should be underway once priming has finished').toBeGreaterThan(0)
  expect(later.weave, 'weave must hold at 1 once settled, not revert').toBe(1)
  expect(later.lighten, 'lighten must hold at its ceiling once settled, not revert')
    .toBeCloseTo(0.4, 5)
})

test('a zero-length priming step skips straight to the marks', async ({ page }) => {
  await boot(page)
  await page.evaluate(() => {
    const a = window.__d.artPass
    a.params.set('revealPrimeDuration', 0)
    a.params.set('revealDuration', 1.0)
  })
  await page.evaluate(() => window.__d.artPass.playReveal())
  await advanceReveal(page, 200)
  const s = await spawn(page)
  expect(s, 'marks did not start promptly when priming was skipped').toBeGreaterThan(0)
})

/**
 * The lightening wash is a CEILING, not the amount itself: raising the slider
 * must raise how far the settled wash goes, proportionally.
 */
test('the lightening ceiling scales the settled wash proportionally', async ({ page }) => {
  await boot(page)

  const settledLighten = async (ceiling) => {
    await page.evaluate(v => {
      const a = window.__d.artPass
      a.params.set('revealPrimeDuration', 0.2)
      a.params.set('revealPrimeLighten', v)
      a.params.set('revealDuration', 1.0)
    }, ceiling)
    await page.evaluate(() => window.__d.artPass.playReveal())
    await advanceReveal(page, 500)   // well past a 0.2s priming step
    return lighten(page)
  }

  expect(await settledLighten(0.2)).toBeCloseTo(0.2, 5)
  expect(await settledLighten(0.8)).toBeCloseTo(0.8, 5)
})

/**
 * The exit's stroke count is read back asynchronously, and three.js leaves the
 * read's pixel-pack buffer bound until the GPU answers, frames later. Every
 * synchronous readback in that window fails (WebGL INVALID_OPERATION) and
 * leaves its buffer zeroed. A reveal starting then (attention rising again
 * during or right after an exit) read back zeroed birth tables: every stroke
 * anchored at pixel (0, 0), so none were on screen until something forced a
 * full redraw. Asserted at the source: nothing is left bound once the count
 * call returns.
 */
test('the exit count leaves no pixel-pack buffer bound', async ({ page }) => {
  await boot(page)
  const bound = await page.evaluate(async () => {
    const a = window.__d.artPass
    const gl = window.__d.renderer.getContext()
    const seen = []
    const original = a._hold.countRemoved.bind(a._hold)
    a._hold.countRemoved = (...args) => {
      const r = original(...args)
      seen.push(gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING) !== null)
      return r
    }
    a.params.set('exitDuration', 1)
    a.enabled = true
    window.__d.markDirty()
    await new Promise(r => requestAnimationFrame(r))
    a.playExit()
    for (let i = 0; i < 4; i++) {
      window.__d.markDirty()
      await new Promise(r => requestAnimationFrame(r))
    }
    a._hold.countRemoved = original
    return seen
  })
  expect(bound.length, 'the exit never counted its strokes').toBeGreaterThan(0)
  expect(bound.some(b => b), 'a pixel-pack buffer was left bound after the exit count').toBe(false)
})

/**
 * Every draw of the pass is accepted by WebGL. A ping-pong pass whose sampler
 * is left bound to its own target forms a feedback loop, and WebGL silently
 * drops that draw (INVALID_OPERATION): the edge field's seeding draw did, at
 * prepass resolutions with an even flood step count, and the flood then spread
 * the previous frame's edges. Several frame sizes, so both parities are hit.
 */
test('every art-pass draw succeeds, whatever the frame size', async ({ page }) => {
  await boot(page)
  for (const [w, h] of [[1600, 900], [1000, 1000], [1300, 777]]) {
    await page.setViewportSize({ width: w, height: h })
    const failed = await page.evaluate(async () => {
      const a = window.__d.artPass, gl = window.__d.renderer.getContext(), out = []
      gl.getError()
      // onDraw runs before each draw, so an error seen there belongs to the draw before.
      let last = 'start'
      a.onDraw = name => { if (gl.getError()) out.push(last); last = name }
      a.enabled = true
      a.playReveal()
      for (let i = 0; i < 4; i++) { window.__d.markDirty(); await new Promise(r => requestAnimationFrame(r)) }
      a.onDraw = null
      a.enabled = false
      window.__d.markDirty()
      return out
    })
    expect(failed, `draws rejected by WebGL at ${w}x${h}`).toEqual([])
  }
})
