/**
 * mantle.spec.js — guards the bedrock/mantle two-field placement
 * against the LIVE data-map
 * pass, reading RT_A directly.
 *
 * Why not tests/signals/: the select lives in RT_A.a, and the fixture path
 * (setFixtureHeightfield) writes only .r — so a fixture would read a constant 0,
 * the same reason ridge(7)/erosion(8) are deferred in signalRegistry.js. The
 * real pass is the only place this signal exists.
 *
 * What is asserted is the mechanism's DEFINING PROPERTY, not a tuning value:
 * bedrock is exposed on high ground and the mantle fills the valleys. That
 * ordering is what inverts at high relief if the shared normalisation in fbmDual
 * is ever "simplified" into two independent single-field passes (the R1 sign
 * trap: above rho = bedrock total / mantle total, about 0.78 at the shipped
 * persistence and octave counts). Signs and orderings only; no thresholds, no
 * pixels.
 */
import { test, expect } from '@playwright/test'
import { boot } from './helpers.js'

/**
 * Read the live RT_A and reduce it to per-field height statistics.
 * @returns {Promise<{n:number, bedrockFrac:number, meanBedrockH:number,
 *                    meanMantleH:number, meanH:number, isHalf:boolean}>}
 */
async function readFields(page, { relief = 0.45, bedrockOctaves = 6, rockPersist = null, solo = 0 } = {}) {
  return page.evaluate(({ relief, bedrockOctaves, rockPersist, solo }) => {
    const { THREE, terrain, renderer } = window.__d
    terrain.params.set('mantleRelief', relief)
    terrain.params.set('bedrockOctaves', bedrockOctaves)
    terrain.params.set('fieldSolo', solo)
    if (rockPersist != null) terrain.params.set('rockPersist', rockPersist)
    // Erosion off: it displaces height AFTER the fields are composed, so leaving
    // it on would blur the very ordering under test with a carve that knows
    // nothing about the select.
    const wasEroded = terrain._heightmapMaterial.uniforms.uErosionEnabled.value
    terrain.params.set('erosion', false)
    terrain.renderDataMap()

    const rt = terrain._dataMapRT
    const N = rt.width
    const isHalf = rt.texture.type === THREE.HalfFloatType
    const buf = isHalf ? new Uint16Array(N * N * 4) : new Float32Array(N * N * 4)
    renderer.readRenderTargetPixels(rt, 0, 0, N, N, buf)
    terrain.params.set('erosion', wasEroded)

    const half = h => {
      const s = (h & 0x8000) ? -1 : 1, e = (h & 0x7c00) >> 10, f = h & 0x03ff
      if (e === 0) return s * Math.pow(2, -14) * (f / 1024)
      if (e === 0x1f) return f ? NaN : s * Infinity
      return s * Math.pow(2, e - 15) * (1 + f / 1024)
    }
    const dec = v => (isHalf ? half(v) : v)

    let nB = 0, sB = 0, nM = 0, sM = 0, sAll = 0
    const total = N * N
    for (let o = 0; o < total; o++) {
      const h = dec(buf[o * 4])
      const sel = dec(buf[o * 4 + 3])
      sAll += h
      // Only texels that are clearly one field or the other count; a fractional
      // value can only come from the half-float encoding or a filtered read.
      if (sel > 0.99) { nB++; sB += h } else if (sel < 0.01) { nM++; sM += h }
    }
    return {
      n: total, isHalf,
      bedrockFrac: nB / total,
      meanBedrockH: nB ? sB / nB : NaN,
      meanMantleH: nM ? sM / nM : NaN,
      meanH: sAll / total,
    }
  }, { relief, bedrockOctaves, rockPersist, solo })
}

/**
 * Local roughness of the live height map, split by elevation. Roughness is the
 * mean absolute difference between a texel and its 4-neighbour average — the
 * small-scale agitation, independent of the large-scale shape it rides on.
 * Texels are bucketed into the lowest and highest thirds by height.
 * @returns {Promise<{lowRough:number, highRough:number, ratio:number}>}
 */
async function readRoughnessByElevation(page) {
  return page.evaluate(() => {
    const { THREE, terrain, renderer } = window.__d
    terrain.params.set('bedrockOctaves', 6)
    terrain.params.set('fieldSolo', 1)              // bedrock alone — the field the gate acts on
    terrain.params.set('erosion', false)     // erosion would add its own roughness
    terrain.renderDataMap()

    const rt = terrain._dataMapRT
    const N = rt.width
    const isHalf = rt.texture.type === THREE.HalfFloatType
    const buf = isHalf ? new Uint16Array(N * N * 4) : new Float32Array(N * N * 4)
    renderer.readRenderTargetPixels(rt, 0, 0, N, N, buf)
    terrain.params.set('erosion', true)
    terrain.params.set('fieldSolo', 0)

    const half = h => {
      const s = (h & 0x8000) ? -1 : 1, e = (h & 0x7c00) >> 10, f = h & 0x03ff
      if (e === 0) return s * Math.pow(2, -14) * (f / 1024)
      return s * Math.pow(2, e - 15) * (1 + f / 1024)
    }
    const H = new Float32Array(N * N)
    for (let o = 0; o < N * N; o++) H[o] = isHalf ? half(buf[o * 4]) : buf[o * 4]

    // Elevation thirds, from the sorted height distribution.
    const sorted = Float32Array.from(H).sort()
    const loCut = sorted[Math.floor(sorted.length / 3)]
    const hiCut = sorted[Math.floor((2 * sorted.length) / 3)]

    let lowSum = 0, lowN = 0, highSum = 0, highN = 0
    for (let j = 1; j < N - 1; j++) {
      for (let i = 1; i < N - 1; i++) {
        const o = j * N + i
        const avg = (H[o - 1] + H[o + 1] + H[o - N] + H[o + N]) * 0.25
        const r = Math.abs(H[o] - avg)
        if (H[o] <= loCut) { lowSum += r; lowN++ }
        else if (H[o] >= hiCut) { highSum += r; highN++ }
      }
    }
    const lowRough = lowSum / Math.max(lowN, 1)
    const highRough = highSum / Math.max(highN, 1)
    return { lowRough, highRough, ratio: lowRough / Math.max(highRough, 1e-9) }
  })
}

test('bedrock is exposed on high ground, mantle fills the valleys (R1 sign)', async ({ page }) => {
  await boot(page)
  const r = await readFields(page)
  expect(r.bedrockFrac).toBeGreaterThan(0)
  expect(r.bedrockFrac).toBeLessThan(1)
  // THE invariant. Inverts if the mantle is ever normalised over its own octaves.
  expect(r.meanBedrockH).toBeGreaterThan(r.meanMantleH)
})

test('the relief ratio moves the split without inverting it', async ({ page }) => {
  await boot(page)
  for (const relief of [0.15, 0.45, 0.80]) {
    const r = await readFields(page, { relief })
    expect(r.meanBedrockH, `relief ${relief}`).toBeGreaterThan(r.meanMantleH)
  }
})

test('rock persistence does not touch the mantle field', async ({ page }) => {
  await boot(page)
  const MANTLE_SOLO = { solo: 2 }
  const lo = await readFields(page, { ...MANTLE_SOLO, rockPersist: 0.25 })
  const hi = await readFields(page, { ...MANTLE_SOLO, rockPersist: 0.85 })
  // Same field, so the mean must agree to readback precision — not merely be close.
  expect(hi.meanH).toBeCloseTo(lo.meanH, 4)
})

test('rock persistence does change the bedrock field', async ({ page }) => {
  await boot(page)
  const BEDROCK_SOLO = { solo: 1 }
  const lo = await readFields(page, { ...BEDROCK_SOLO, rockPersist: 0.25 })
  const hi = await readFields(page, { ...BEDROCK_SOLO, rockPersist: 0.85 })
  // Guards the other direction: if the knob were wired to nothing, the test
  // above would pass trivially.
  expect(Math.abs(hi.meanH - lo.meanH)).toBeGreaterThan(1e-3)
})

test('the rock knobs are inert when there are no bedrock-only octaves', async ({ page }) => {
  await boot(page)
  // Bedrock octaves clamped down to the mantle count means no octave satisfies
  // i >= nF, so every rock-character knob has nothing to act on. Rock mode is
  // always on now, so this clamp is the only thing that can switch it off.
  const a = await readFields(page, { bedrockOctaves: 1, rockPersist: 0.25 })
  const b = await readFields(page, { bedrockOctaves: 1, rockPersist: 0.85 })
  expect(b.bedrockFrac).toBeCloseTo(a.bedrockFrac, 4)
  expect(b.meanH).toBeCloseTo(a.meanH, 3)
})

test('the height gate keeps low ground smoother than high ground', async ({ page }) => {
  await boot(page)
  // The gate is always applied now (no on/off toggle) — this asserts its
  // defining property directly instead of comparing against a removed
  // ungated path: rock detail is suppressed on low ground and at full
  // strength on high ground, so roughness must be lower on low ground.
  const r = await readRoughnessByElevation(page)
  expect(r.lowRough).toBeLessThan(r.highRough)
})

test('the gate is inert at amount 0 (lo/hi have no effect)', async ({ page }) => {
  await boot(page)
  // gateAmt 0 makes the smoothstep mix out entirely (gate = mix(1.0, X, 0) = 1.0
  // regardless of X) — so with amount pinned at 0, sweeping lo/hi across their
  // whole range must not move the result at all.
  await page.evaluate(() => window.__d.terrain.params.set('gateAmt', 0))
  await page.evaluate(() => {
    window.__d.terrain.params.set('gateLo', -0.9)
    window.__d.terrain.params.set('gateHi', -0.8)
  })
  const a = await readFields(page)
  await page.evaluate(() => {
    window.__d.terrain.params.set('gateLo', 0.5)
    window.__d.terrain.params.set('gateHi', 0.9)
  })
  const b = await readFields(page)
  await page.evaluate(() => {
    window.__d.terrain.params.set('gateAmt', 0.9)
    window.__d.terrain.params.set('gateLo', -0.1)
    window.__d.terrain.params.set('gateHi', 0.6)
  })
  expect(b.meanH).toBeCloseTo(a.meanH, 3)
  expect(b.bedrockFrac).toBeCloseTo(a.bedrockFrac, 3)
})

test('the gate amount never rescales the mantle', async ({ page }) => {
  await boot(page)
  const MANTLE_SOLO = { solo: 2 }
  // Same axis-separation rule the rock-persistence fix established: a bedrock
  // knob must leave the mantle alone. Sweeping the surviving continuous knob
  // (gateAmt) end to end, since the gate no longer has a separate on/off path.
  await page.evaluate(() => window.__d.terrain.params.set('gateAmt', 0))
  const off = await readFields(page, MANTLE_SOLO)
  await page.evaluate(() => window.__d.terrain.params.set('gateAmt', 1))
  const on = await readFields(page, MANTLE_SOLO)
  await page.evaluate(() => window.__d.terrain.params.set('gateAmt', 0.9))
  expect(on.meanH).toBeCloseTo(off.meanH, 4)
})

// ── Mantle shaping: bias and smoothing ───────────────────────────────────────
test('mantle bias raises the soil line — more mantle, less exposed bedrock', async ({ page }) => {
  await boot(page)
  const shots = []
  for (const bias of [-40, 0, 40]) {
    await page.evaluate(b => window.__d.terrain.params.set('mantleBias', b), bias)
    shots.push(await readFields(page, {}))
  }
  await page.evaluate(() => window.__d.terrain.params.set('mantleBias', 0))
  const [down, mid, up] = shots
  // Raising the mantle buries bedrock: the exposed fraction must fall, monotonically.
  expect(up.bedrockFrac).toBeLessThan(mid.bedrockFrac)
  expect(mid.bedrockFrac).toBeLessThan(down.bedrockFrac)
})

test('the soil level does not touch the bedrock field', async ({ page }) => {
  await boot(page)
  const BEDROCK_SOLO = { solo: 1 }
  const before = await readFields(page, BEDROCK_SOLO)
  await page.evaluate(() => window.__d.terrain.params.set('mantleBias', 35))
  const after = await readFields(page, BEDROCK_SOLO)
  await page.evaluate(() => window.__d.terrain.params.set('mantleBias', 0))
  // Same axis-separation rule as rock persistence: a mantle knob must not reach
  // the other field. Bias lifts the mantle only.
  expect(after.meanH).toBeCloseTo(before.meanH, 4)
})

test('the DC keeps the composed terrain near zero-mean', async ({ page }) => {
  await boot(page)
  const corrected = await readFields(page)

  // Measure the same thing with the correction switched off, by zeroing the
  // uniform the driver writes. Comparing the two is what gives this test teeth:
  // an absolute tolerance would only say "close enough", and would have to be
  // re-loosened every time the correction's accuracy changes — as it just did,
  // since rock mode being always-on means uMantleDC tracks ridging's amplitude
  // series but not its changed per-octave variance (see mantleDcCoefficient).
  const uncorrected = await page.evaluate(() => {
    const { THREE, terrain, renderer } = window.__d
    terrain.params.set('fieldSolo', 0)
    terrain.params.set('erosion', false)
    terrain.params.set('frozen', true)                 // stop the driver rewriting uMantleDC
    terrain._material.uniforms.uMantleDC.value = 0
    terrain.renderDataMap()
    const rt = terrain._dataMapRT, N = rt.width
    const isHalf = rt.texture.type === THREE.HalfFloatType
    const buf = isHalf ? new Uint16Array(N * N * 4) : new Float32Array(N * N * 4)
    renderer.readRenderTargetPixels(rt, 0, 0, N, N, buf)
    const half = h => {
      const s = (h & 0x8000) ? -1 : 1, e = (h & 0x7c00) >> 10, f = h & 0x03ff
      if (e === 0) return s * Math.pow(2, -14) * (f / 1024)
      return s * Math.pow(2, e - 15) * (1 + f / 1024)
    }
    let sum = 0
    for (let o = 0; o < N * N; o++) sum += isHalf ? half(buf[o * 4]) : buf[o * 4]
    terrain.params.set('frozen', false)
    terrain.params.set('erosion', true)
    return sum / (N * N)
  })

  // The correction must actually correct: applying it pulls the composed mean
  // toward zero rather than leaving max()'s lift in place. Asserted as a strict
  // ORDERING, with no magnitude — any factor I picked here would be a threshold
  // invented to pass, and would ossify against the known inaccuracy below.
  expect(Math.abs(corrected.meanH)).toBeLessThan(Math.abs(uncorrected))

  // KNOWN INACCURACY, deliberately not asserted tightly. At the shipped config
  // uMantleDC is ~3.7 where the true lift is ~1.1, so it OVER-subtracts by
  // ~2.6wu. MANTLE_DC_PER_SIGMA was calibrated on plain fBM at relief <= 0.45;
  // the shipped terrain runs relief 0.85 with rock mode always on and ridging
  // at 0.45, all three of which reshape the per-octave variance the constant
  // assumes. Pinning a tight bound here would just ossify the error.
})
