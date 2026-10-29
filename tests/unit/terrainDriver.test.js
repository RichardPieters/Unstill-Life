import { describe, it, expect } from 'vitest'
import { TerrainDriver } from '../../src/terrain/terrainDriver.js'

// Fakes — no THREE, no GPU. The driver only needs uniform objects with .value
// (drift offsets are vec2-like {value:{x,y}}) and an EventTarget.
function makeUniforms() {
  return {
    uFBM0Persistence: { value: 0.65 }, uFBM0Lacunarity: { value: 1.8 },
    uFBM1Persistence: { value: 0.55 }, uFBM1Lacunarity: { value: 1.9 },
    uFBM0Amp: { value: 83 }, uFBM1Amp: { value: 75.5 },
    uFBM0DriftX: { value: 1 }, uFBM0DriftZ: { value: 0 },
    uFBM1DriftX: { value: 0 }, uFBM1DriftZ: { value: 0 },
    uFBM0DriftOffset: { value: { x: 0, y: 0 } },
    uFBM1DriftOffset: { value: { x: 0, y: 0 } },
    uHeightMax: { value: 0 },
    uRidgeRound: { value: 0.03 },
    uFBM0Octaves: { value: 3 }, uFBM1Octaves: { value: 3 },
    uBedrockOctaves: { value: 6 },
    uMantleRelief: { value: 0.45 }, uMantleDC: { value: 0 },
    uRockPersist: { value: 0.5 },
    uTime: { value: 0 },
  }
}
function makeHeightmap() {
  return {
    uErosionDetail:   { value: 2.5 },
    uErosionEnabled:  { value: true },
    uErosionStrength: { value: 0.30 },
    uErosionScale:    { value: 0.17 },
  }
}
function build() {
  const dyn = new EventTarget()
  const u = makeUniforms(), hu = makeHeightmap()
  const d = new TerrainDriver(dyn, u, hu)
  // dt is part of the tick contract (drift advances on it); default it so
  // tests that don't care about drift needn't spell it out. Drift tests override.
  const tick = (detail) => dyn.dispatchEvent(new CustomEvent('tick', { detail: { dt: 0.1, ...detail } }))
  return { dyn, u, hu, d, tick }
}

describe('TerrainDriver', () => {
  it('frozen → the whole tick is a no-op', () => {
    const { u, d, tick } = build()
    d.settings.frozen = true
    const before = JSON.stringify(u)
    tick({ noiseTime: 5, momentum: 0.8, restlessness: 0.1 })
    expect(JSON.stringify(u)).toBe(before)   // nothing written
  })

  it('uHeightMax tracks amps + erosion (constant-dependency), and drops when erosion off', () => {
    const { u, hu, tick } = build()
    tick({ noiseTime: 1, momentum: 0.5, restlessness: 1 })
    const withErosion = u.uHeightMax.value
    expect(withErosion).toBeGreaterThan(u.uFBM0Amp.value + u.uFBM1Amp.value)   // has margin
    hu.uErosionEnabled.value = false
    tick({ noiseTime: 2, momentum: 0.5, restlessness: 1 })
    expect(u.uHeightMax.value).toBeCloseTo(u.uFBM0Amp.value + u.uFBM1Amp.value, 5)  // no margin
    expect(u.uHeightMax.value).toBeLessThan(withErosion)
    // responds to an amp change (not a frozen constant)
    hu.uErosionEnabled.value = true
    u.uFBM0Amp.value = 120
    tick({ noiseTime: 3, momentum: 0.5, restlessness: 1 })
    expect(u.uHeightMax.value).toBeGreaterThan(withErosion)
  })

  it('uMantleDC tracks a live persistence change (not baked at construction)', () => {
    const { u, tick } = build()
    tick({ noiseTime: 1, momentum: 0, restlessness: 1 })
    const calm = u.uMantleDC.value
    expect(calm).toBeGreaterThan(0)   // max() only ever raises

    // Persistence is a hand-tunable slider — a baked constant here would drag
    // every biome band out of sync the instant someone drags it.
    u.uFBM0Persistence.value = 0.36
    tick({ noiseTime: 2, momentum: 0, restlessness: 1 })
    expect(u.uMantleDC.value).not.toBeCloseTo(calm, 2)
  })

  it('uMantleDC falls as the relief ratio rises (less gap between the fields)', () => {
    const { u, tick } = build()
    tick({ noiseTime: 1, momentum: 0, restlessness: 1 })
    const at045 = u.uMantleDC.value
    u.uMantleRelief.value = 0.9        // mantle nearly matches bedrock
    tick({ noiseTime: 2, momentum: 0, restlessness: 1 })
    expect(u.uMantleDC.value).toBeLessThan(at045)
    u.uMantleRelief.value = 1.0        // fields differ only in the extra octaves
    tick({ noiseTime: 3, momentum: 0, restlessness: 1 })
    expect(u.uMantleDC.value).toBeGreaterThan(0)
  })

  it('drift offset accumulates forward and never rewinds on a noiseTime jump-back', () => {
    const { u, tick } = build()
    tick({ noiseTime: 10, momentum: 0.5, restlessness: 1 })
    const afterFwd = u.uFBM0DriftOffset.value.x
    tick({ noiseTime: 25, momentum: 0.5, restlessness: 1 })   // forward +15
    const afterFwd2 = u.uFBM0DriftOffset.value.x
    expect(afterFwd2).not.toBe(afterFwd)                   // moved
    // a backward jump (dNoiseTime clamped ≥0) must not change the offset
    const snap = { x: u.uFBM0DriftOffset.value.x, y: u.uFBM0DriftOffset.value.y }
    tick({ noiseTime: 5, momentum: 0.5, restlessness: 1 })    // backward
    expect(u.uFBM0DriftOffset.value.x).toBe(snap.x)
    expect(u.uFBM0DriftOffset.value.y).toBe(snap.y)
  })

  it('driftEnabled=false zeroes the drift velocity uniforms', () => {
    const { u, d, tick } = build()
    d.settings.driftEnabled = false
    tick({ noiseTime: 1, momentum: 0.9, restlessness: 1 })
    expect(u.uFBM0DriftX.value).toBe(0)
    expect(u.uFBM0DriftZ.value).toBe(0)
    expect(u.uFBM1DriftX.value).toBe(0)
    expect(u.uFBM1DriftZ.value).toBe(0)
  })

  it('drift is deterministic in the payload dt — no wall-clock dependence', () => {
    // Identical tick sequences must produce identical drift, so a run is
    // reproducible.
    const run = () => {
      const { u, tick } = build()
      for (let i = 1; i <= 25; i++) tick({ dt: 0.05, noiseTime: i, momentum: 0.7, restlessness: 1 })
      return [u.uFBM0DriftOffset.value.x, u.uFBM0DriftOffset.value.y,
              u.uFBM1DriftOffset.value.x, u.uFBM1DriftOffset.value.y]
    }
    expect(run()).toEqual(run())
  })

  it('drift angle advances with dt (dt=0 freezes direction, dt>0 turns it)', () => {
    const frozen = build()
    for (let i = 1; i <= 20; i++) frozen.tick({ dt: 0, noiseTime: i, momentum: 1, restlessness: 1 })
    expect(frozen.d.getDriftAngle(0)).toBe(0)   // initial angle, never advanced

    const moving = build()
    for (let i = 1; i <= 20; i++) moving.tick({ dt: 0.1, noiseTime: i, momentum: 1, restlessness: 1 })
    expect(moving.d.getDriftAngle(0)).not.toBe(0)  // dt drove the angle
  })

  it('uTime mirrors noiseTime on every tick', () => {
    const { u, tick } = build()
    tick({ noiseTime: 1, momentum: 0.5, restlessness: 1.0 })
    expect(u.uTime.value).toBe(1)
    tick({ noiseTime: 2, momentum: 0.5, restlessness: 0.0 })
    expect(u.uTime.value).toBe(2)
  })
  it('a restored snapshot resumes the same drift as the driver it was taken from', () => {
    const a = build()
    a.d.settings.baseSpeed0 = 2.5
    a.d.settings.driftEnabled = true
    for (let i = 1; i <= 20; i++) a.tick({ dt: 0.1, noiseTime: i, momentum: 1, restlessness: 1 })
    const snap = JSON.parse(JSON.stringify(a.d.exportState()))

    const b = build()
    b.d.importState(snap)
    expect(b.d.getDriftAngle(0)).toBe(a.d.getDriftAngle(0))
    expect(b.d.getDriftAngle(1)).toBe(a.d.getDriftAngle(1))
    // The settings are rows, captured by Terrain; the driver's state is the headings.
    expect(Object.keys(snap).sort()).toEqual(['driftAngle0', 'driftAngle1'])
    b.d.settings.baseSpeed0 = 2.5

    // Same next tick on both (uTime aligned the way a scene restore aligns it):
    // the same heading and so the same velocity.
    b.u.uTime.value = a.u.uTime.value
    a.tick({ dt: 0.1, noiseTime: 21, momentum: 1, restlessness: 1 })
    b.tick({ dt: 0.1, noiseTime: 21, momentum: 1, restlessness: 1 })
    expect(b.u.uFBM0DriftX.value).toBe(a.u.uFBM0DriftX.value)
    expect(b.u.uFBM1DriftZ.value).toBe(a.u.uFBM1DriftZ.value)
  })

  it('importState ignores keys a snapshot lacks', () => {
    const { d } = build()
    d.importState({})
    expect(d.getDriftAngle(1)).toBeCloseTo(Math.PI * 0.65, 12)
    expect(d.settings.driftEnabled).toBe(true)
  })

  it("never restores the test-only freeze, and ignores a setting of the wrong type", () => {
    const { d } = build()
    const before = { ...d.settings }
    d.importState({ frozen: true, baseSpeed0: 'fast', driftEnabled: 1 })
    expect(d.settings).toEqual(before)
  })
})
