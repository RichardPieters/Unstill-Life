import { describe, it, expect } from 'vitest'
import { WaterDriver } from '../../src/water/waterDriver.js'

// Minimal fakes — no THREE, no GPU. The driver only needs uniform objects with
// a .value and an EventTarget that emits 'tick'.
function makeUniforms() {
  return {
    uTime:            { value: 0 },
    uFoamWidth:       { value: 7 },
    uSparkleThreshold:{ value: 0.15 },
    uDepthMax:        { value: 45 },
  }
}
// A deliberate band write, as water.params makes one: the setting, then a snap.
function setBand(d, { low = d.settings.seaLow, high = d.settings.seaHigh } = {}) {
  d.settings.seaLow = low
  d.settings.seaHigh = high
  d.snapSeaLevel()
}
function tick(dyn, detail) {
  dyn.dispatchEvent(new CustomEvent('tick', { detail }))
}

describe('WaterDriver', () => {
  it('applies the initial sea level on construction', () => {
    const dyn = new EventTarget()
    let seaY = null
    const d = new WaterDriver(dyn, makeUniforms(), y => { seaY = y })
    // Against the driver's own low bound, not a literal — the bounds are tuning
    // constants (retuned for the bedrock/mantle terrain) and pinning the number
    // here only breaks the test on every legitimate retune.
    expect(seaY).toBe(d.settings.seaLow)
  })

  it('raises sea level as restlessness falls, toward the high bound', () => {
    const dyn = new EventTarget()
    let seaY = 0
    const d = new WaterDriver(dyn, makeUniforms(), y => { seaY = y })
    const start = seaY
    for (let i = 0; i < 200; i++) tick(dyn, { dt: 1, restlessness: 0, momentum: 0.5 })
    expect(seaY).toBeGreaterThan(start)
    expect(seaY).toBeLessThanOrEqual(d.getSeaLevel() + 1e-9)
    expect(seaY).toBeLessThanOrEqual(d.settings.seaHigh + 1e-6)   // never overshoots the high bound
  })

  // The sea band is `low` at restlessness 1 and `high` at restlessness 0. A
  // drag on either must visibly move the water.
  it('sea bounds take effect immediately, without waiting for the smoothing', () => {
    const dyn = new EventTarget()
    let seaY = 0
    const d = new WaterDriver(dyn, makeUniforms(), y => { seaY = y })
    tick(dyn, { dt: 0.1, restlessness: 1, momentum: 0.5 })

    // At restlessness 1 the target IS `low`, so a drag must land there at once.
    // The easing needs about 2 s to get close, which is
    // what made dragging look like nothing happened.
    setBand(d, { low: -30 })
    expect(seaY).toBeCloseTo(-30, 6)
    expect(d.getSeaLevel()).toBeCloseTo(-30, 6)
  })

  it('the waterline eases at the same pace at any frame rate, and not at all without time', () => {
    const settle = (fps, seconds) => {
      const dyn = new EventTarget()
      const d = new WaterDriver(dyn, makeUniforms(), () => {})
      setBand(d, { low: -10, high: 30 })
      const n = Math.round(fps * seconds)
      for (let i = 0; i < n; i++) tick(dyn, { dt: 1 / fps, restlessness: 0, momentum: 0.5 })
      return d.getSeaLevel()
    }
    expect(settle(30, 2)).toBeCloseTo(settle(120, 2), 6)
    const dyn = new EventTarget()
    const d = new WaterDriver(dyn, makeUniforms(), () => {})
    const before = d.getSeaLevel()
    tick(dyn, { dt: 0, restlessness: 0, momentum: 0.5 })
    expect(d.getSeaLevel()).toBe(before)
  })

  it('the settled bound reaches the water when restlessness is low', () => {
    const dyn = new EventTarget()
    let seaY = 0
    const d = new WaterDriver(dyn, makeUniforms(), y => { seaY = y })

    // At restlessness 1 the high bound contributes nothing at all — that is the
    // design, and the reason it appeared broken when dragged at rest.
    tick(dyn, { dt: 0.1, restlessness: 1, momentum: 0.5 })
    const atRest = d.getSeaLevel()
    setBand(d, { high: 35 })
    expect(d.getSeaLevel()).toBeCloseTo(atRest, 6)

    // Drop restlessness and it becomes the dominant term.
    tick(dyn, { dt: 0.1, restlessness: 0, momentum: 0.5 })
    setBand(d, { high: 35 })
    expect(d.getSeaLevel()).toBeCloseTo(35, 6)
    expect(seaY).toBeCloseTo(35, 6)
  })

  it('snapshots the smoothed sea level only (the band and bases are water.params rows) and applies a restore to the mesh', () => {
    const dyn = new EventTarget()
    let seaY = 0
    const d = new WaterDriver(dyn, makeUniforms(), y => { seaY = y })
    expect(d.exportState()).toEqual({ seaLevel: d.getSeaLevel() })
    d.importState({ seaLevel: -3.5 })
    expect(d.getSeaLevel()).toBe(-3.5)
    expect(seaY).toBe(-3.5)
  })

  it('resumes the ripple clock from the restored uTime, so the next tick does not step back to the live clock', () => {
    const dyn = new EventTarget()
    const u = makeUniforms()
    const d = new WaterDriver(dyn, u, () => {})
    for (let i = 0; i < 20; i++) tick(dyn, { dt: 0.1, restlessness: 1, momentum: 0.5 })
    u.uTime.value = 3.25   // water.js restores the integrated uniform before the driver
    d.importState({ seaLevel: d.getSeaLevel() })
    expect(d.getRippleTime()).toBe(3.25)
    tick(dyn, { dt: 0, restlessness: 1, momentum: 0.5 })
    expect(u.uTime.value).toBe(3.25)
  })

  // Foam reach and the deep-colour depth are shares of the water's available
  // depth, so they have to follow the terrain's vertical scale and the sea level
  // as the form dials move them.
  it('the depth-measured uniforms grow with taller terrain and with a higher sea', () => {
    const dyn = new EventTarget()
    const u = makeUniforms()
    const d = new WaterDriver(dyn, u, () => {})
    const settle = () => { for (let i = 0; i < 400; i++) tick(dyn, { dt: 0.1, restlessness: 1, momentum: 0.5 }) }

    // Taller terrain → seabed further below the waterline → more water to grade.
    setBand(d, { low: -10, high: -10 })
    d.setTerrainScale(120); settle()
    const shallow = { foam: u.uFoamWidth.value, depth: u.uDepthMax.value }
    d.setTerrainScale(280); settle()
    expect(u.uFoamWidth.value).toBeGreaterThan(shallow.foam)
    expect(u.uDepthMax.value).toBeGreaterThan(shallow.depth)

    // A higher waterline over the same terrain also deepens the water. Asserted
    // because amplitude ALONE was the first fix and it only worked at one of
    // four dial corners — the sea band moves independently of the amps.
    const tallLowSea = u.uDepthMax.value
    setBand(d, { low: 20, high: 20 }); settle()
    expect(u.uDepthMax.value).toBeGreaterThan(tallLowSea)
  })

  it('a zero or missing terrain scale falls back rather than collapsing the water', () => {
    const dyn = new EventTarget()
    const u = makeUniforms()
    const d = new WaterDriver(dyn, u, () => {})
    d.setTerrainScale(0)
    tick(dyn, { dt: 0.1, restlessness: 1, momentum: 0.5 })
    // The available depth is floored, so a missing scale cannot put foam reach
    // and deep depth at zero (no foam, the whole sea fully deep).
    expect(u.uDepthMax.value).toBeGreaterThan(0)
    expect(u.uFoamWidth.value).toBeGreaterThan(0)
    expect(d.settings.deepShare).toBeGreaterThan(0)
  })

  it('the deep-colour share survives the per-tick rewrite', () => {
    const dyn = new EventTarget()
    const u = makeUniforms()
    const d = new WaterDriver(dyn, u, () => {})
    d.setTerrainScale(249.5)
    d.settings.deepShare = 0.45
    tick(dyn, { dt: 0.1, restlessness: 1, momentum: 0.5 })
    const atFirst = u.uDepthMax.value
    d.settings.deepShare = 0.9
    tick(dyn, { dt: 0.1, restlessness: 1, momentum: 0.5 })

    // The driver rewrites uDepthMax every tick, so the slider has to set the
    // share; a direct uniform write would be overwritten before it was ever
    // seen. Asserted as the RATIO: the absolute value carries the depth, which
    // is not what this is about, and pinning it would re-derive the formula.
    expect(u.uDepthMax.value / atFirst).toBeCloseTo(2, 6)
    expect(d.settings.deepShare).toBe(0.9)
  })

  it('advances ripple time every tick (speed floor keeps it moving even at momentum 0)', () => {
    const dyn = new EventTarget()
    const u = makeUniforms()
    new WaterDriver(dyn, u, () => {})
    let prev = u.uTime.value
    for (let i = 0; i < 10; i++) {
      tick(dyn, { dt: 0.1, restlessness: 1, momentum: 0 })
      expect(u.uTime.value).toBeGreaterThan(prev)
      prev = u.uTime.value
    }
  })

  it('momentum widens foam and tightens sparkle, off a slider-set baseline', () => {
    const dyn = new EventTarget()
    const u = makeUniforms()
    const d = new WaterDriver(dyn, u, () => {})
    d.settings.foamShare = 0.2
    d.settings.sparkleThreshold = 0.30
    // calm: foam near baseline×lo, sparkle near baseline
    tick(dyn, { dt: 0.1, restlessness: 1, momentum: 0 })
    const foamCalm = u.uFoamWidth.value, sparkCalm = u.uSparkleThreshold.value
    // agitated: foam wider, sparkle lower (denser)
    tick(dyn, { dt: 0.1, restlessness: 1, momentum: 1 })
    expect(u.uFoamWidth.value).toBeGreaterThan(foamCalm)
    expect(u.uSparkleThreshold.value).toBeLessThan(sparkCalm)
    expect(u.uSparkleThreshold.value).toBeGreaterThanOrEqual(0.02)  // floored
  })

  it('the band settings move the reactive target', () => {
    const dyn = new EventTarget()
    let seaY = 0
    const d = new WaterDriver(dyn, makeUniforms(), y => { seaY = y })
    setBand(d, { low: -30, high: 30 })
    for (let i = 0; i < 500; i++) tick(dyn, { dt: 1, restlessness: 1, momentum: 0.5 })
    // restlessness 1 → target is the low bound
    expect(seaY).toBeCloseTo(-30, 0)
  })
})
