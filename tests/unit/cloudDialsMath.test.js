import { describe, it, expect } from 'vitest'
import {
  scatterToBaseFreq,
  densityToAbsorption, densityToRayScale, densityToShadowScale, densityToShadowDepth, absorptionToDensity,
  SCATTER_FREQ_LO, SCATTER_FREQ_HI,
  DENSITY_ABSORPTION_LO, DENSITY_ABSORPTION_HI,
  DENSITY_RAY_SCALE_LO, DENSITY_RAY_SCALE_HI,
} from '../../src/drift/cloudDialsMath.js'

/**
 * The endpoints are hand-set rather than derived, so they are pinned
 * EXACTLY — that is the whole content of these maps and a silent drift in one
 * is a silent change to the look. The properties around them (monotone,
 * clamped, round-trips) are asserted separately so a retune of an endpoint
 * moves one assertion rather than reds the file.
 */
describe('cloud scatter dial', () => {
  it('hits the stated endpoints exactly', () => {
    expect(scatterToBaseFreq(0)).toBe(0.005)
    expect(scatterToBaseFreq(1)).toBe(0.010)
  })

  it('is monotone increasing — more scatter means a finer, more broken field', () => {
    let prev = -Infinity
    for (let t = 0; t <= 1.0001; t += 0.05) {
      const f = scatterToBaseFreq(t)
      expect(f).toBeGreaterThan(prev)
      prev = f
    }
  })

  it('clamps out-of-range positions instead of extrapolating', () => {
    expect(scatterToBaseFreq(-5)).toBe(SCATTER_FREQ_LO)
    expect(scatterToBaseFreq(37)).toBe(SCATTER_FREQ_HI)
  })

  it('treats a non-finite position as the low end rather than emitting NaN', () => {
    // A NaN here would reach uBaseFreq and take the whole baked volume with it.
    expect(scatterToBaseFreq(NaN)).toBe(SCATTER_FREQ_LO)
    expect(scatterToBaseFreq(undefined)).toBe(SCATTER_FREQ_LO)
  })

  it('stays inside the grid Nyquist limit at the fine end', () => {
    // cloudVolumeMath.maxSafeFrequency(cell) = SNOISE_WAVELENGTH / (2*cell).
    // At the shipped 16-unit cell that is ~0.0532, so the whole range is
    // representable and the top of the dial costs octaves, never aliasing.
    const maxSafeAt16 = 1.7021 / (2 * 16)
    expect(SCATTER_FREQ_HI).toBeLessThan(maxSafeAt16)
  })
})

describe('cloud density dial', () => {
  it('hits the stated absorption endpoints exactly', () => {
    expect(densityToAbsorption(0)).toBe(0.005)
    expect(densityToAbsorption(1)).toBe(0.075)
  })

  it('hits the stated shaft-brightness endpoints exactly', () => {
    expect(densityToRayScale(0)).toBe(0.25)
    expect(densityToRayScale(1)).toBe(2.5)
  })

  it('moves absorption and shaft brightness the SAME way', () => {
    // The point of folding them into one dial: a denser deck reads as harder
    // beams, not softer ones. Opposite slopes here would mean the dial is
    // fighting itself.
    for (const t of [0.1, 0.4, 0.9]) {
      expect(densityToAbsorption(t)).toBeGreaterThan(densityToAbsorption(t - 0.1))
      expect(densityToRayScale(t)).toBeGreaterThan(densityToRayScale(t - 0.1))
    }
  })

  it('leaves the shafts attenuated below the dial midpoint and boosted above', () => {
    // A relationship, not a threshold: whatever the endpoints are retuned to,
    // 1.0 (shafts untouched) has to lie strictly inside the range or the dial
    // can only ever brighten or only ever dim.
    expect(DENSITY_RAY_SCALE_LO).toBeLessThan(1)
    expect(DENSITY_RAY_SCALE_HI).toBeGreaterThan(1)
  })

  it('clamps out-of-range positions on both outputs', () => {
    expect(densityToAbsorption(-1)).toBe(DENSITY_ABSORPTION_LO)
    expect(densityToAbsorption(2)).toBe(DENSITY_ABSORPTION_HI)
    expect(densityToRayScale(-1)).toBe(DENSITY_RAY_SCALE_LO)
    expect(densityToRayScale(2)).toBe(DENSITY_RAY_SCALE_HI)
  })

  it('hits the stated cloud-shadow endpoints exactly', () => {
    // Full density leaves the shadow slider alone (the shipped look), and the
    // thin end lightens it to a quarter — a stated relationship, not a
    // tuning threshold: the shadow is a consequence of the same opacity
    // absorption sets, so it must not be free to move independently.
    expect(densityToShadowScale(1)).toBe(1)
    expect(densityToShadowScale(0)).toBe(0.25)
  })

  it('never scales the cloud shadow to zero', () => {
    // 0 would trip terrain.frag's amount-0 early-out and remove the shadow
    // term entirely; the thin end is meant to be weak modelling, not flat light.
    for (const t of [0, 0.01, 0.5, 1]) expect(densityToShadowScale(t)).toBeGreaterThan(0)
  })

  it('moves the shadow the same way as absorption', () => {
    for (const t of [0.1, 0.4, 0.9]) {
      expect(densityToShadowScale(t)).toBeGreaterThan(densityToShadowScale(t - 0.1))
    }
  })

  it('round-trips absorption through its inverse', () => {
    for (const t of [0, 0.25, 0.6, 1]) {
      expect(absorptionToDensity(densityToAbsorption(t))).toBeCloseTo(t, 12)
    }
  })
})

describe('the absorption inverse', () => {
  it('reads a non-finite absorption as the low end', () => {
    expect(absorptionToDensity(undefined)).toBe(0)
  })

  it('clamps an absorption outside the span to the nearest end', () => {
    expect(absorptionToDensity(DENSITY_ABSORPTION_LO / 2)).toBe(0)
    expect(absorptionToDensity(DENSITY_ABSORPTION_HI * 2)).toBe(1)
  })
})

describe('densityToShadowDepth — shadow depth tracks density directly, not a scale', () => {
  it('hits the stated endpoints exactly', () => {
    expect(densityToShadowDepth(0)).toBe(0)
    expect(densityToShadowDepth(1)).toBe(1)
  })

  it('is the identity in between', () => {
    for (const t of [0.1, 0.4, 0.75]) expect(densityToShadowDepth(t)).toBeCloseTo(t, 12)
  })

  it('clamps out-of-range and non-finite input', () => {
    expect(densityToShadowDepth(-1)).toBe(0)
    expect(densityToShadowDepth(2)).toBe(1)
    expect(densityToShadowDepth(NaN)).toBe(0)
  })
})
