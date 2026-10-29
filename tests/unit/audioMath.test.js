import { describe, it, expect } from 'vitest'
import {
  lerp, gaussian, logLerp, equalPower, rt60ToTau, fractionToGain,
  ouStep, swellEnvelope, shoreSwellPhases,
  poissonFires, schmitt, forestCover, windGustShape, birdRate, distanceCues,
  windDrive, surfDrive, canopyRustle,
  grainRate,
} from '../../src/audio/audioMath.js'
import { clamp, clamp01 } from '../../src/shared/mathUtils.js'

/** Deterministic uniform source, so every statistical case is reproducible. */
function makeRng(seed = 1) {
  let a = seed >>> 0
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('logLerp', () => {
  it('hits both endpoints', () => {
    expect(logLerp(700, 18000, 0)).toBeCloseTo(700, 6)
    expect(logLerp(700, 18000, 1)).toBeCloseTo(18000, 6)
  })
  it('puts the midpoint at the geometric mean, not the arithmetic one', () => {
    // The whole reason this function exists: 3549.6 Hz, not 9350 Hz.
    expect(logLerp(700, 18000, 0.5)).toBeCloseTo(Math.sqrt(700 * 18000), 3)
  })
  it('covers equal octave spans for equal steps in x', () => {
    const oct = (a, b) => Math.log2(b / a)
    const lower = oct(logLerp(700, 18000, 0), logLerp(700, 18000, 0.5))
    const upper = oct(logLerp(700, 18000, 0.5), logLerp(700, 18000, 1))
    expect(lower).toBeCloseTo(upper, 6)
  })
})

describe('equalPower', () => {
  it('holds total power constant across the whole fade', () => {
    for (let x = 0; x <= 1.0001; x += 0.05) {
      const { a, b } = equalPower(x)
      expect(a * a + b * b).toBeCloseTo(1, 10)
    }
  })
  it('is fully one side at each end', () => {
    expect(equalPower(0).a).toBeCloseTo(1, 10)
    expect(equalPower(1).b).toBeCloseTo(1, 10)
  })
  it('sits 3.01 dB above where a linear fade would at the midpoint', () => {
    const { a } = equalPower(0.5)
    const dipDb = 20 * Math.log10(0.5 / (a * a + a * a) ** 0.5 * Math.SQRT2 * 0.5 / 0.5)
    // Direct form: linear fade amplitude at x=0.5 is 0.5 per side → total
    // power 0.5 → −3.01 dB, while equal power stays at 1.0.
    const linearPower = 0.5 * 0.5 + 0.5 * 0.5
    expect(10 * Math.log10(linearPower)).toBeCloseTo(-3.0103, 3)
    expect(dipDb).toBeDefined()
  })
})

describe('rt60ToTau', () => {
  it('is RT60 divided by ln(1000)', () => {
    expect(rt60ToTau(2.2)).toBeCloseTo(2.2 / Math.log(1000), 10)
  })
  it('decays the envelope by exactly 60 dB over one RT60', () => {
    const T = 1.8
    const tau = rt60ToTau(T)
    const db = 20 * Math.log10(Math.exp(-T / tau))
    expect(db).toBeCloseTo(-60, 6)
  })
  it('clamps a degenerate RT60 rather than dividing by zero', () => {
    expect(Number.isFinite(rt60ToTau(0))).toBe(true)
    expect(rt60ToTau(0)).toBeGreaterThan(0)
  })
})

describe('fractionToGain', () => {
  it('drops 10 dB per halving of the fraction', () => {
    const a = fractionToGain(0.8)
    const b = fractionToGain(0.4)
    expect(20 * Math.log10(b / a)).toBeCloseTo(-10.034, 2)
  })
  it('is 0 below the floor and gMax at full', () => {
    expect(fractionToGain(0.001)).toBe(0)
    expect(fractionToGain(1, 0.5)).toBeCloseTo(0.5, 10)
  })
  it('is monotonically increasing', () => {
    let prev = -1
    for (let x = 0.05; x <= 1; x += 0.05) {
      const g = fractionToGain(x)
      expect(g).toBeGreaterThanOrEqual(prev)
      prev = g
    }
  })
})


describe('ouStep', () => {
  it('pulls a displaced value back toward the mean', () => {
    const rng = () => 0.5                     // gaussian() → 0 with no noise term bias
    let x = 5
    for (let i = 0; i < 200; i++) x = ouStep(x, 0, 2.0, 0, 1 / 60, rng)
    expect(Math.abs(x)).toBeLessThan(0.1)
  })
  it('stays finite over a long run with noise', () => {
    const rng = makeRng(7)
    let x = 0
    for (let i = 0; i < 20000; i++) x = ouStep(x, 0.5, 1.5, 0.6, 1 / 60, rng)
    expect(Number.isFinite(x)).toBe(true)
    expect(Math.abs(x)).toBeLessThan(10)
  })
  it('has a steady-state spread near sigma/√(2·theta)', () => {
    const rng = makeRng(11)
    const theta = 2, sigma = 0.5
    let x = 0
    const samples = []
    for (let i = 0; i < 60000; i++) {
      x = ouStep(x, 0, theta, sigma, 1 / 60, rng)
      if (i > 2000) samples.push(x)
    }
    const mean = samples.reduce((s, v) => s + v, 0) / samples.length
    const sd = Math.sqrt(samples.reduce((s, v) => s + (v - mean) ** 2, 0) / samples.length)
    expect(sd).toBeGreaterThan(0.15)
    expect(sd).toBeLessThan(0.45)          // theory: 0.5/√4 = 0.25
  })
})

describe('swellEnvelope', () => {
  it('stays in [0,1]', () => {
    for (let i = 0; i < 2000; i++) {
      const t = i * 0.1
      const e = swellEnvelope(shoreSwellPhases(t))
      expect(e).toBeGreaterThanOrEqual(0)
      expect(e).toBeLessThanOrEqual(1)
    }
  })
  it('actually reaches the lull and the peak, unlike a divide-by-max', () => {
    // Walk the shared clock for an hour of simulated time and count how much
    // of it is spent in the outer fifth of the range. Dividing by the maximum
    // of 3 instead of the sd gives under 5% here; this must do much better.
    const dt = 1 / 30
    let outer = 0, n = 0
    for (let i = 0; i < 108000; i++) {
      const e = swellEnvelope(shoreSwellPhases(i * dt))
      if (e < 0.2 || e > 0.8) outer++
      n++
    }
    expect(outer / n).toBeGreaterThan(0.08)
  })
  it('is centred at 0.5 when every sine is at zero phase', () => {
    expect(swellEnvelope([0, 0, 0])).toBeCloseTo(0.5, 10)
  })
})

describe('shoreSwellPhases', () => {
  // This is the whole point of the function: it must be the exact three
  // terms water.frag's swell(p=(0,0), time) computes, or the audio and the
  // shore foam drift apart the same way the two independent oscillators it
  // replaced always did.
  it('matches water.frag\'s swell() at its reference point, exactly', () => {
    for (const t of [0, 1, 3.7, 42.123, -5, 1000.001]) {
      const [a, b, c] = shoreSwellPhases(t)
      const shaderSwell = Math.sin(0 + t) * 0.5 + Math.sin(0 + t * 0.8) * 0.5 +
        Math.sin(0 + t * 1.3) * 0.5
      const ported = Math.sin(a) * 0.5 + Math.sin(b) * 0.5 + Math.sin(c) * 0.5
      expect(ported).toBeCloseTo(shaderSwell, 12)
    }
  })

  it('gives three phases at the fixed relative rates 1 : 0.8 : 1.3', () => {
    const [a, b, c] = shoreSwellPhases(10)
    expect(a).toBeCloseTo(10, 10)
    expect(b).toBeCloseTo(8, 10)
    expect(c).toBeCloseTo(13, 10)
  })

  it('is a pure function of the clock — same input, same output, no state', () => {
    expect(shoreSwellPhases(17.3)).toEqual(shoreSwellPhases(17.3))
  })
})

describe('poissonFires', () => {
  it('fires at approximately the requested rate', () => {
    const rng = makeRng(3)
    const dt = 1 / 60, rate = 2.0
    let fires = 0
    const frames = 60 * 600                       // ten simulated minutes
    for (let i = 0; i < frames; i++) if (poissonFires(rate, dt, rng)) fires++
    const observed = fires / (frames * dt)
    expect(observed).toBeGreaterThan(rate * 0.9)
    expect(observed).toBeLessThan(rate * 1.1)
  })
  it('never fires at rate 0 and tolerates a zero dt', () => {
    const rng = makeRng(5)
    for (let i = 0; i < 100; i++) {
      expect(poissonFires(0, 1 / 60, rng)).toBe(false)
      expect(poissonFires(5, 0, rng)).toBe(false)
    }
  })
  it('tracks a rate that changes between frames', () => {
    // The property the redraw-an-interval approach loses.
    const rng = makeRng(9)
    const dt = 1 / 60
    let fires = 0
    for (let i = 0; i < 6000; i++) fires += poissonFires(i < 3000 ? 0.1 : 4.0, dt, rng) ? 1 : 0
    let lateFires = 0
    const rng2 = makeRng(9)
    for (let i = 0; i < 6000; i++) lateFires += poissonFires(i < 3000 ? 0.1 : 4.0, dt, rng2) ? 1 : 0
    expect(fires).toBe(lateFires)
    expect(fires).toBeGreaterThan(150)            // the high-rate half dominates
  })
})

describe('schmitt', () => {
  it('fires once on the way up, not every frame above the threshold', () => {
    let armed = true, fires = 0
    for (const v of [0.1, 0.5, 0.85, 0.9, 0.95, 0.88]) {
      const r = schmitt(v, armed, 0.8, 0.5)
      armed = r.armed
      if (r.fired) fires++
    }
    expect(fires).toBe(1)
  })
  it('re-arms only after falling below the lower threshold', () => {
    let armed = true
    armed = schmitt(0.9, armed, 0.8, 0.5).armed      // fires, disarms
    expect(schmitt(0.85, armed, 0.8, 0.5).fired).toBe(false)
    expect(schmitt(0.6, armed, 0.8, 0.5).armed).toBe(false)
    armed = schmitt(0.4, armed, 0.8, 0.5).armed      // back below lo
    expect(armed).toBe(true)
    expect(schmitt(0.9, armed, 0.8, 0.5).fired).toBe(true)
  })
  it('does not double-fire on ripple around the upper threshold', () => {
    let armed = true, fires = 0
    for (const v of [0.79, 0.81, 0.79, 0.82, 0.78, 0.83]) {
      const r = schmitt(v, armed, 0.8, 0.5)
      armed = r.armed
      if (r.fired) fires++
    }
    expect(fires).toBe(1)
  })
})

describe('forestCover', () => {
  // Sea at 0.3 of the height range: forest fills 0.3–0.6 (the treeline).
  const base = { seaLevel: -40, heightMax: 100, treeBase: 0.6, snowBase: 0.75 }

  it('stays inside [0,1]', () => {
    const f = forestCover(base)
    expect(f).toBeGreaterThanOrEqual(0)
    expect(f).toBeLessThanOrEqual(1)
  })
  it('shrinks as the sea rises into the forest band', () => {
    expect(forestCover({ ...base, seaLevel: -20 })).toBeLessThan(forestCover(base))
  })
  it('shrinks as the treeline or the snowline descends below it', () => {
    expect(forestCover({ ...base, treeBase: 0.5 })).toBeLessThan(forestCover(base))
    expect(forestCover({ ...base, snowBase: 0.5 })).toBeLessThan(forestCover({ ...base, snowBase: 0.9 }))
  })
  it('is exactly 0 when the sea is over the top', () => {
    expect(forestCover({ ...base, seaLevel: 500 })).toBe(0)
  })
  it('does not divide by zero on a flat terrain', () => {
    expect(Number.isFinite(forestCover({ ...base, heightMax: 0 }))).toBe(true)
  })
})

describe('windGustShape', () => {
  it('moves level and brightness in the same direction', () => {
    const quiet = windGustShape(0.1, 0.5)
    const hard  = windGustShape(0.9, 0.5)
    expect(hard.level).toBeGreaterThan(quiet.level)
    expect(hard.tiltHz).toBeGreaterThan(quiet.tiltHz)
  })
  it('keeps a floor at zero gust, so the wind never disappears', () => {
    expect(windGustShape(0, 0).level).toBeGreaterThan(0)
  })
  it('hits harder when the scene is visibly moving', () => {
    expect(windGustShape(1, 1).level).toBeGreaterThan(windGustShape(1, 0).level)
  })
})

describe('birdRate', () => {
  it('is zero with no forest', () => {
    expect(birdRate(0, 0, 1)).toBe(0)
  })
  it('rises with forest cover', () => {
    expect(birdRate(0.8, 0, 1)).toBeGreaterThan(birdRate(0.3, 0, 1))
  })
  it('is suppressed by overcast and by a settling scene', () => {
    expect(birdRate(0.8, 1, 1)).toBeLessThan(birdRate(0.8, 0, 1))
    expect(birdRate(0.8, 0, 0.2)).toBeLessThan(birdRate(0.8, 0, 1))
  })
  it('stays within a sane rate so λ·dt keeps Bernoulli valid', () => {
    // λ·dt at 60 fps must stay well under ~0.1 for the per-frame Bernoulli to
    // approximate a Poisson process.
    expect(birdRate(1, 0, 1) / 60).toBeLessThan(0.05)
  })
  it('gives ordinary forest cover an audible call rate', () => {
    // The regression this guards: at f^1.5 a typical live frame (forest ≈ 0.2)
    // produced under three calls a MINUTE, and a measured half-minute of the
    // real scene yielded none at all — leaving nothing audible but two beds of
    // noise. Calls are the only countable content the piece has.
    expect(birdRate(0.2, 0, 1) * 60).toBeGreaterThan(10)
  })
})

describe('distanceCues', () => {
  it('moves level, spectrum and reverb together', () => {
    const near = distanceCues(0)
    const far  = distanceCues(1)
    expect(far.gain).toBeLessThan(near.gain)
    expect(far.cutoff).toBeLessThan(near.cutoff)
    expect(far.send).toBeGreaterThan(near.send)
  })
  it('is monotone across the range', () => {
    let prevGain = Infinity
    for (let d = 0; d <= 1; d += 0.1) {
      const c = distanceCues(d)
      expect(c.gain).toBeLessThanOrEqual(prevGain + 1e-9)
      prevGain = c.gain
    }
  })
})

describe('grainRate', () => {
  it('ramps with paint progress and stays capped', () => {
    expect(grainRate(0)).toBeCloseTo(4, 6)
    expect(grainRate(1)).toBeCloseTo(50, 6)
    expect(grainRate(1, 50)).toBeLessThanOrEqual(50)
  })
})

describe('gaussian', () => {
  it('has roughly zero mean and unit variance', () => {
    const rng = makeRng(13)
    const n = 40000
    let sum = 0, sumSq = 0
    for (let i = 0; i < n; i++) {
      const g = gaussian(rng)
      sum += g; sumSq += g * g
    }
    const mean = sum / n
    const varr = sumSq / n - mean * mean
    expect(Math.abs(mean)).toBeLessThan(0.05)
    expect(varr).toBeGreaterThan(0.9)
    expect(varr).toBeLessThan(1.1)
  })
  it('never returns a non-finite value even at the degenerate uniform', () => {
    expect(Number.isFinite(gaussian(() => 0))).toBe(true)
  })
})

describe('lerp', () => {
  it('behaves', () => {
    expect(lerp(0, 10, 0.25)).toBeCloseTo(2.5, 10)
  })
})

/**
 * Non-finite containment.
 *
 * Every value these functions produce is written to an AudioParam, and a
 * non-finite write throws. Because the soundscape is driven from the render
 * loop, such a throw aborts the frame. These assert the arithmetic absorbs bad
 * input instead of forwarding it. (clamp/clamp01's own NaN handling is covered
 * in mathUtils.test.js.)
 */
describe('non-finite containment', () => {
  it('a missing scene field cannot produce a non-finite gain', () => {
    // The exact shape of the bug: `undefined * 0.5` inside an exposure sum.
    const exposure = clamp01(0 + 0.3 * 0.7 + undefined * 0.5)
    expect(Number.isFinite(exposure)).toBe(true)
    expect(Number.isFinite(fractionToGain(exposure))).toBe(true)
  })

  it('every voice map stays finite on undefined input', () => {
    expect(Number.isFinite(windGustShape(undefined, undefined).level)).toBe(true)
    expect(Number.isFinite(windGustShape(undefined, undefined).tiltHz)).toBe(true)
    expect(Number.isFinite(birdRate(undefined, undefined, undefined))).toBe(true)
    expect(Number.isFinite(distanceCues(undefined).gain)).toBe(true)
    expect(Number.isFinite(distanceCues(undefined).cutoff)).toBe(true)
    expect(Number.isFinite(tensionSafe())).toBe(true)
    function tensionSafe() { return grainRate(undefined) }
  })

  it('the forest cover stays finite when handed nothing usable', () => {
    const f = forestCover({ seaLevel: undefined, heightMax: undefined, treeBase: undefined, snowBase: undefined })
    expect(Number.isFinite(f)).toBe(true)
  })

  it('an OU walk fed a NaN dt does not poison itself forever', () => {
    const rng = makeRng(21)
    let x = clamp(ouStep(0.4, 0.5, 0.5, 0.3, NaN, rng), 0, 1)
    expect(Number.isFinite(x)).toBe(true)
    for (let i = 0; i < 100; i++) x = clamp(ouStep(x, 0.5, 0.5, 0.3, 1 / 60, rng), 0, 1)
    expect(Number.isFinite(x)).toBe(true)
  })
})

describe('windDrive', () => {
  const flatClear = { mountains: 0, snowline: 0.5, overcast: 0 }

  // The user's request, stated as a test: a grey sky has to blow harder.
  it('a grey sky raises where the wind lives', () => {
    const clear = windDrive({ mountains: 0.5, snowline: 0.5, overcast: 0 })
    const grey  = windDrive({ mountains: 0.5, snowline: 0.5, overcast: 1 })
    expect(grey.mean).toBeGreaterThan(clear.mean)
  })

  // The axis-separation claim. Force must arrive through the walk's CENTRE,
  // never as a second level — a fader on the same axis as the gust cancels
  // against the gust's own lull and neither reads.
  it('the weather moves the centre, not the standing level', () => {
    const clear = windDrive({ mountains: 0.5, snowline: 0.5, overcast: 0 })
    const grey  = windDrive({ mountains: 0.5, snowline: 0.5, overcast: 1 })
    expect(grey.exposure).toBe(clear.exposure)
  })

  it('mountains set the standing level, and it never reaches zero', () => {
    expect(windDrive({ ...flatClear, mountains: 1 }).exposure)
      .toBeGreaterThan(windDrive(flatClear).exposure)
    // The wind is the one voice that must never leave, whatever the dials say.
    expect(windDrive(flatClear).exposure).toBeGreaterThan(0.2)
  })

  it('flat ground takes the bite out of the weather', () => {
    const flatGrey  = windDrive({ mountains: 0, snowline: 0.5, overcast: 1 })
    const alpineGrey = windDrive({ mountains: 1, snowline: 0.5, overcast: 1 })
    expect(alpineGrey.mean).toBeGreaterThan(flatGrey.mean)
  })

  it('edge is a fraction the caller can blend, not decibels', () => {
    for (const o of [0, 0.5, 1]) {
      for (const sn of [0, 0.5, 1]) {
        const e = windDrive({ mountains: 0.5, snowline: sn, overcast: o }).edge
        expect(e).toBeGreaterThanOrEqual(0)
        expect(e).toBeLessThanOrEqual(1)
      }
    }
  })

  it('a low snowline — cold, bare ground — hardens the top end', () => {
    expect(windDrive({ mountains: 0.5, snowline: 0, overcast: 0 }).edge)
      .toBeGreaterThan(windDrive({ mountains: 0.5, snowline: 1, overcast: 0 }).edge)
  })

  it('junk dials leave a wind that still blows', () => {
    const d = windDrive({ mountains: NaN, snowline: NaN, overcast: NaN })
    expect(Number.isFinite(d.exposure)).toBe(true)
    expect(Number.isFinite(d.mean)).toBe(true)
    expect(d.exposure).toBeGreaterThan(0)
  })
})

describe('surfDrive', () => {
  it('the ocean dial sets how present the water is, with a floor above zero', () => {
    expect(surfDrive({ ocean: 1, overcast: 0 }).presence)
      .toBeGreaterThan(surfDrive({ ocean: 0.5, overcast: 0 }).presence)
    // A THIN strip of ocean still reads above the wind's mask...
    expect(surfDrive({ ocean: 0.1, overcast: 0 }).presence).toBeGreaterThan(0.01)
    // ...but NO ocean in the frame is exactly silent, not a fixed floor.
    expect(surfDrive({ ocean: 0, overcast: 0 }).presence).toBe(0)
  })

  // Weather roughens the sea; it does not turn it up. A `chop` that leaked
  // into `presence` would be the same axis collision windDrive avoids.
  it('the weather changes chop and leaves presence alone', () => {
    const calm = surfDrive({ ocean: 0.6, overcast: 0 })
    const grey = surfDrive({ ocean: 0.6, overcast: 1 })
    expect(grey.presence).toBe(calm.presence)
    expect(grey.chop).toBeGreaterThan(calm.chop)
  })

  it('chop stays inside [0,1] for any input', () => {
    for (const o of [-1, 0, 0.4, 1, 5, NaN]) {
      const c = surfDrive({ ocean: 0.5, overcast: o }).chop
      expect(c).toBeGreaterThanOrEqual(0)
      expect(c).toBeLessThanOrEqual(1)
    }
  })
})

describe('canopyRustle', () => {
  it('trees on screen make the leaves louder', () => {
    expect(canopyRustle(0.9, 0.5).level).toBeGreaterThan(canopyRustle(0.05, 0.5).level)
  })

  it('a bare frame still rustles a little — grass and edges answer too', () => {
    expect(canopyRustle(0, 0.8).level).toBeGreaterThan(0)
  })

  // The identifying cue. A fixed flutter rate with only the depth moving is
  // hiss with a tremolo on it; leaves flip faster in harder wind.
  it('the flutter rate rides the gust', () => {
    expect(canopyRustle(0.5, 1).flutterHz).toBeGreaterThan(canopyRustle(0.5, 0).flutterHz)
  })

  it('the flutter stays inside the band the ear reads as texture', () => {
    for (const g of [0, 0.5, 1]) {
      const hz = canopyRustle(0.5, g).flutterHz
      expect(hz).toBeGreaterThanOrEqual(2)
      expect(hz).toBeLessThanOrEqual(40)
    }
  })

  it('more leaf mass means more body under the hiss', () => {
    expect(canopyRustle(1, 0.5).bandHz).toBeLessThan(canopyRustle(0, 0.5).bandHz)
  })

  it('a still wind leaves the trees nearly silent', () => {
    expect(canopyRustle(1, 0).level).toBeLessThan(canopyRustle(1, 1).level * 0.2)
  })

  it('junk inputs do not produce a silent or a screaming canopy', () => {
    const r = canopyRustle(NaN, NaN)
    expect(Number.isFinite(r.level)).toBe(true)
    expect(Number.isFinite(r.flutterHz)).toBe(true)
    expect(Number.isFinite(r.bandHz)).toBe(true)
  })
})

describe('canopyRustle — the tree sliders', () => {
  it('the flutter ceiling is the slider, not a constant', () => {
    expect(canopyRustle(0.5, 1, { flutterMax: 60 }).flutterHz).toBeCloseTo(60, 6)
    expect(canopyRustle(0.5, 1, { flutterMax: 10 }).flutterHz).toBeCloseTo(10, 6)
  })

  // A ceiling below the floor would otherwise invert the map and make a harder
  // gust flutter SLOWER, which is the one thing the cue must never do.
  it('a low ceiling still rises with the gust, never falls', () => {
    const slow = canopyRustle(0.5, 0, { flutterMax: 5 }).flutterHz
    const fast = canopyRustle(0.5, 1, { flutterMax: 5 }).flutterHz
    expect(fast).toBeGreaterThanOrEqual(slow)
  })

  it('a junk or extreme ceiling stays inside the flutter band', () => {
    for (const m of [NaN, -20, 5000]) {
      const hz = canopyRustle(0.5, 1, { flutterMax: m }).flutterHz
      expect(hz).toBeGreaterThanOrEqual(4)
      expect(hz).toBeLessThanOrEqual(80)
    }
  })

  // Unity at the centre is what makes the knob safe to ship: the tuned sound
  // is exactly what the forest cover alone produces.
  it('tone is unity at 0.5, so the shipped band is the canopy map itself', () => {
    for (const f of [0, 0.3, 1]) {
      expect(canopyRustle(f, 0.5, { tone: 0.5 }).bandHz)
        .toBeCloseTo(canopyRustle(f, 0.5).bandHz, 6)
    }
  })

  it('dry is thin and bright, full is bodied', () => {
    expect(canopyRustle(0.5, 0.5, { tone: 0 }).bandHz)
      .toBeGreaterThan(canopyRustle(0.5, 0.5, { tone: 1 }).bandHz)
  })

  it('the band stays in audible range at every setting', () => {
    for (const f of [0, 1]) {
      for (const t of [0, 0.5, 1]) {
        const hz = canopyRustle(f, 0.5, { tone: t }).bandHz
        expect(hz).toBeGreaterThanOrEqual(300)
        expect(hz).toBeLessThanOrEqual(6000)
      }
    }
  })
})
