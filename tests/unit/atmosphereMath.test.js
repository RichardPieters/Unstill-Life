import { describe, test, expect } from 'vitest'
import { lerp, overcastCurves, hazeCurves, mixHex, shapeOvercast, scaleHex } from '../../src/drift/atmosphereMath.js'

// The live scene values the weather captures as its CLEAR end. Written out here
// rather than imported so this test is INDEPENDENT ground truth: if terrain.js's
// defaults move, the curve tests below still assert the same property (clear at
// w=0, heavy at w=1, monotone between) against whatever numbers they are handed.
const CLEAR = { shadowValue: 0.05, lightLevel: 1.00, glow: 0.30, fogCurve: 0.60, aerialDesat: 0.55 }
const HEAVY = { shadowValue: 0.75, lightLevel: 0.70, glow: 0.00, fogCurve: 0.25, aerialDesat: 0.90 }

describe('shapeOvercast', () => {
  const SHAPE = { onset: 0.30, full: 1.00 }

  test('both endpoints are preserved exactly', () => {
    // The whole licence for putting a curve here. The clear look and the
    // full-overcast look are tuned separately; this is only allowed to change
    // the PATH between them. f(0) != 0 would mean a clear day
    // fails to reproduce the scene, f(1) != 1 that full overcast never
    // reaches the heavy values the sliders say it should.
    expect(shapeOvercast(0, SHAPE)).toBe(0)
    expect(shapeOvercast(1, SHAPE)).toBeCloseTo(1, 12)
  })

  test('nothing happens below the onset', () => {
    // What the window is for: at overcast 0.2 the sky is ~1% cloud, and a
    // linear blend would already put the light a fifth of the way to a grey day.
    for (const w of [0, 0.1, 0.2, 0.29]) expect(shapeOvercast(w, SHAPE)).toBe(0)
  })

  test('monotone, and never leaves [0,1]', () => {
    // Non-monotone would mean the weather visibly backtracks while the scalar
    // keeps climbing; out of range would extrapolate past the authored ends.
    let prev = -Infinity
    for (let w = 0; w <= 1.0001; w += 0.01) {
      const v = shapeOvercast(w, SHAPE)
      expect(v).toBeGreaterThanOrEqual(prev)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(1)
      prev = v
    }
  })

  test('it tracks the MEASURED cloud fill, which is the point of its shape', () => {
    // Independent ground truth, and deliberately not a re-derivation of the
    // curve's formula: these are mean cloud alphas read back off the render target
    // while sweeping overcast with the shipped uCoverage ends, normalised to
    // their own range. The curve exists to follow this, so this is the only
    // assertion that can tell a fitted curve from an arbitrary one.
    const MEASURED = [
      [0.2, 0.012], [0.3, 0.040], [0.4, 0.111], [0.5, 0.240],
      [0.6, 0.407], [0.75, 0.676], [0.9, 0.899], [1.0, 1.000],
    ]
    for (const [w, fill] of MEASURED) {
      // Generous tolerance on purpose — this pins the SHAPE, not the fit. A
      // linear blend fails it at 0.2 (0.200 vs 0.012) and at 0.4 (0.400 vs
      // 0.111), which is the error it guards against.
      expect(Math.abs(shapeOvercast(w, SHAPE) - fill)).toBeLessThan(0.12)
    }
  })

  test('a linear blend is what this rejects', () => {
    // Stated as its own case so the failure message says which direction is
    // wrong rather than just "a number moved".
    expect(shapeOvercast(0.2, SHAPE)).toBeLessThan(0.2)
    expect(shapeOvercast(0.4, SHAPE)).toBeLessThan(0.4)
  })

  test('a degenerate window is a hard step, not a divide by zero', () => {
    const step = { onset: 0.5, full: 0.5 }
    expect(shapeOvercast(0.49, step)).toBe(0)
    expect(shapeOvercast(0.51, step)).toBe(1)
    expect(Number.isFinite(shapeOvercast(0.5, { onset: 0.8, full: 0.2 }))).toBe(true)
  })

  test('no shape given is the identity, i.e. no shaping at all', () => {
    // The neutral default. atmosphere.js holds the TUNED window, the same way
    // it holds clear/heavy; this file's default must not quietly apply a curve of
    // its own to a caller that did not ask for one.
    for (const w of [0, 0.25, 0.5, 0.75, 1]) expect(shapeOvercast(w)).toBeCloseTo(w, 12)
  })

  test('it keeps climbing at the top instead of flattening into a shoulder', () => {
    // Why this is a plain ramp and not a smoothstep. The measured cloud is
    // still gaining at full slope over the last tenth of the dial (0.899 ->
    // 1.000), so a curve whose derivative falls to 0 at w = 1 runs AHEAD of the
    // cloud near the top: the light-ahead-of-cloud error the window exists to
    // prevent, moved up the dial. Asserted as equal slopes across the top two
    // tenths.
    const d = (a, b) => shapeOvercast(b, SHAPE) - shapeOvercast(a, SHAPE)
    expect(d(0.9, 1.0)).toBeCloseTo(d(0.8, 0.9), 9)
  })
})

describe('overcastCurves', () => {
  test('clear weather reproduces the captured scene exactly', () => {
    const r = overcastCurves(CLEAR, HEAVY, 0)
    expect(r.shadowValue).toBeCloseTo(CLEAR.shadowValue, 12)
    expect(r.glow).toBeCloseTo(CLEAR.glow, 12)
  })

  test('full overcast lands on the authored heavy values', () => {
    const r = overcastCurves(CLEAR, HEAVY, 1)
    expect(r.shadowValue).toBeCloseTo(HEAVY.shadowValue, 12)
    expect(r.glow).toBeCloseTo(HEAVY.glow, 12)
  })

  test('the shadow floor only ever RISES with overcast', () => {
    // The load-bearing property, stated as a direction rather than a number so
    // it survives every retune: overcast must compress contrast by lifting the
    // dark end toward the lit one. A curve that lowered it would be darkening
    // the scene, which is the opposite of what flat cloud light does.
    let prev = -Infinity
    for (let w = 0; w <= 1.0001; w += 0.05) {
      const v = overcastCurves(CLEAR, HEAVY, w).shadowValue
      expect(v).toBeGreaterThanOrEqual(prev)
      prev = v
    }
  })

  test('the light level only ever FALLS with overcast', () => {
    // The companion direction to the shadow floor above, and the reason both
    // are asserted as directions: they are SEPARATE axes. The floor rises
    // (contrast compresses), the level falls (the ground gets less light). A
    // curve that moved them the same way would be one axis driven twice, and a
    // light level that rose with overcast would be claiming a grey day is
    // brighter underfoot than open sun.
    let prev = Infinity
    for (let w = 0; w <= 1.0001; w += 0.05) {
      const v = overcastCurves(CLEAR, HEAVY, w).lightLevel
      expect(v).toBeLessThanOrEqual(prev)
      prev = v
    }
  })

  test('contrast and level are independent: neither end pins the other', () => {
    // Guards the axis separation itself rather than either curve. Holding the
    // light level flat must leave the shadow floor free to move, and vice
    // versa — if one were derived from the other this fails.
    const flatLevel = overcastCurves(CLEAR, { ...HEAVY, lightLevel: CLEAR.lightLevel }, 1)
    expect(flatLevel.lightLevel).toBeCloseTo(CLEAR.lightLevel, 12)
    expect(flatLevel.shadowValue).toBeCloseTo(HEAVY.shadowValue, 12)

    const flatFloor = overcastCurves(CLEAR, { ...HEAVY, shadowValue: CLEAR.shadowValue }, 1)
    expect(flatFloor.shadowValue).toBeCloseTo(CLEAR.shadowValue, 12)
    expect(flatFloor.lightLevel).toBeCloseTo(HEAVY.lightLevel, 12)
  })

  const CLEARC = { ...CLEAR, cloudCoverage: 2.86 }
  const HEAVYC = { ...HEAVY, cloudCoverage: 0.12 }
  const SHAPE = { onset: 0.30, full: 1.00 }
  const cloudFrac = r => (r.cloudCoverage - CLEARC.cloudCoverage) / (HEAVYC.cloudCoverage - CLEARC.cloudCoverage)
  const lightFrac = r => (r.lightLevel - CLEARC.lightLevel) / (HEAVYC.lightLevel - CLEARC.lightLevel)

  test('cloud amount answers to overcast directly — no window, no dead zone', () => {
    // Cloud amount's own weight is the raw scalar, so its fraction of the way
    // to the heavy end equals overcast exactly, whatever the LIGHT window's
    // onset/full happen to be set to.
    for (const w of [0, 0.2, 0.3, 0.45, 0.7, 1]) {
      const r = overcastCurves(CLEARC, HEAVYC, w, SHAPE, 1)
      expect(cloudFrac(r)).toBeCloseTo(w, 9)
    }
  })

  test('the light effects still hold off an almost-empty sky, independent of cloud amount', () => {
    // Below the light window's onset the light has not started greying. Cloud
    // amount is DELIBERATELY not held back the same way: at overcast 0.2 its
    // uCoverage is already a fifth of the way to the heavy end, while the
    // light stays flat.
    const r = overcastCurves(CLEARC, HEAVYC, 0.2, SHAPE, 1)
    expect(lightFrac(r)).toBeCloseTo(0, 12)
    expect(cloudFrac(r)).toBeCloseTo(0.2, 9)
    // Both ends still land exactly where they were authored, on both curves.
    expect(cloudFrac(overcastCurves(CLEARC, HEAVYC, 1, SHAPE, 1))).toBeCloseTo(1, 9)
    expect(lightFrac(overcastCurves(CLEARC, HEAVYC, 1, SHAPE, 1))).toBeCloseTo(1, 9)
  })

  test('raising the light window\'s onset does not widen cloud\'s own dead zone', () => {
    // Raising the onset for the light terms (0.30 -> 0.50) must not delay
    // cloud amount too: the light window moves freely and cloud amount's
    // fraction stays put.
    const lightOnsetLow  = { onset: 0.30, full: 1.00 }
    const lightOnsetHigh = { onset: 0.50, full: 1.00 }
    const atLow  = cloudFrac(overcastCurves(CLEARC, HEAVYC, 0.4, lightOnsetLow, 1))
    const atHigh = cloudFrac(overcastCurves(CLEARC, HEAVYC, 0.4, lightOnsetHigh, 1))
    expect(atLow).toBeCloseTo(atHigh, 12)
    expect(atLow).toBeCloseTo(0.4, 9)
  })

  test('density scales the EFFECTS and leaves the cloud amount alone', () => {
    // The second axis. A fully covered sky of thin cloud is a bright flat day:
    // same amount of cloud, a fraction of the effect on the light.
    const solid = overcastCurves(CLEARC, HEAVYC, 1, SHAPE, 1)
    const thin  = overcastCurves(CLEARC, HEAVYC, 1, SHAPE, 0.2)
    expect(cloudFrac(thin)).toBeCloseTo(cloudFrac(solid), 9)
    expect(lightFrac(thin)).toBeCloseTo(0.2, 9)
    // Every scalar effect scales, not just the one sampled above.
    for (const key of ['shadowValue', 'glow', 'shadowHueAmt', 'specAmt', 'reflectAmt']) {
      const frac = (CLEARC[key] === HEAVYC[key]) ? null
        : (thin[key] - CLEARC[key]) / (HEAVYC[key] - CLEARC[key])
      if (frac !== null) expect(frac).toBeCloseTo(0.2, 9)
    }
  })

  test('the clear end is exact at every density', () => {
    // Why the factor scales the WEIGHT and not the returned value: scaling the
    // value would drag the captured clear-weather look down with it, putting
    // the scene under a cloudless sky at a fifth of its authored light.
    for (const e of [0, 0.2, 0.5, 1]) {
      const r = overcastCurves(CLEARC, HEAVYC, 0, SHAPE, e)
      expect(r.lightLevel).toBeCloseTo(CLEARC.lightLevel, 12)
      expect(r.shadowValue).toBeCloseTo(CLEARC.shadowValue, 12)
      expect(r.cloudCoverage).toBeCloseTo(CLEARC.cloudCoverage, 12)
    }
  })

  test('a missing or out-of-range density factor never overshoots the heavy end', () => {
    // Default 1 is no scaling, and an out-of-range
    // factor clamps rather than driving a parameter past the value authored as
    // its end.
    expect(overcastCurves(CLEARC, HEAVYC, 1, SHAPE).lightLevel).toBeCloseTo(HEAVYC.lightLevel, 12)
    expect(overcastCurves(CLEARC, HEAVYC, 1, SHAPE, 9).lightLevel).toBeCloseTo(HEAVYC.lightLevel, 12)
    expect(overcastCurves(CLEARC, HEAVYC, 1, SHAPE, -9).lightLevel).toBeCloseTo(CLEARC.lightLevel, 12)
    expect(overcastCurves(CLEARC, HEAVYC, 1, SHAPE, NaN).lightLevel).toBeCloseTo(CLEARC.lightLevel, 12)
  })

  test('out-of-range input is clamped, not extrapolated past the heavy end', () => {
    expect(overcastCurves(CLEAR, HEAVY, 5).shadowValue).toBeCloseTo(HEAVY.shadowValue, 12)
    expect(overcastCurves(CLEAR, HEAVY, -5).shadowValue).toBeCloseTo(CLEAR.shadowValue, 12)
    expect(overcastCurves(CLEAR, HEAVY, NaN).shadowValue).toBeCloseTo(CLEAR.shadowValue, 12)
  })

  test('cloudGrey also answers to haze, independent of overcast', () => {
    // Haze reaches cloudGrey through a MAX with overcast's own weight, not a
    // sum: a clear-but-hazy sky (overcast 0) must still wash the cloud colour
    // out toward uCloudWeatherSky, which the horizon owner already keeps
    // haze-correct.
    const CLEARG = { ...CLEAR, cloudGrey: 0 }
    const HEAVYG = { ...HEAVY, cloudGrey: 1 }
    const clearHazy = overcastCurves(CLEARG, HEAVYG, 0, SHAPE, 1, 1)
    expect(clearHazy.cloudGrey).toBeCloseTo(HEAVYG.cloudGrey, 12)
    // Overcast alone (haze 0) reaches the heavy end on its own weight.
    const overcastOnly = overcastCurves(CLEARG, HEAVYG, 1, SHAPE, 1, 0)
    expect(overcastOnly.cloudGrey).toBeCloseTo(HEAVYG.cloudGrey, 12)
    // Both at 0: no wash at all.
    expect(overcastCurves(CLEARG, HEAVYG, 0, SHAPE, 1, 0).cloudGrey).toBeCloseTo(CLEARG.cloudGrey, 12)
    // Whichever is larger wins — max, not overshoot past the heavy end.
    const both = overcastCurves(CLEARG, HEAVYG, 1, SHAPE, 1, 1)
    expect(both.cloudGrey).toBeCloseTo(HEAVYG.cloudGrey, 12)
    // Every OTHER term stays haze-blind — this is cloudGrey's own axis, not a
    // second global weight.
    const r = overcastCurves(CLEARG, HEAVYG, 0, SHAPE, 1, 1)
    expect(r.lightLevel).toBeCloseTo(CLEARG.lightLevel, 12)
  })
})

describe('hazeCurves', () => {
  test('ends land on clear and heavy', () => {
    expect(hazeCurves(CLEAR, HEAVY, 0).fogCurve).toBeCloseTo(CLEAR.fogCurve, 12)
    expect(hazeCurves(CLEAR, HEAVY, 1).fogCurve).toBeCloseTo(HEAVY.fogCurve, 12)
    expect(hazeCurves(CLEAR, HEAVY, 1).aerialDesat).toBeCloseTo(HEAVY.aerialDesat, 12)
  })

  test('more haze means MORE fog at a fixed distance, not less', () => {
    // Independent ground truth, not a mirror of the shader: terrain.frag computes
    // the aerial ramp as pow(t, uFogCurve), so at any fixed t in (0,1) a smaller
    // exponent gives a LARGER ramp value. Assert that directly, because getting
    // this direction backwards is silent — the image just quietly clears up.
    const t = 0.5
    const clear = Math.pow(t, hazeCurves(CLEAR, HEAVY, 0).fogCurve)
    const foggy = Math.pow(t, hazeCurves(CLEAR, HEAVY, 1).fogCurve)
    expect(foggy).toBeGreaterThan(clear)
  })

  test('distance greying only ever rises with haze', () => {
    let prev = -Infinity
    for (let w = 0; w <= 1.0001; w += 0.05) {
      const v = hazeCurves(CLEAR, HEAVY, w).aerialDesat
      expect(v).toBeGreaterThanOrEqual(prev)
      prev = v
    }
  })
})

describe('mixHex', () => {
  test('ends return their own endpoint bit-exactly', () => {
    expect(mixHex(0xc8ddf0, 0x9aa3ab, 0)).toBe(0xc8ddf0)
    expect(mixHex(0xc8ddf0, 0x9aa3ab, 1)).toBe(0x9aa3ab)
  })

  test('blends each channel independently', () => {
    expect(mixHex(0x000000, 0xffffff, 0.5)).toBe(0x808080)
    expect(mixHex(0xff0000, 0x00ff00, 0.5)).toBe(0x808000)
  })

  test('never produces a channel outside a byte', () => {
    for (let i = 0; i <= 20; i++) {
      const v = mixHex(0xffffff, 0x000000, i / 20)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(0xffffff)
    }
  })
})

describe('lerp', () => {
  test('hits both ends and the midpoint', () => {
    expect(lerp(2, 6, 0)).toBe(2)
    expect(lerp(2, 6, 1)).toBe(6)
    expect(lerp(2, 6, 0.5)).toBe(4)
  })
})

describe('scaleHex', () => {
  test('k = 1 is the identity, so a clear day returns the authored colour', () => {
    // Load-bearing: the painted ground is expressed as authored * (level /
    // clearLevel), so at overcast 0 the ratio is 1 and the painting must come
    // back byte-identical rather than approximately.
    for (const hex of [0x000000, 0xc8bda4, 0xffffff, 0x123456]) {
      expect(scaleHex(hex, 1)).toBe(hex)
    }
  })

  test('it dims per channel, keeping hue rather than washing toward grey', () => {
    // A per-channel multiply is the physical model — reflected light is the
    // illuminant times the surface's reflectance — and it is what keeps a dim
    // colour the same colour. Scaling a luminance instead would keep it equally
    // vivid under less light, which is the one thing dimming is not.
    expect(scaleHex(0x804020, 0.5)).toBe(0x402010)
  })

  test('brightening saturates at white instead of wrapping to black', () => {
    // A bare `& 0xff` would turn an overbright channel into a dark one, which
    // reads as a colour inversion rather than as more light. The shipped clear
    // light level (1.11) is above 1, so this path is reachable.
    expect(scaleHex(0xc0c0c0, 4)).toBe(0xffffff)
  })

  test('a junk scale is treated as no scaling, not as black', () => {
    expect(scaleHex(0xc8bda4, NaN)).toBe(0xc8bda4)
    expect(scaleHex(0xc8bda4, -1)).toBe(0x000000)
  })
})
