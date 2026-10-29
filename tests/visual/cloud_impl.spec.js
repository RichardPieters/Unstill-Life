/**
 * cloud_impl.spec.js — the baked-volume cloud implementation actually draws
 * clouds.
 *
 * The baked-volume path is invisible to `vite build`: it needs a half-float 3D
 * render target, per-layer framebuffer attachment and a sampler3D fetch, none
 * of which exist until a real GL context runs them. A silent failure anywhere
 * in that chain yields a perfectly valid-looking frame that simply has no
 * clouds in it.
 *
 * MEASURED AT THE SOURCE, deliberately. Two earlier versions of this spec
 * judged clouds from the composited canvas and both passed while the volume
 * drew nothing:
 *   - comparing the two implementations (back when there were two): "the
 *     clouds vanished" is itself a large difference, so a blank volume
 *     looked like a working one;
 *   - comparing against a clouds-OFF baseline: disabling the pass changes
 *     which pass renders to screen, shifting the entire frame by more than the
 *     clouds ever do — and an unpaused sim keeps the landscape moving between
 *     captures on top of that.
 * Reading the cloud pass's own render target sidesteps all of it: alpha there
 * is the cloud, and nothing else can put it there.
 *
 * Most cases run UNPAUSED: main.js skips every GPU stage on a paused frame that
 * nothing marked dirty, so a paused page reports whatever was in the RT
 * beforehand unless it draws through waitFrames (whose markDirty forces the
 * frame). Unpaused has its own trap: the sim re-freezes a few seconds after
 * boot (sooner in wall time the busier the machine), the world then holds
 * still, and the cloud march only re-runs when something marks it dirty —
 * which a march-only setter (Sint, powder, detail, weather strength,
 * planet curve, debug view) does not. So every in-page frame wait below calls
 * markDirty first, exactly as waitFrames does; without it these cases compared
 * two reads of the same stale RT whenever the freeze landed first.
 */
import { test, expect } from '@playwright/test'
import { boot, waitFrames } from './helpers.js'

/** Mean alpha of the cloud RT over the sky band, 0..1. */
/**
 * Put real cloud in the sky before measuring cloud behaviour.
 *
 * The shipped uCoverage default is 2.86, which is a deliberately EMPTY sky: the
 * weather walk owns cloud amount now and drives coverage down from that clear
 * end as overcast rises. Measuring the cloud pipeline against the
 * default therefore measures almost nothing — mean alpha 0.013 — and every
 * "did this change the cloud" assertion in this file degenerates.
 *
 * These cases are about the cloud implementation, not about the shipped
 * weather, so they establish their own sky. 1.16 is the coverage the file was
 * originally written against.
 */
const CLOUD_TEST_COVERAGE = 1.16
const seedCloud = page => page.evaluate(c => {
  // The weather MUST go first. It is on and walking by default and it
  // drives uCoverage every tick, so a hand-set coverage is overwritten before
  // the next frame — which is the failure mode that made four cases in this
  // file measure an empty sky rather than the thing they name.
  window.__d.atmosphere.params.set('walking', false)
  window.__d.atmosphere.params.set('enabled', false)
  window.__d.clouds.params.set('coverage', c)
  window.__d.clouds.snapEases()     // the cloud amount eases; these cases measure the settled sky
}, CLOUD_TEST_COVERAGE)

const cloudAlpha = page => page.evaluate(() =>
  window.__cloudRead.alpha())

test('the baked volume puts cloud into its render target', async ({ page }) => {
  const errors = await boot(page, { pause: false })
  await seedCloud(page)
  const supported = await page.evaluate(() => {
    window.__d.clouds.params.set('enabled', true)
    return window.__d.clouds.isSupported()
  })
  test.skip(!supported, 'GPU cannot render to a half-float 3D target')

  await waitFrames(page, 40)   // bake + a full light refresh cycle
  const volume = await cloudAlpha(page)
  console.log('volume cloud-RT alpha:', volume.toFixed(4))
  expect(volume, 'baked-volume implementation wrote no alpha').toBeGreaterThan(0.01)

  const gl = errors.filter(e => /shader|glsl|program|compile|link|framebuffer/i.test(e))
  expect(gl, `GL diagnostics:\n${gl.join('\n')}`).toHaveLength(0)
})

/**
 * The guard that makes the test above meaningful: thresholding the field out
 * must drive the measurement to zero. Without this, "alpha > 0.01" could be
 * satisfied by anything that happens to sit in the render target.
 */
test('the volume measurement responds to the field being thresholded away', async ({ page }) => {
  await boot(page, { pause: false })
  await seedCloud(page)
  const supported = await page.evaluate(() => {
    window.__d.clouds.params.set('enabled', true)
    return window.__d.clouds.isSupported()
  })
  test.skip(!supported, 'GPU cannot render to a half-float 3D target')
  await waitFrames(page, 40)
  const drawn = await cloudAlpha(page)

  // Coverage far above anything the field reaches: density is max(fbm*scale -
  // coverage, 0), so this is zero everywhere by construction.
  await page.evaluate(() => { window.__d.clouds.params.set('coverage', 50); window.__d.clouds.snapEases() })
  await waitFrames(page, 40)
  const blank = await cloudAlpha(page)

  console.log('volume alpha drawn / thresholded:', drawn.toFixed(4), '/', blank.toFixed(4))
  expect(blank).toBeLessThan(drawn / 10)
})

/** Every layer of a 3D volume target, read back as float RGBA (in-page helper source). */
const READ_VOL_SRC = `(rt) => {
  const { renderer } = window.__d
  const gl = renderer.getContext()
  const N = rt.width, out = []
  const buf = new Float32Array(N * N * 4)
  for (let l = 0; l < 32; l++) {
    renderer.setRenderTarget(rt, l)
    gl.readPixels(0, 0, N, N, gl.RGBA, gl.FLOAT, buf)
    out.push(buf.slice())
  }
  renderer.setRenderTarget(null)
  return out
}`

/**
 * Moving the frequency anchor must not move the clouds.
 *
 * Recentring the anchor translates `(p - A) * f` by the anchor's step, which
 * would jump every cloud a couple of hundred units at once. The bake carries a phase that _moveAnchor
 * shifts by the same step times the frequency, so `(p - A) * f + phase` holds.
 *
 * Checked on the shape volume itself: re-bake after moving the anchor a long
 * way, and compare with the bake before. Only float rounding may differ (the
 * phase is a sum of float32 products, amplified by up to lacunarity^octaves);
 * the bound is measured against the effect of the bug, which is the field
 * moving by hundreds of units — the same move WITHOUT the phase is the control.
 */
test('moving the frequency anchor leaves the cloud field where it is', async ({ page }) => {
  await boot(page)
  await seedCloud(page)
  const supported = await page.evaluate(() => {
    window.__d.clouds.params.set('enabled', true)
    return window.__d.clouds.isSupported()
  })
  test.skip(!supported, 'GPU cannot render to a half-float 3D target')
  await waitFrames(page, 10)

  const r = await page.evaluate(src => {
    const readVol = eval(src)
    const { renderer } = window.__d
    const v = window.__d.clouds
    const u = v._bakeMaterial.uniforms
    const maxDiff = (a, b) => {
      let m = 0
      for (let l = 0; l < a.length; l++) for (let i = 0; i < a[l].length; i += 4) m = Math.max(m, Math.abs(a[l][i] - b[l][i]))
      return m
    }
    v._fullRebake(renderer)
    const before = readVol(v._shapeRT)
    const a0 = u.uFreqAnchor.value.clone()

    // With the phase: move the anchor 600 units, re-bake the shape.
    v._moveAnchor(a0.x + 600, a0.y - 450)
    v._bakeShape(renderer)
    const moved = maxDiff(before, readVol(v._shapeRT))

    // Control, the old behaviour: move the anchor alone.
    u.uFreqAnchor.value.set(a0.x - 600, a0.y + 450)
    v._bakeShape(renderer)
    const control = maxDiff(before, readVol(v._shapeRT))
    v._fullRebake(renderer)
    return { moved, control }
  }, READ_VOL_SRC)
  console.log('anchor move, max |shape change| — with phase / anchor alone:', JSON.stringify(r))

  expect(r.control, 'the control did not move the field — the comparison proves nothing').toBeGreaterThan(0.5)
  expect(r.moved).toBeLessThan(r.control / 100)
})

/**
 * A small scatter step (the form walker moves it every tick) must not re-bake
 * the whole volume. It rolls: a few shape layers per frame, the window content
 * kept. Once the roll has finished, the volume must equal a full re-bake at the
 * same settings — a roll that skipped or double-baked a layer would not.
 */
test('a small frequency step rolls the shape volume instead of re-baking it whole', async ({ page }) => {
  await boot(page, { pause: false })
  await seedCloud(page)
  const supported = await page.evaluate(() => {
    window.__d.clouds.params.set('enabled', true)
    window.__d.clouds.params.set('cloudSpeed', 0)
    window.__d.clouds.params.set('weatherSpeed', 0)
    window.__d.formWalker.params.set('enabled', false)
    return window.__d.clouds.isSupported()
  })
  test.skip(!supported, 'GPU cannot render to a half-float 3D target')
  await waitFrames(page, 40)

  const r = await page.evaluate(async src => {
    const readVol = eval(src)
    const { renderer } = window.__d
    const v = window.__d.clouds
    const frame = () => new Promise(res => { window.__d.markDirty(); requestAnimationFrame(res) })
    let fullBakes = 0
    const orig = v._fullRebake.bind(v)
    v._fullRebake = rr => { fullBakes++; orig(rr) }

    const f0 = v.params.get('baseFreq')
    v.params.set('baseFreq', f0 * 1.00002)            // walker-sized step
    v.snapEases()                                     // past the per-frame cap: the roll itself is under test
    const pendingRightAfter = v.getDiagnostics().shapePending
    let frames = 0
    while (v.getDiagnostics().shapePending > 0 && frames < 200) { await frame(); frames++ }
    await frame()
    const smallStepFullBakes = fullBakes
    const rolled = readVol(v._shapeRT)
    orig(renderer)
    const full = readVol(v._shapeRT)
    let mismatched = 0
    for (let l = 0; l < rolled.length; l++) for (let i = 0; i < rolled[l].length; i++) if (rolled[l][i] !== full[l][i]) mismatched++

    // A big jump (a hand-drag across the dial) stays atomic.
    v.params.set('baseFreq', f0 * 1.5)
    v.snapEases()
    await frame(); await frame()
    const bigStepFullBakes = fullBakes - smallStepFullBakes
    v._fullRebake = orig
    v.params.set('baseFreq', f0)
    v.snapEases()
    return { pendingRightAfter, frames, smallStepFullBakes, mismatched, bigStepFullBakes }
  }, READ_VOL_SRC)
  console.log('rolling re-bake:', JSON.stringify(r))

  expect(r.pendingRightAfter, 'the small step did not start a roll').toBe(32)
  expect(r.smallStepFullBakes, 'the small step re-baked the whole volume').toBe(0)
  expect(r.frames).toBeGreaterThan(1)          // it really was spread over frames
  expect(r.mismatched, 'the finished roll differs from a full re-bake').toBe(0)
  expect(r.bigStepFullBakes, 'a big jump should re-bake atomically').toBeGreaterThan(0)
})

/**
 * Stage 2's entire correctness claim: refreshing only the texels that newly
 * entered the window must leave the volumes exactly as a full re-bake would.
 *
 * Compared on the VOLUMES THEMSELVES (every layer of the shape and light
 * targets read back), not on a rendered frame: a stale cell anywhere in the
 * window shows up here whether or not any camera can see it — including the
 * downsun light padding (lightPad), which a screen-space check could not reach.
 *
 * Against a PLAIN full re-bake. The frequency anchor (uFreqAnchor) follows the
 * window on every re-anchor, with a compensating phase so the field never
 * moves (see the next test) — so both paths bake the same field.
 *
 * Mutation-checked: skipping the shape rectangles or the light rectangles
 * during the walk leaves ~1.5M of the 2.1M texels wrong; the real path leaves 0.
 */
test('incremental edge updates match a full re-bake exactly', async ({ page }) => {
  await boot(page, { pause: false })
  await seedCloud(page)
  const supported = await page.evaluate(() => {
    window.__d.clouds.params.set('enabled', true)
    window.__d.clouds.params.set('cloudSpeed', 0)     // static field
    window.__d.clouds.params.set('weatherSpeed', 0)
    return window.__d.clouds.isSupported()
  })
  test.skip(!supported, 'GPU cannot render to a half-float 3D target')

  const r = await page.evaluate(async () => {
    const { THREE, renderer, flyCamera: fc, camera } = window.__d
    const v = window.__d.clouds
    const gl = renderer.getContext()
    const frame = () => new Promise(res => { window.__d.markDirty(); requestAnimationFrame(res) })
    const N = v._shapeRT.width, LAYERS = 32
    const readVol = rt => {
      const out = []
      const buf = new Float32Array(N * N * 4)
      for (let l = 0; l < LAYERS; l++) {
        renderer.setRenderTarget(rt, l)
        gl.readPixels(0, 0, N, N, gl.RGBA, gl.FLOAT, buf)
        out.push(buf.slice())
      }
      renderer.setRenderTarget(null)
      return out
    }
    // A tolerance, not bit equality: the anchor moved during the walk, so
    // resident cells were baked under an earlier (anchor, phase) pair and
    // entering cells under a later one — the same field, different float
    // rounding. Shape: 0.01 against values of order 1 (measured ~7e-4). Light:
    // a sum of up to `reach` units of density, so a shape rounding error e can
    // move it by at most e * densityScale * reach — that bound, derived from
    // the shape error actually measured. A stale or missing cell is off by
    // order 1 in shape and by tens to hundreds in light (mutation note above).
    const compare = (a, b, tol) => {
      let n = 0, worst = 0
      for (let l = 0; l < a.length; l++)
        for (let i = 0; i < a[l].length; i++) {
          const d = Math.abs(a[l][i] - b[l][i])
          worst = Math.max(worst, d)
          if (d > tol) n++
        }
      return { n, worst: +worst.toExponential(2), tol: +tol.toExponential(2) }
    }

    v.params.set('incremental', true)
    const base = { pos: [400, 140, -600], yaw: -2.4, pitch: -0.05 }
    v._bakedOrigin = null; v._shapeDirty = true   // start from a known full bake
    fc.setPose({ ...base, enabled: true })
    for (let i = 0; i < 30; i++) await frame()
    const origin0 = { ...v._origin }

    // Walk far enough that the window re-anchors (the origin only moves once
    // the camera nears the window margin) and edge cells actually enter.
    const dir = camera.getWorldDirection(new THREE.Vector3())
    let incrementalBakes = 0
    for (let i = 1; i <= 140; i++) {
      fc.setPose({ pos: [base.pos[0] + dir.x * i * 20, base.pos[1], base.pos[2] + dir.z * i * 20],
        yaw: base.yaw, pitch: base.pitch, enabled: true })
      await frame()
      if (v._lastRects > 0) incrementalBakes++
    }
    await frame(); await frame()
    const shapeInc = readVol(v._shapeRT), lightInc = readVol(v._litRT)

    v._fullRebake(renderer)
    const shapeFull = readVol(v._shapeRT), lightFull = readVol(v._litRT)

    let nonEmpty = 0
    for (const layer of shapeFull) for (let i = 0; i < layer.length; i += 4) if (layer[i] !== 0) nonEmpty++
    return {
      moved: v._origin.x !== origin0.x || v._origin.z !== origin0.z,
      incrementalBakes,
      nonEmpty,
      shape: compare(shapeInc, shapeFull, 0.01),
      light: compare(lightInc, lightFull, (() => {
        const lu = v._lightMaterial.uniforms
        const e = compare(shapeInc, shapeFull, Infinity).worst
        return Math.max(e, 1e-3) * v.params.get('densityScale') * lu.uLightSteps.value * lu.uLightStepSize.value
      })()),
    }
  })
  console.log('incremental vs full:', JSON.stringify(r))

  // Preconditions — the comparison is not trivially empty.
  expect(r.moved, 'the window never moved, so no edge cells entered').toBe(true)
  expect(r.incrementalBakes, 'every update took the full-rebake path').toBeGreaterThan(0)
  expect(r.nonEmpty).toBeGreaterThan(0)
  // The claim: identical up to float rounding.
  expect(r.shape.n).toBe(0)
  expect(r.light.n).toBe(0)
})

/**
 * Stage 3: the analytic detail is gated by what the MARCH can resolve, not by
 * what the author asks for.
 *
 * Detail is the baked fBM series continued past the octave the grid could
 * hold, summed in per march step. Samples along a ray sit one march step
 * apart, so they carry the same Nyquist limit the grid does with its cell
 * size — which means at a march step equal to the cell there is nothing to
 * add, and asking for detail there must yield none rather than shimmer.
 */
test('analytic detail is bounded by the march step, not requested', async ({ page }) => {
  await boot(page, { pause: false })
  await seedCloud(page)
  const supported = await page.evaluate(() => {
    window.__d.clouds.params.set('enabled', true)
    return window.__d.clouds.isSupported()
  })
  test.skip(!supported, 'GPU cannot render to a half-float 3D target')

  const octavesAtStep = step => page.evaluate(s => {
    const v = window.__d.clouds
    v.params.set('marchStepSize', s)
    return { detail: v.getDetailOctaves(), cell: v.getCellSize() }
  }, step)

  const cell = await page.evaluate(() => window.__d.clouds.getCellSize())
  const atCell = await octavesAtStep(cell)
  expect(atCell.detail, 'marching at the grid cell size can add no detail').toBe(0)

  // Each halving of the step buys resolvable octaves, and never loses one.
  let prev = 0
  for (const step of [cell / 2, cell / 4, cell / 8]) {
    const { detail } = await octavesAtStep(step)
    expect(detail).toBeGreaterThanOrEqual(prev)
    prev = detail
  }
  expect(prev, 'a fine march should resolve at least one detail octave').toBeGreaterThan(0)
})

// The march's empty-space skip (cloudsVolume.frag's detailBound and out-of-shell
// test) is claimed EXACT: it only skips work whose result is provably zero. So
// the cloud RT must be byte-identical with it on and off — not close, equal.
// Paused, wind and weather stopped, every light layer re-baked per frame, so
// two reads of the same state are themselves identical (checked as a premise).
test('the empty-space skip renders exactly the same clouds', async ({ page }) => {
  await boot(page, { pause: true })
  await seedCloud(page)
  const supported = await page.evaluate(() => {
    const v = window.__d.clouds
    window.__d.clouds.params.set('enabled', true)
    v.params.set('cloudSpeed', 0)
    v.params.set('weatherSpeed', 0)
    v.params.set('lightLayersPerFrame', 32)
    v.params.set('groundEase', 0)   // the ground shadow follows at once too
    return v.isSupported()
  })
  test.skip(!supported, 'GPU cannot render to a half-float 3D target')
  await waitFrames(page, 6)

  const result = await page.evaluate(async () => {
    const { clouds, renderer, markDirty } = window.__d
    const v = clouds
    const read = async skip => {
      v.params.set('emptySpaceSkip', skip > 0.5)
      for (let i = 0; i < 3; i++) {
        v._marchDirty = true
        markDirty()
        await new Promise(r => requestAnimationFrame(r))
      }
      const rt = v._cloudRT
      const px = new Uint8Array(rt.width * rt.height * 4)
      renderer.readRenderTargetPixels(rt, 0, 0, rt.width, rt.height, px)
      return px
    }
    const on = await read(1), off = await read(0), onAgain = await read(1)
    const differing = (a, b) => { let n = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++; return n }
    let cloudy = 0, clear = 0
    for (let i = 3; i < on.length; i += 4) on[i] > 0 ? cloudy++ : clear++
    return { skipVsNoSkip: differing(on, off), control: differing(on, onAgain),
             cloudy, clear, detailOctaves: v.getDetailOctaves() }
  })

  expect(result.control, 'two reads of the same state differ — the comparison below means nothing').toBe(0)
  expect(result.cloudy, 'no cloud in the RT — nothing for the skip to preserve').toBeGreaterThan(0)
  expect(result.clear, 'no clear sky in the RT — nothing for the skip to skip').toBeGreaterThan(0)
  expect(result.detailOctaves, 'no marched detail — the detail bound is not exercised').toBeGreaterThan(0)
  expect(result.skipVsNoSkip, 'empty-space skip changed the cloud image').toBe(0)
})

test('the detail slider visibly changes the cloud', async ({ page }) => {
  await boot(page, { pause: false })
  await seedCloud(page)
  const supported = await page.evaluate(() => {
    window.__d.clouds.params.set('enabled', true)
    window.__d.clouds.params.set('cloudSpeed', 0)
    window.__d.clouds.params.set('marchStepSize', 4)   // fine enough to resolve it
    // A viewpoint with cloud actually in frame. The default camera puts little
    // sky in the sampled band, and a silhouette change cannot be measured where
    // there is no silhouette.
    window.__d.flyCamera.setPose({ pos: [530.7, 120.0, -640.9], yaw: -2.5169, pitch: -0.12 })
    return window.__d.clouds.isSupported()
  })
  test.skip(!supported, 'GPU cannot render to a half-float 3D target')
  await waitFrames(page, 40)

  const shipped = await page.evaluate(() => window.__d.clouds.params.get('detailAmount'))

  const at = amount => page.evaluate(async a => {
    window.__d.clouds.params.set('detailAmount', a)
    for (let i = 0; i < 2; i++) { window.__d.markDirty(); await new Promise(r => requestAnimationFrame(r)) }
    return {
      mean: window.__cloudRead.stats().alpha,
      samples: window.__cloudRead.samples(),
    }
  }, amount)

  const off = await at(0)
  const on  = await at(shipped)     // the shipped default, not an arbitrary 1

  // PER-PIXEL, not the mean. Detail recarves cloud edges, which moves
  // individual pixels a great deal while barely shifting the average over a
  // mostly empty sky — the mean differed by 0.0002 here while the silhouette
  // plainly changed, so asserting on it would have been asserting on nothing.
  const diff = off.samples.reduce((a, v, i) => a + Math.abs(v - on.samples[i]), 0)
             / off.samples.length
  const changed = off.samples.filter((v, i) => Math.abs(v - on.samples[i]) > 8).length
             / off.samples.length
  console.log('detail amount:', shipped)
  console.log('detail off/on — mean alpha:', off.mean.toFixed(4), '/', on.mean.toFixed(4),
              '| per-pixel mean |diff|:', diff.toFixed(2),
              '| pixels changed:', (changed * 100).toFixed(1) + '%')

  // Wind is frozen and the camera has not moved, so nothing else could have
  // changed the silhouette. Detail sums into the field BEFORE the coverage
  // threshold, so it carves the outline rather than texturing a fixed one.
  expect(diff, 'the detail slider moved no pixels').toBeGreaterThan(1)
  expect(on.mean).toBeGreaterThan(0.01)
})

test('the baked volume reports a grid it can represent', async ({ page }) => {
  await boot(page, { pause: false })
  await seedCloud(page)
  const grid = await page.evaluate(() => ({
    cell: window.__d.clouds.getCellSize(),
    octaves: window.__d.clouds.getOctaves(),
  }))
  // Derived from the extent via the Nyquist limit, never authored. Zero octaves
  // would mean the bake was asked for a field its grid cannot hold.
  expect(grid.cell).toBeGreaterThan(0)
  expect(grid.octaves).toBeGreaterThanOrEqual(1)
})

// ── Shading-tail experiments ────────────────────
// Sint and powder both change ONLY the in-scatter (lightEnergy) accumulation,
// never the transmittance decay — so alpha (1 - transmittance) is an
// INDEPENDENT axis from colour/brightness here, and a real derivation-backed
// property to assert: toggling either must move colour while leaving alpha
// untouched. That is a falsifiable correctness claim, not a tuning
// threshold — if a future edit coupled either term into the transmittance
// update, this catches it.

test('Sint integration changes shading, never alpha', async ({ page }) => {
  await boot(page, { pause: false })
  await seedCloud(page)
  const supported = await page.evaluate(() => {
    window.__d.clouds.params.set('enabled', true)
    window.__d.clouds.params.set('cloudSpeed', 0)
    // scatterWeight converges to the naive `len` as sigmaT*len -> 0 (see
    // cloudCommon.glsl) — that is the whole point of the formula, so at the
    // shipped default step size (small optical depth per step) the two
    // agree almost exactly and there is nothing to see. A much coarser step
    // pushes sigmaT*len away from that limit without changing anything else,
    // which is what actually exercises the divergence this test checks for.
    window.__d.clouds.params.set('marchStepSize', 48)
    // The shipped default's forward scattering + thin-cloud brightness floor
    // (cloudCommon.glsl's cloudShade) saturate brightness to 1 for most
    // sun-facing material at the default absorption, which floors both the
    // naive and Sint paths at the SAME clamp and hides the difference this
    // test exists to see. Raising absorption darkens cloud undersides enough
    // that brightness sits below the clamp, where the two paths can actually
    // disagree.
    window.__d.clouds.params.set('absorption', 0.08)
    window.__d.flyCamera.setPose({ pos: [530.7, 120.0, -640.9], yaw: -2.5169, pitch: -0.12 })
    return window.__d.clouds.isSupported()
  })
  test.skip(!supported, 'GPU cannot render to a half-float 3D target')
  await waitFrames(page, 40)

  const at = on => page.evaluate(async v => {
    window.__d.clouds.params.set('useSint',v)
    for (let i = 0; i < 2; i++) { window.__d.markDirty(); await new Promise(r => requestAnimationFrame(r)) }
    return window.__cloudRead.stats()
  }, on)

  const off = await at(false)
  const on  = await at(true)
  console.log('Sint off/on — alpha:', off.alpha.toFixed(4), '/', on.alpha.toFixed(4),
              '| colour:', [off.r, off.g, off.b].map(v => v.toFixed(1)),
              '/', [on.r, on.g, on.b].map(v => v.toFixed(1)))

  expect(on.alpha, 'Sint must not move density/transmittance').toBeCloseTo(off.alpha, 3)
  const colourDiff = Math.abs(off.r - on.r) + Math.abs(off.g - on.g) + Math.abs(off.b - on.b)
  expect(colourDiff, 'Sint should visibly relight the cloud at this coarse a step size').toBeGreaterThan(1)
})

test('powder edge darkening changes shading, never alpha', async ({ page }) => {
  await boot(page, { pause: false })
  await seedCloud(page)
  const supported = await page.evaluate(() => {
    window.__d.clouds.params.set('enabled', true)
    window.__d.clouds.params.set('cloudSpeed', 0)
    window.__d.clouds.params.set('powderEnabled',false)
    window.__d.flyCamera.setPose({ pos: [530.7, 120.0, -640.9], yaw: -2.5169, pitch: -0.12 })
    return window.__d.clouds.isSupported()
  })
  test.skip(!supported, 'GPU cannot render to a half-float 3D target')
  await waitFrames(page, 40)

  const at = on => page.evaluate(async v => {
    window.__d.clouds.params.set('powderEnabled',v)
    for (let i = 0; i < 2; i++) { window.__d.markDirty(); await new Promise(r => requestAnimationFrame(r)) }
    return window.__cloudRead.stats()
  }, on)

  const off = await at(false)
  const on  = await at(true)
  console.log('powder off/on — alpha:', off.alpha.toFixed(4), '/', on.alpha.toFixed(4),
              '| colour:', [off.r, off.g, off.b].map(v => v.toFixed(1)),
              '/', [on.r, on.g, on.b].map(v => v.toFixed(1)))

  expect(on.alpha, 'powder must not move density/transmittance').toBeCloseTo(off.alpha, 3)
  const colourDiff = Math.abs(off.r - on.r) + Math.abs(off.g - on.g) + Math.abs(off.b - on.b)
  expect(colourDiff, 'default powder strength should visibly darken sun-facing material').toBeGreaterThan(0.5)
})

// Cloud drift speed is the uCloudSpeed slider's job alone, decoupled from the
// landscape's momentum (dynamics.noiseTime / noiseSpeed) entirely. Verified
// by freezing dynamics.update() (so momentum/noiseSpeed hold whatever value
// we set them to) and checking the cloud clock advances at the SAME rate
// over the same wall-clock interval regardless of noiseSpeed — a property,
// not a re-derivation of the accumulation formula itself.
test('cloud drift time advances at a fixed rate, independent of dynamics.noiseSpeed', async ({ page }) => {
  // Fake clock: every frame gets an exact dt, so the two windows below cover
  // identical cloud time however slowly the machine renders.
  await boot(page, { pause: false, fakeClock: true })
  await seedCloud(page)
  const offsetX = () => page.evaluate(() => window.__d.clouds._marchMaterial.uniforms.uWindOffset.value.x)
  const growthAt = async noiseSpeed => {
    await page.evaluate(ns => {
      const { dynamics } = window.__d
      // Freeze dynamics' own tick so momentum/noiseSpeed hold exactly what we
      // set them to, instead of being recomputed (and drifting) every frame.
      dynamics.update = () => {}
      dynamics.noiseSpeed = ns
    }, noiseSpeed)
    await page.clock.runFor(50)
    const before = await offsetX()
    await page.clock.runFor(400)
    return (await offsetX()) - before
  }

  const growthLow  = await growthAt(0.02)   // a low but nonzero noiseSpeed
  const growthHigh = await growthAt(2.5)    // NOISE_SPEED_MAX (dynamics.js)
  console.log('cloud clock growth over 400ms — low/high noiseSpeed:', growthLow.toFixed(4), '/', growthHigh.toFixed(4))

  expect(growthLow, 'cloud clock should be advancing at all').toBeGreaterThan(0)
  expect(growthHigh / growthLow, "growth rate shouldn't depend on noiseSpeed (125x apart here)")
    .toBeCloseTo(1, 0)
})

// ── Weather map ────────────────────────────────────────────────
// A slow-scrolling, world-pinned coverage bias on top of the flat coverage
// slider — see cloudsVolume.frag's weatherBias() doc. March-time only
// (deliberately absent from the light bake — see cloudVolumeLight.frag).

test('weather strength visibly reshapes the cloud silhouette', async ({ page }) => {
  await boot(page, { pause: false })
  await seedCloud(page)
  const supported = await page.evaluate(() => {
    window.__d.clouds.params.set('enabled', true)
    window.__d.clouds.params.set('cloudSpeed', 0)
    window.__d.clouds.params.set('weatherSpeed', 0)   // frozen pattern too
    window.__d.clouds.params.set('weatherScale', 800) // small tile: visible in one frame
    window.__d.flyCamera.setPose({ pos: [530.7, 120.0, -640.9], yaw: -2.5169, pitch: -0.12 })
    return window.__d.clouds.isSupported()
  })
  test.skip(!supported, 'GPU cannot render to a half-float 3D target')
  await waitFrames(page, 40)

  const at = strength => page.evaluate(async s => {
    window.__d.clouds.params.set('weatherStrength', s)
    for (let i = 0; i < 2; i++) { window.__d.markDirty(); await new Promise(r => requestAnimationFrame(r)) }
    return {
      mean: window.__cloudRead.stats().alpha,
      samples: window.__cloudRead.samples(),
    }
  }, strength)

  const off = await at(0)
  const on  = await at(1.0)
  const diff = off.samples.reduce((a, v, i) => a + Math.abs(v - on.samples[i]), 0) / off.samples.length
  console.log('weather strength off/on — mean alpha:', off.mean.toFixed(4), '/', on.mean.toFixed(4),
              '| per-pixel mean |diff|:', diff.toFixed(2))

  expect(diff, 'weather strength moved no pixels').toBeGreaterThan(1)
})

test('weather map drift is independent of wind speed', async ({ page }) => {
  await boot(page, { pause: false, fakeClock: true })
  await seedCloud(page)
  const read = () => page.evaluate(() => {
    const u = window.__d.clouds._marchMaterial.uniforms
    return { wind: u.uWindOffset.value.x, weather: u.uWeatherOffset.value.x }
  })
  const growthAt = async (cloudSpeed, weatherSpeed) => {
    await page.evaluate(([cs, ws]) => {
      const { dynamics, clouds } = window.__d
      dynamics.update = () => {}
      dynamics.noiseSpeed = 1.0
      clouds.params.set('cloudSpeed', cs)
      clouds.params.set('weatherSpeed', ws)
    }, [cloudSpeed, weatherSpeed])
    // windOffset/weatherOffset are speed*time, recomputed fresh every frame —
    // not incremental — so a just-changed speed only takes effect once the
    // render loop's next clouds.update() call runs. Run a frame before
    // reading the baseline, or it captures the PREVIOUS speed's value.
    await page.clock.runFor(50)
    const a = await read()
    await page.clock.runFor(400)
    const b = await read()
    return { wind: b.wind - a.wind, weather: b.weather - a.weather }
  }

  // Wind frozen, weather scrolling: the weather offset must still advance.
  const frozenWind = await growthAt(0, 2.0)
  console.log('wind frozen, weather scrolling:', JSON.stringify(frozenWind))
  expect(frozenWind.wind, 'wind should be frozen at speed 0').toBe(0)
  expect(frozenWind.weather, 'weather offset should advance independent of wind speed').toBeGreaterThan(0)

  // Weather frozen, wind blowing: the wind offset must still advance.
  const frozenWeather = await growthAt(6.0, 0)
  console.log('weather frozen, wind blowing:', JSON.stringify(frozenWeather))
  expect(frozenWeather.weather, 'weather should be frozen at speed 0').toBe(0)
  expect(frozenWeather.wind, 'wind offset should advance independent of weather speed').toBeGreaterThan(0)
})

// ── Multi-band differential drift + curl-noise warp ───────────
// Ported from the deleted analytic shader's base/mid/fine bands — see
// cloudsVolume.frag's detailFbm doc. An earlier version of this derived the
// mid/fine offsets from uWindOffset (subtract/re-add), which an adversarial
// review caught as a sign/magnitude bug (wrong-direction residual drift);
// this test pins the CORRECT direction and magnitude as a regression guard.

test('detail bands drift the same direction as wind, at their documented ratios', async ({ page }) => {
  // Fake clock: the 400 ms window always contains frames, however loaded.
  await boot(page, { pause: false, fakeClock: true })
  await seedCloud(page)
  await page.evaluate(() => {
    const { dynamics, clouds } = window.__d
    dynamics.update = () => {}
    dynamics.noiseSpeed = 1.0
    clouds.params.set('cloudSpeed', 8.0)
  })
  await page.clock.runFor(50)   // let the new speed take effect first
  const read = () => page.evaluate(() => {
    const u = window.__d.clouds._marchMaterial.uniforms
    return { wind: u.uWindOffset.value.x, mid: u.uMidWindOffset.value.x, fine: u.uFineWindOffset.value.x }
  })
  const t0 = await read()
  await page.clock.runFor(400)
  const t1 = await read()
  const offsets = { wind: t1.wind - t0.wind, mid: t1.mid - t0.mid, fine: t1.fine - t0.fine }
  console.log('band growth over 400ms — wind/mid/fine:', JSON.stringify(offsets))

  // All three must move the SAME direction (positive, since cloudSpeed > 0)
  // — a sign error would put mid/fine growth negative while wind is positive.
  expect(offsets.wind).toBeGreaterThan(0)
  expect(offsets.mid).toBeGreaterThan(0)
  expect(offsets.fine).toBeGreaterThan(0)

  // Ratios: mid = 0.75x wind, fine = 0.375x wind (both bands share the same
  // noiseTime and cloudSpeed, so the ratio is exact regardless of frame timing).
  expect(offsets.mid / offsets.wind).toBeCloseTo(0.75, 2)
  expect(offsets.fine / offsets.wind).toBeCloseTo(0.375, 2)
})

test('curl-noise warp visibly reshapes the baked cloud silhouette', async ({ page }) => {
  await boot(page, { pause: false })
  await seedCloud(page)
  const supported = await page.evaluate(() => {
    window.__d.clouds.params.set('enabled', true)
    window.__d.clouds.params.set('cloudSpeed', 0)
    window.__d.flyCamera.setPose({ pos: [530.7, 120.0, -640.9], yaw: -2.5169, pitch: -0.12 })
    return window.__d.clouds.isSupported()
  })
  test.skip(!supported, 'GPU cannot render to a half-float 3D target')

  const at = strength => page.evaluate(async s => {
    window.__d.clouds.params.set('curlStrength', s)   // invalidates the shape -> forces a full re-bake
    for (let i = 0; i < 2; i++) { window.__d.markDirty(); await new Promise(r => requestAnimationFrame(r)) }
    return {
      mean: window.__cloudRead.stats().alpha,
      samples: window.__cloudRead.samples(),
    }
  }, strength)

  const off = await at(0)
  await waitFrames(page, 40)   // let the full re-bake (shape + light) finish
  const on = await at(60)
  await waitFrames(page, 40)
  const onSettled = await page.evaluate(() => ({
    mean: window.__cloudRead.stats().alpha,
    samples: window.__cloudRead.samples(),
  }))

  const diff = off.samples.reduce((a, v, i) => a + Math.abs(v - onSettled.samples[i]), 0) / off.samples.length
  console.log('curl strength off/on — mean alpha:', off.mean.toFixed(4), '/', onSettled.mean.toFixed(4),
              '| per-pixel mean |diff|:', diff.toFixed(2))

  expect(diff, 'curl warp moved no pixels').toBeGreaterThan(1)
})

// ── Perlin-Worley combination ──────────────────────────────────

test('worley amount visibly reshapes the baked cloud silhouette', async ({ page }) => {
  await boot(page, { pause: false })
  await seedCloud(page)
  const supported = await page.evaluate(() => {
    window.__d.clouds.params.set('enabled', true)
    window.__d.clouds.params.set('cloudSpeed', 0)
    window.__d.flyCamera.setPose({ pos: [530.7, 120.0, -640.9], yaw: -2.5169, pitch: -0.12 })
    return window.__d.clouds.isSupported()
  })
  test.skip(!supported, 'GPU cannot render to a half-float 3D target')

  const at = amount => page.evaluate(async a => {
    window.__d.clouds.params.set('worleyAmount', a)   // invalidates the shape -> forces a full re-bake
    for (let i = 0; i < 2; i++) { window.__d.markDirty(); await new Promise(r => requestAnimationFrame(r)) }
    return {
      mean: window.__cloudRead.stats().alpha,
      samples: window.__cloudRead.samples(),
    }
  }, amount)

  const off = await at(0)
  await waitFrames(page, 40)   // let the full re-bake (shape + light) finish
  await at(1.0)
  await waitFrames(page, 40)
  const onSettled = await page.evaluate(() => ({
    mean: window.__cloudRead.stats().alpha,
    samples: window.__cloudRead.samples(),
  }))

  const diff = off.samples.reduce((a, v, i) => a + Math.abs(v - onSettled.samples[i]), 0) / off.samples.length
  console.log('worley amount off/on — mean alpha:', off.mean.toFixed(4), '/', onSettled.mean.toFixed(4),
              '| per-pixel mean |diff|:', diff.toFixed(2))

  expect(diff, 'worley amount moved no pixels').toBeGreaterThan(1)
})

/**
 * The axis-separation guard for the test above: worley amount must change the
 * field's CHARACTER without moving its DC level.
 *
 * The first shipped version of erodeByWorley used the textbook one-sided
 * threshold `lo = worley01 * erosion`, which has its only fixed point at
 * base01 == 1 and therefore pulls every other sample down. That passes the
 * "reshapes the silhouette" test above with room to spare — a field sinking
 * out from under the density threshold moves plenty of pixels — while what the
 * user actually sees is the clouds shrinking as the slider goes up. Measuring
 * the pixels moved cannot tell those two apart; measuring the field's mean can.
 *
 * READ STRAIGHT OUT OF THE BAKED SHAPE VOLUME — every texel of every layer,
 * the raw signed field before the density threshold that amplifies a DC shift
 * into a coverage change — not through debug view 1 as this test used to.
 * That view averages only what one camera sees, so it is a LOCAL mean over a
 * handful of Worley cells (it read 0.54 at amount 0 where the whole field sits
 * at 0.50), and it is re-marched only when the march is dirty. Unpaused, the
 * sim re-freezes a few seconds after boot (the boot attention sits above the
 * unfreeze threshold); from then on the world holds still, setDebugView did
 * not trigger a march, and the "on" reading was the composited cloud colour
 * rather than the debug view (measured: alpha 0.64 under a view that is opaque
 * by construction). That produced a deterministic 0.07 "drift" while the field
 * itself moved 0.003. The volume readback has no camera, march or sim state in
 * it at all.
 *
 * A RELATIONSHIP, not a tuning threshold: of everything the slider changes per
 * texel (mean |diff|), how much is a uniform shift (|diff of means|)? The ratio
 * is 1 for a pure DC move and 0 for a pure change of character. The one-sided
 * form sits at exactly 1 — lo >= 0 makes the remap pull every texel down, so
 * every diff has the same sign — and the centred form measures 0.085 (DC
 * 0.0027 of a 0.032 per-texel change). The 0.5 bound sits far from both, and since
 * both numerator and denominator scale with the erosion strength, retuning it
 * cannot turn the test red. The premise check — something changed at all —
 * keeps it from passing on a bake that never ran.
 */
test('worley amount leaves the baked field DC level alone', async ({ page }) => {
  // Paused: nothing but the two bakes moves, and waitFrames' markDirty makes
  // each frame draw (a shape change re-bakes the whole volume in the
  // first frame that runs renderClouds).
  await boot(page, { pause: true })
  await seedCloud(page)
  const supported = await page.evaluate(() => {
    window.__d.clouds.params.set('enabled', true)
    window.__d.clouds.params.set('cloudSpeed', 0)
    window.__d.clouds.params.set('weatherSpeed', 0)
    return window.__d.clouds.isSupported()
  })
  test.skip(!supported, 'GPU cannot render to a half-float 3D target')
  await waitFrames(page, 3)

  // Every texel's R (the signed field), one layer at a time: setRenderTarget's
  // second argument binds that layer of a 3D target to its framebuffer, which
  // is what readRenderTargetPixels then reads. Half-float storage, so the
  // buffer is Uint16 and decoded per texel.
  const bakeAt = amount => page.evaluate(async a => {
    const { clouds, renderer, THREE, markDirty } = window.__d
    const v = clouds
    v.params.set('worleyAmount', a)   // a shape change -> full re-bake next frame
    for (let i = 0; i < 2; i++) { markDirty(); await new Promise(r => requestAnimationFrame(r)) }
    const rt = v._shapeRT, n = rt.width * rt.height
    const buf = new Uint16Array(n * 4)
    const field = new Float32Array(n * rt.depth)
    const prev = renderer.getRenderTarget()
    for (let layer = 0; layer < rt.depth; layer++) {
      renderer.setRenderTarget(rt, layer)
      renderer.readRenderTargetPixels(rt, 0, 0, rt.width, rt.height, buf)
      for (let i = 0; i < n; i++) field[layer * n + i] = THREE.DataUtils.fromHalfFloat(buf[i * 4])
    }
    renderer.setRenderTarget(prev)
    window.__worleyField = window.__worleyField || {}
    window.__worleyField[a] = field
  }, amount)

  await bakeAt(0)
  await bakeAt(1)
  // Signed field mapped to 0..1 (x * 0.5 + 0.5), the units the bound is stated in.
  const { off, on, meanAbsDiff } = await page.evaluate(() => {
    const A = window.__worleyField[0], B = window.__worleyField[1]
    let sa = 0, sb = 0, sd = 0
    for (let i = 0; i < A.length; i++) { sa += A[i]; sb += B[i]; sd += Math.abs(A[i] - B[i]) }
    return { off: sa / A.length * 0.5 + 0.5, on: sb / B.length * 0.5 + 0.5, meanAbsDiff: sd / A.length * 0.5 }
  })
  console.log('worley amount off/on — baked field DC:', off.toFixed(4), '/', on.toFixed(4),
              '| per-texel mean |diff|:', meanAbsDiff.toFixed(4))

  expect(meanAbsDiff, 'worley amount did not change the baked field — the DC comparison below would be vacuous')
    .toBeGreaterThan(0)
  expect(Math.abs(on - off) / meanAbsDiff,
    'worley amount mostly moved the field DC — the erosion remap is eroding coverage, not character')
    .toBeLessThan(0.5)
})

/**
 * A grid too coarse for any Worley octave (the longest draw distance, 3600,
 * makes a 6120-unit window and 24-unit cells, so the safe Worley frequency is
 * 1/48, below the 0.03 set here, beyond the slider's 0.02) bakes the base field
 * alone: the Worley amount must not change it. Compared texel by texel
 * between amount 0 and amount 1; the premise check keeps the comparison from
 * passing on a grid that still carries an octave.
 */
test('a grid with no safe Worley octave bakes the same field at any Worley amount', async ({ page }) => {
  await boot(page, { pause: true })
  await seedCloud(page)
  const supported = await page.evaluate(() => {
    const p = window.__d.clouds.params
    p.set('enabled', true)
    p.set('cloudSpeed', 0)
    p.set('weatherSpeed', 0)
    p.set('drawDistance', 3600)
    p.set('worleyFreq', 0.03)
    return window.__d.clouds.isSupported()
  })
  test.skip(!supported, 'GPU cannot render to a half-float 3D target')
  await waitFrames(page, 3)

  const bakeAt = amount => page.evaluate(async a => {
    const { clouds, renderer, THREE, markDirty } = window.__d
    clouds.params.set('worleyAmount', a)
    for (let i = 0; i < 2; i++) { markDirty(); await new Promise(r => requestAnimationFrame(r)) }
    const rt = clouds._shapeRT, n = rt.width * rt.height
    const buf = new Uint16Array(n * 4)
    const field = new Float32Array(n * rt.depth)
    const prev = renderer.getRenderTarget()
    for (let layer = 0; layer < rt.depth; layer++) {
      renderer.setRenderTarget(rt, layer)
      renderer.readRenderTargetPixels(rt, 0, 0, rt.width, rt.height, buf)
      for (let i = 0; i < n; i++) field[layer * n + i] = THREE.DataUtils.fromHalfFloat(buf[i * 4])
    }
    renderer.setRenderTarget(prev)
    window.__noWorley = window.__noWorley || {}
    window.__noWorley[a] = field
  }, amount)

  await bakeAt(0)
  await bakeAt(1)
  const { octaves, maxDiff } = await page.evaluate(() => {
    const A = window.__noWorley[0], B = window.__noWorley[1]
    let d = 0
    for (let i = 0; i < A.length; i++) d = Math.max(d, Math.abs(A[i] - B[i]))
    return { octaves: window.__d.clouds._bakeMaterial.uniforms.uWorleyOctaves.value, maxDiff: d }
  })
  console.log('no safe worley octave — octaves:', octaves, '| max texel |diff|:', maxDiff)

  expect(octaves, 'this grid still carries a Worley octave').toBe(0)
  expect(maxDiff, 'the Worley amount changed a field with no Worley octave').toBe(0)
})

/**
 * Dropping a baked octave (the grid carries 4, then 3, as baseFreq rises
 * past kMax/8) turns that octave and every finer one into marched detail. The
 * frame must not jump across that point: the change from just below to just
 * above it stays within a small multiple of the change between two equally
 * close values on one side (the controls). Camera pose and step growth are
 * the shipped ones, so the far half of each ray marches with steps above 12
 * units, where a single weight for the whole tail used to double the detail
 * at the drop (measured 8.0 against 0.25-0.37 for the controls).
 *
 * The threshold is read from the live grid, not hard-coded: kMax/8 for the
 * lacunarity-2 series.
 */
test('the frame does not jump where a baked octave drops to marched detail', async ({ page }) => {
  await boot(page, { pause: true })
  await seedCloud(page)
  const supported = await page.evaluate(() => {
    const p = window.__d.clouds.params
    p.set('enabled', true); p.set('cloudSpeed', 0); p.set('weatherSpeed', 0)
    window.__d.flyCamera.setPose({ pos: [530.7, 120.0, -640.9], yaw: -2.5169, pitch: -0.12 })
    return window.__d.clouds.isSupported()
  })
  test.skip(!supported, 'GPU cannot render to a half-float 3D target')
  await waitFrames(page, 5)

  const edge = await page.evaluate(() => {
    const c = window.__d.clouds
    return 1.7021 / (2 * c.getCellSize()) / Math.pow(c.params.get('lacunarity'), 3)
  })
  const at = async f => {
    await page.evaluate(v => { window.__d.clouds.params.set('baseFreq', v); window.__d.clouds.snapEases() }, f)
    await waitFrames(page, 6)
    return page.evaluate(() => ({
      s: Array.from(window.__cloudRead.samples()),
      oct: window.__d.clouds.getOctaves(),
    }))
  }
  const diff = (a, b) => a.s.reduce((x, v, i) => x + Math.abs(v - b.s[i]), 0) / a.s.length
  // Three pairs at the same spacing, so an ordinary frequency change weighs the
  // same in the controls and across the drop.
  const d = 1e-7
  const a0 = await at(edge - 3 * d), a1 = await at(edge - d)
  const b0 = await at(edge + d), b1 = await at(edge + 3 * d)
  const across = diff(a1, b0)
  const control = Math.max(diff(a0, a1), diff(b0, b1))
  console.log('octaves', a1.oct, b0.oct, '| controls', control.toFixed(3), '| across the drop', across.toFixed(3))

  expect(a1.oct - b0.oct, 'the baked octave count did not change across the point').toBe(1)
  expect(across, 'the frame jumps where a baked octave becomes marched detail').toBeLessThan(Math.max(3 * control, 0.5))
})

/**
 * The window is placed around what is read, so at the shipped camera and sun
 * the whole region (view cone to the draw distance, the terrain plane's shadow
 * footprint, the light bake's reach) fits it, and once placed it moves only with
 * the wind: a frozen sky never re-anchors.
 */
test('the window holds the region at the shipped camera and sun, and holds still', async ({ page }) => {
  await boot(page, { pause: true })
  const r = await page.evaluate(async () => {
    const v = window.__d.clouds
    v.params.set('cloudSpeed', 0)
    v.params.set('weatherSpeed', 0)
    for (let i = 0; i < 20; i++) { window.__d.markDirty(); await new Promise(res => requestAnimationFrame(res)) }
    const a = v.getDiagnostics()
    const originA = { ...a.originCell }
    for (let i = 0; i < 20; i++) { window.__d.markDirty(); await new Promise(res => requestAnimationFrame(res)) }
    const b = v.getDiagnostics()
    return { fits: b.regionFits, same: a.originCell.x === b.originCell.x && a.originCell.z === b.originCell.z, originA }
  })
  expect(r.fits, 'the shipped camera and sun do not fit the window').toBe(true)
  expect(r.same, 'the window moved with a frozen sky').toBe(true)
})

/**
 * A jump in the cloud amount (one step of the overcast slider is 0.0274) or in the
 * cloud scale (a step of the scatter dial is 0.5-1%) reaches the clouds as a ramp.
 * Live, with real frame times: the first frame moves the amount by a fraction of
 * the jump, it moves monotonically and lands on its row; the scale moves by at
 * most the roll limit per frame and the volume is never re-baked whole.
 */
test('a jump in the cloud amount or scale reaches the clouds as a ramp', async ({ page }) => {
  await boot(page, { pause: false })
  await seedCloud(page)
  const supported = await page.evaluate(() => {
    window.__d.clouds.params.set('enabled', true)
    return window.__d.clouds.isSupported()
  })
  test.skip(!supported, 'GPU cannot render to a half-float 3D target')
  await waitFrames(page, 40)

  const r = await page.evaluate(async () => {
    const v = window.__d.clouds
    const frame = () => new Promise(res => { window.__d.markDirty(); requestAnimationFrame(res) })
    v.params.set('coverageEase', 0.5)
    let fullBakes = 0
    const orig = v._fullRebake.bind(v)
    v._fullRebake = rr => { fullBakes++; orig(rr) }

    const c0 = v._shared.uCoverage.value
    const jump = -0.6
    v.params.set('coverage', c0 + jump)
    const trail = []
    for (let i = 0; i < 90; i++) { await frame(); trail.push(v._shared.uCoverage.value) }

    const f0 = v._bakeMaterial.uniforms.uBaseFreq.value
    const bakesBefore = fullBakes
    v.params.set('baseFreq', f0 * 1.15)
    let maxRel = 0, last = f0
    for (let i = 0; i < 60; i++) {
      await frame()
      const now = v._bakeMaterial.uniforms.uBaseFreq.value
      maxRel = Math.max(maxRel, now / last - 1); last = now
    }
    const out = { c0, jump, trail, fullBakesDuringScale: fullBakes - bakesBefore, maxRel, f0, f1: last,
                  limit: 0.7 * 1 / (Math.SQRT1_2 * 256) / Math.ceil(32 / v.params.get('rollLayersPerFrame')) }
    v._fullRebake = orig
    v.params.set('baseFreq', f0); v.params.set('coverage', c0); v.snapEases()
    return out
  })
  console.log('ramp: first frame', ((r.trail[0] - r.c0) / r.jump).toFixed(3), 'of the jump; scale max rel step', r.maxRel.toFixed(5), 'limit', r.limit.toFixed(5), 'full re-bakes', r.fullBakesDuringScale)

  expect((r.trail[0] - r.c0) / r.jump, 'the first frame took a large part of the jump').toBeLessThan(0.4)
  for (let i = 1; i < r.trail.length; i++) expect(r.trail[i], `frame ${i}`).toBeLessThanOrEqual(r.trail[i - 1])
  expect(r.trail[r.trail.length - 1] - (r.c0 + r.jump), 'the amount never landed on its row').toBeLessThan(0.2)
  expect(r.maxRel, 'the scale moved faster than the roll limit').toBeLessThanOrEqual(r.limit + 1e-9)
  expect(r.f1, 'the scale did not move at all').toBeGreaterThan(r.f0)
  expect(r.fullBakesDuringScale, 'the volume was re-baked whole during the scale move').toBe(0)
})

test('a relit light layer fades to its new copy and never steps', async ({ page }) => {
  await boot(page, { pause: false })
  await seedCloud(page)
  const supported = await page.evaluate(() => {
    window.__d.clouds.params.set('enabled', true)
    return window.__d.clouds.isSupported()
  })
  test.skip(!supported, 'GPU cannot render to a half-float 3D target')
  await waitFrames(page, 40)

  const r = await page.evaluate(async () => {
    const v = window.__d.clouds
    const frame = () => new Promise(res => { window.__d.markDirty(); requestAnimationFrame(res) })
    const rate = Math.max(v.params.get('lightLayersPerFrame'), 1) / 32
    v.params.set('coverageEase', 1.5)
    v.params.set('coverage', v._shared.uCoverage.value - 0.3)
    let maxStep = 0, flips = 0, moved = 0, prevT = Array.from(v._litTarget)
    let prevW = Array.from(v._litWeight)
    for (let i = 0; i < 120; i++) {
      await frame()
      const w = Array.from(v._litWeight), t = Array.from(v._litTarget)
      for (let l = 0; l < 32; l++) {
        maxStep = Math.max(maxStep, Math.abs(w[l] - prevW[l]))
        if (t[l] !== prevT[l]) flips++
      }
      if (v._litFading) moved++
      prevW = w; prevT = t
    }
    const out = { rate, maxStep, flips, moved }
    v.params.set('coverage', v._shared.uCoverage.value + 0.3); v.snapEases()
    return out
  })
  console.log('light fade: max weight step', r.maxStep.toFixed(4), 'rate', r.rate.toFixed(4), 'flips', r.flips, 'frames fading', r.moved)

  expect(r.flips, 'no layer was relit during the ramp').toBeGreaterThan(30)
  expect(r.maxStep, 'a layer weight stepped faster than the fade rate').toBeLessThanOrEqual(r.rate + 1e-6)
  expect(r.moved, 'nothing was fading').toBeGreaterThan(0)

})

test('a strip relight leaves an owed relight of the rest owed', async ({ page }) => {
  await boot(page, { pause: false })
  await seedCloud(page)
  const supported = await page.evaluate(() => {
    window.__d.clouds.params.set('enabled', true)
    return window.__d.clouds.isSupported()
  })
  test.skip(!supported, 'GPU cannot render to a half-float 3D target')
  await waitFrames(page, 40)

  const pending = await page.evaluate(() => {
    const { clouds, renderer } = window.__d
    clouds._lightPending = 20
    clouds._bakeLightRects(renderer, [{ x: 0, y: 0, w: 8, h: 256 }])
    return clouds._lightPending
  })
  expect(pending).toBe(20)
})

test('the ground shadow follows the weather map: darker under its cloudy patches', async ({ page }) => {
  await boot(page, { pause: false })
  await seedCloud(page)
  const supported = await page.evaluate(() => {
    window.__d.clouds.params.set('enabled', true)
    return window.__d.clouds.isSupported()
  })
  test.skip(!supported, 'GPU cannot render to a half-float 3D target')
  await waitFrames(page, 40)

  // The ground shadow's optical depth G (what the ground reads) at every texel,
  // split by the weather map's bias at that texel's world position. With the
  // bias on, the cloudy quarter must hold more depth than the clear quarter;
  // with it off, the quarters differ only by the field's own structure.
  const gap = strength => page.evaluate(async st => {
    const { clouds, renderer, THREE } = window.__d
    const v = clouds
    v.params.set('weatherStrength', st)
    v.params.set('weatherSpeed', 0); v.params.set('groundEase', 0)
    for (let i = 0; i < 6; i++) await new Promise(r => { window.__d.markDirty(); requestAnimationFrame(r) })
    const half = THREE.DataUtils.fromHalfFloat
    const lit = v._ground[v._groundCur], n = lit.width * lit.height   // the ground shadow's own 2-D target
    const lb = new Uint16Array(n * 4)
    const prev = renderer.getRenderTarget()
    renderer.setRenderTarget(lit)
    renderer.readRenderTargetPixels(lit, 0, 0, lit.width, lit.height, lb)
    const wm = v._weatherRT, wn = wm.width
    const wb = new Uint16Array(wn * wn * 4)
    renderer.setRenderTarget(wm)
    renderer.readRenderTargetPixels(wm, 0, 0, wn, wn, wb)
    renderer.setRenderTarget(prev)

    const mu = v._marchMaterial.uniforms
    const wind = mu.uWindOffset.value, wo = mu.uWeatherOffset.value
    const scale = mu.uWeatherScale.value
    const cell = v._shared.uCellSize.value, N = lit.width
    const o = v._shared.uOriginCell.value
    const rows = []
    for (let ty = 0; ty < N; ty++) for (let tx = 0; tx < N; tx++) {
      const cx = o.x + (((tx - o.x) % N) + N) % N, cz = o.y + (((ty - o.y) % N) + N) % N
      const u = ((cx + 0.5) * cell - wind.x + wo.x) / scale, w = ((cz + 0.5) * cell - wind.y + wo.y) / scale
      const ix = Math.floor((u - Math.floor(u)) * wn), iy = Math.floor((w - Math.floor(w)) * wn)
      rows.push([half(wb[(iy * wn + ix) * 4]), half(lb[(ty * N + tx) * 4 + 1])])
    }
    rows.sort((a, b) => a[0] - b[0])
    const q = Math.floor(rows.length / 4)
    const mean = list => list.reduce((s, r) => s + r[1], 0) / list.length
    return mean(rows.slice(-q)) - mean(rows.slice(0, q))
  }, strength)

  const on = await gap(3.5)
  const off = await gap(0)
  console.log('shadow depth, cloudy quarter minus clear quarter — bias on/off:', on.toFixed(3), '/', off.toFixed(3))
  expect(on, 'the shadow does not follow the weather map').toBeGreaterThan(0)
  expect(on, 'the bias adds nothing to the shadow').toBeGreaterThan(off)
})

// ── Horizon curvature droop ────────────────────────────────────

test('planet curve visibly reshapes the cloud silhouette', async ({ page }) => {
  await boot(page, { pause: false })
  await seedCloud(page)
  const supported = await page.evaluate(() => {
    window.__d.clouds.params.set('enabled', true)
    window.__d.clouds.params.set('cloudSpeed', 0)
    window.__d.flyCamera.setPose({ pos: [530.7, 120.0, -640.9], yaw: -2.5169, pitch: -0.12 })
    return window.__d.clouds.isSupported()
  })
  test.skip(!supported, 'GPU cannot render to a half-float 3D target')

  const at = curve => page.evaluate(async c => {
    window.__d.clouds.params.set('planetCurve', c)
    for (let i = 0; i < 2; i++) { window.__d.markDirty(); await new Promise(r => requestAnimationFrame(r)) }
    return {
      mean: window.__cloudRead.stats().alpha,
      samples: window.__cloudRead.samples(),
    }
  }, curve)

  const flat = await at(0)
  const curved = await at(1500)   // a strongly-curved "small planet" for a clear signal
  const diff = flat.samples.reduce((a, v, i) => a + Math.abs(v - curved.samples[i]), 0) / flat.samples.length
  console.log('planet curve off/on — mean alpha:', flat.mean.toFixed(4), '/', curved.mean.toFixed(4),
              '| per-pixel mean |diff|:', diff.toFixed(2))

  expect(diff, 'planet curve moved no pixels').toBeGreaterThan(1)
})

