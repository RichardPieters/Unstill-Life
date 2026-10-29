import { describe, test, expect } from 'vitest'
import { removedNameHits } from './sourceScan.js'
import { Atmosphere } from '../../src/drift/atmosphere.js'
import { overcastCurves, hazeCurves, colourCurves, mixHex, shapeOvercast, scaleHex } from '../../src/drift/atmosphereMath.js'
import {
  ATMOSPHERE_PARAMS, WEATHER_PARAMS, WEATHER_DRIVEN_KEYS, HEAVY_START, hexToInt, intToHex,
} from '../../src/drift/atmosphereParams.js'

/**
 * atmosphere.test.js — the stateful weather module: its walk, its master
 * switch, the clear/heavy contract and the snapshot round trip. The pure
 * arithmetic it delegates to lives in atmosphereMath.test.js.
 */

/** Deterministic seeded PRNG (mulberry32) — one independent stream per call, so
 *  two instances never steal draws from each other the way two closures over
 *  the same Math.random do (see formWalker.test.js's seededRandom). */
function seededRandom(seed) {
  let s = seed >>> 0
  return () => {
    s |= 0; s = (s + 0x6D2B79F5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function fakeDynamics() {
  const d = new EventTarget()
  d.tick = dt => d.dispatchEvent(new CustomEvent('tick', { detail: { dt } }))
  return d
}

// The live scene values the weather captures as its CLEAR end. Written out here
// rather than imported, so they stay independent of terrain/water/cloud
// defaults. EVERY driven parameter, not a sample of them: the clear/restore
// cases below iterate this object, so a parameter missing here is a parameter
// whose snapshot round trip nothing checks.
const CLEAR = {
  shadowValue: 0.05, lightLevel: 1.00, glow: 0.30, shadowHueAmt: 0.45,
  cloudCoverage: 1.16, cloudGrey: 0.0, specAmt: 0.80, reflectAmt: 1.00,
  fogCurve: 0.60, aerialDesat: 0.55, fogNear: 400, fogMaxAlpha: 0.90,
  // Two sky colours travelling to the SAME heavy sky from DIFFERENT clear ends —
  // the scene's horizon and the painting's own, which is authored separately
  // and must not be snapped to the horizon's value.
  skyHex: 0xc8ddf0, artSky: 0x8fa8c4,
  // The painted canvas, which follows the light level rather than a heavy end.
  artGround: 0xc8bda4,
  zenithSky: 0x2a4d7a,
}

/**
 * A stand-in for the scene the panel writes to: `scene` holds the current value
 * of every driven parameter, `live` reads and writes it, and the apply callback
 * writes the blended result back — the same round trip weatherDriver'
 * applyWeather performs, so the clear/restore contract is testable without a
 * browser. This is what makes the snapshot cases below meaningful: a clear that
 * does not survive a round trip shows up here as a scene that cannot get home.
 */
function makeAtmosphere({ random, noiseSpeed = 1, live } = {}) {
  const dynamics = fakeDynamics()
  const applied = []
  const scene = { ...CLEAR, ...live }
  const atmosphere = new Atmosphere(dynamics, {
    apply: state => {
      applied.push(state)
      if (!state.clear) return
      if (!state.enabled) { Object.assign(scene, state.clear); return }
      Object.assign(scene,
        overcastCurves(state.clear, state.heavy, state.overcast, state.shape),
        hazeCurves(state.clear, state.heavy, state.haze),
        // Both sky colours, each from its own clear end toward the one heavy
        // sky, and then BOTH toward the haze colour on top of that — the same
        // two-stage blend applyWeather does, and in the same order (weighted
        // by the raw overcast here; applyWeather uses the shaped one).
        { skyHex: mixHex(mixHex(state.clear.skyHex, state.heavy.skyHex, state.overcast),
                         state.heavy.hazeSky, state.haze),
          artSky: mixHex(mixHex(state.clear.artSky, state.heavy.skyHex, state.overcast),
                         state.heavy.hazeSky, state.haze),
          zenithSky: mixHex(mixHex(state.clear.zenithSky, state.heavy.skyHex, state.overcast),
                            state.heavy.hazeSky, state.haze),
          artGround: scaleHex(state.clear.artGround,
                              overcastCurves(state.clear, state.heavy, state.overcast, state.shape).lightLevel
                              / Math.max(state.clear.lightLevel, 1e-4)) })
    },
    live: { get: key => scene[key], set: (key, v) => { scene[key] = v }, onChange: () => {} },
    noiseSpeed: () => noiseSpeed,
    random: random ?? (() => 0.5),
  })
  return { dynamics, atmosphere, applied, scene }
}

describe('Atmosphere', () => {
  test('is ON by default — the shipped clear-weather cloud amount is an empty sky, so the weather IS the shipped picture', () => {
    const { atmosphere } = makeAtmosphere()
    expect(atmosphere.params.get('enabled')).toBe(true)
  })

  test('the enable edge fires at construction when starting enabled, so clear is captured rather than left null', () => {
    // _switch's early return on an unchanged value means the clear capture
    // that normally happens on the toggle EDGE never fires if the master
    // starts already on: `_clear` would stay null and every apply would
    // silently swallow the write. The constructor has to do the capture itself.
    const { atmosphere } = makeAtmosphere()
    expect(atmosphere.params.get('clear.shadowValue')).toBeCloseTo(CLEAR.shadowValue, 9)
  })

  test('does not write while disabled, however many ticks pass', () => {
    const { dynamics, atmosphere, applied } = makeAtmosphere({ random: seededRandom(3) })
    atmosphere.params.set('enabled', false)
    applied.length = 0   // clear the construction-time + disable applies
    for (let i = 0; i < 100; i++) dynamics.tick(1 / 60)
    expect(applied).toHaveLength(0)
  })

  test('enabling and disabling each push exactly one apply', () => {
    // Starts enabled, so disable first: the construction-time apply is not an
    // edge and must not be what makes the "enable" half pass.
    const { atmosphere, applied } = makeAtmosphere()
    applied.length = 0
    atmosphere.params.set('enabled', false)
    expect(applied).toHaveLength(1)
    expect(applied[0].enabled).toBe(false)
    atmosphere.params.set('enabled', true)
    expect(applied).toHaveLength(2)
    expect(applied[1].enabled).toBe(true)
    // Re-setting the same value is not an edge worth a write.
    atmosphere.params.set('enabled', true)
    expect(applied).toHaveLength(2)
  })

  test('walks both scalars once enabled, and holds them when the walk is off', () => {
    const { dynamics, atmosphere, applied } = makeAtmosphere({ random: seededRandom(11) })
    atmosphere.params.set('enabled', true)
    for (let i = 0; i < 600; i++) dynamics.tick(1 / 60)
    expect(applied.length).toBeGreaterThan(1)
    const moved = applied[applied.length - 1]
    expect(moved.overcast).not.toBeCloseTo(applied[0].overcast, 6)

    atmosphere.params.set('walking', false)
    const n = applied.length
    const held = atmosphere.getOvercast()
    for (let i = 0; i < 600; i++) dynamics.tick(1 / 60)
    expect(applied).toHaveLength(n)
    expect(atmosphere.getOvercast()).toBeCloseTo(held, 12)
  })

  test('stalls with the scene — a zero noiseSpeed writes nothing', () => {
    const { dynamics, atmosphere, applied } = makeAtmosphere({ random: seededRandom(5), noiseSpeed: 0 })
    atmosphere.params.set('enabled', true)
    const n = applied.length
    for (let i = 0; i < 600; i++) dynamics.tick(1 / 60)
    expect(applied).toHaveLength(n)
  })

  test('a NaN dt cannot reach the uniforms', () => {
    const { dynamics, atmosphere } = makeAtmosphere({ random: seededRandom(5) })
    atmosphere.params.set('enabled', true)
    dynamics.tick(NaN)
    expect(Number.isFinite(atmosphere.getOvercast())).toBe(true)
    expect(Number.isFinite(atmosphere.getHaze())).toBe(true)
  })

  test('both scalars stay in [0,1] over a long run', () => {
    const { dynamics, atmosphere } = makeAtmosphere({ random: seededRandom(23), noiseSpeed: 3 })
    atmosphere.params.set('enabled', true)
    for (let i = 0; i < 20000; i++) {
      dynamics.tick(1 / 60)
      expect(atmosphere.getOvercast()).toBeGreaterThanOrEqual(0)
      expect(atmosphere.getOvercast()).toBeLessThanOrEqual(1)
      expect(atmosphere.getHaze()).toBeGreaterThanOrEqual(0)
      expect(atmosphere.getHaze()).toBeLessThanOrEqual(1)
    }
  })

  test('hand-setting a channel redraws its target so the walk resumes from there', () => {
    const { atmosphere } = makeAtmosphere({ random: seededRandom(31) })
    atmosphere.setChannel('overcast', 0.9)
    expect(atmosphere.getOvercast()).toBeCloseTo(0.9, 12)
    const exported = atmosphere.exportState()
    expect(Math.abs(exported.target.overcast - 0.9)).toBeLessThanOrEqual(atmosphere.params.get('spread'))
  })

  test('snapshot round-trips the latents, their targets and the heavy ends', () => {
    const { dynamics, atmosphere } = makeAtmosphere({ random: seededRandom(41) })
    atmosphere.params.set('enabled', true)
    atmosphere.params.set('heavy.shadowValue', 0.66)
    atmosphere.params.set('spread', 0.4)
    atmosphere.params.set('rate', 0.03)
    for (let i = 0; i < 300; i++) dynamics.tick(1 / 60)
    const snap = atmosphere.exportState()

    const b = makeAtmosphere({ random: seededRandom(41) }).atmosphere
    const { unknown } = b.importState(snap)
    expect(unknown).toEqual([])
    expect(b.exportState()).toEqual(snap)
  })

  test('an unrecognised snapshot key is reported, not silently dropped', () => {
    const { atmosphere } = makeAtmosphere()
    const { unknown } = atmosphere.importState({ u: { overcast: 0.5 }, mystery: 1 })
    expect(unknown).toEqual(['atmosphere.mystery'])
  })

  test('importing pushes the restored state at the scene even when enabled did not change', () => {
    // The restore has to reach the uniforms regardless: a snapshot taken while
    // the weather was already on and applied to an instance that is also
    // already on still has new scalars to write.
    const { atmosphere, applied } = makeAtmosphere()
    atmosphere.params.set('enabled', true)
    const n = applied.length
    atmosphere.importState({ u: { overcast: 0.77, haze: 0.11 }, enabled: true })
    expect(applied.length).toBe(n + 1)
    expect(applied[applied.length - 1].overcast).toBeCloseTo(0.77, 12)
  })
})

describe('the overcast effect window', () => {
  test('it rides the snapshot, and is clamped so the endpoints stay exact', () => {
    // onset < 0 or full > 1 would silently stop a clear day reproducing the
    // scene, or full overcast reaching the heavy values the sliders promise.
    const { atmosphere } = makeAtmosphere()
    atmosphere.params.set('onset', 0.42)
    atmosphere.params.set('full', 0.88)
    const snap = atmosphere.exportState()
    expect(snap.onset).toBeCloseTo(0.42, 9)
    expect(snap.full).toBeCloseTo(0.88, 9)

    const b = makeAtmosphere()
    b.atmosphere.importState({ ...snap, onset: -3, full: 7 })
    expect(b.atmosphere.params.get('onset')).toBe(0)
    expect(b.atmosphere.params.get('full')).toBe(1)
  })

  test('moving the window moves the light alone, not the cloud', () => {
    // Cloud amount answers to the raw overcast scalar (see
    // atmosphereMath.overcastCurves) precisely so this window can move for the
    // light terms without silently changing how much cloud is in the sky.
    // Through the real class rather than the curve alone.
    const { atmosphere, scene } = makeAtmosphere()
    atmosphere.params.set('walking', false)
    atmosphere.params.set('enabled', true)
    atmosphere.setChannel('overcast', 0.4)
    const cloudBefore = scene.cloudCoverage
    const lightBefore = scene.lightLevel

    atmosphere.params.set('onset', 0.05)          // let the LIGHT start much earlier
    // cloudCoverage runs BACKWARDS — lower is more cloud. It must not move.
    expect(scene.cloudCoverage).toBeCloseTo(cloudBefore, 9)
    expect(scene.lightLevel).toBeLessThan(lightBefore)
  })

  test('cloud amount tracks overcast with no dead zone, whatever onset/full say', () => {
    const { atmosphere, scene } = makeAtmosphere()
    atmosphere.params.set('walking', false)
    atmosphere.params.set('enabled', true)
    atmosphere.params.set('onset', 0.8)            // light would not react at all yet
    atmosphere.params.set('full', 0.9)
    atmosphere.setChannel('overcast', 0.2)
    // cloudCoverage runs BACKWARDS — lower is more cloud, so even a LOW
    // overcast must already show some, unlike the light (held flat below its
    // own onset).
    expect(scene.cloudCoverage).toBeLessThan(CLEAR.cloudCoverage)
    expect(scene.lightLevel).toBeCloseTo(CLEAR.lightLevel, 9)
  })
})

/**
 * Authoring the CLEAR end. The panel must be able to edit clear while the
 * weather is running and get the scene to follow, and it must be told when
 * there is no clear to edit so it can fall through to the live scene instead of
 * silently dropping the write.
 */
describe('authoring the clear-weather end', () => {
  test('while the weather is off a clear row IS the live param: it reads it and writes it', () => {
    // The mirror contract. Swallowing the write would make the clear-weather
    // sliders dead whenever the master toggle is down.
    const { atmosphere, scene } = makeAtmosphere()
    atmosphere.params.set('enabled', false)
    scene.shadowValue = 0.123
    expect(atmosphere.params.get('clear.shadowValue')).toBe(0.123)
    atmosphere.params.set('clear.shadowValue', 0.2)
    expect(scene.shadowValue).toBe(0.2)
    expect(atmosphere.params.get('clear.shadowValue')).toBe(0.2)
  })

  test('while the weather is on a clear row edits the captured clear day, not the live param', () => {
    const { atmosphere, scene } = makeAtmosphere()
    atmosphere.params.set('walking', false)
    atmosphere.setChannel('overcast', 1)
    const blended = scene.shadowValue
    atmosphere.params.set('clear.shadowValue', 0.3)
    expect(atmosphere.params.get('clear.shadowValue')).toBe(0.3)
    expect(atmosphere.exportState().clear.shadowValue).toBe(0.3)
    expect(scene.shadowValue).not.toBe(0.3)
    expect(blended).toBeCloseTo(atmosphere.params.get('heavy.shadowValue'), 9)
  })

  test('editing clear moves the scene without touching the conditions', () => {
    const { atmosphere, scene } = makeAtmosphere()
    atmosphere.params.set('walking', false)
    atmosphere.params.set('enabled', true)
    atmosphere.setChannel('overcast', 0)
    expect(scene.shadowValue).toBeCloseTo(CLEAR.shadowValue, 9)

    expect(atmosphere.params.set('clear.shadowValue', 0.30)).toBe(true)
    // At overcast 0 the scene IS the clear end, so the edit lands verbatim.
    expect(scene.shadowValue).toBeCloseTo(0.30, 9)
    expect(atmosphere.getOvercast()).toBeCloseTo(0, 9)
  })

  test('a clear edit re-aims the blend at every intermediate condition too', () => {
    const { atmosphere, scene } = makeAtmosphere()
    atmosphere.params.set('walking', false)
    atmosphere.params.set('enabled', true)
    atmosphere.setChannel('overcast', 0.5)
    const before = scene.shadowValue
    atmosphere.params.set('clear.shadowValue', CLEAR.shadowValue + 0.4)
    // Along a lerp at weight w, moving the CLEAR end by d moves the result by
    // d*(1-w). w is the SHAPED weight, not the raw scalar — read from
    // shapeOvercast rather than hard-coded, so this keeps testing the clear
    // edit rather than quietly re-testing the curve's current tuning.
    const w = shapeOvercast(0.5, { onset: atmosphere.params.get('onset'), full: atmosphere.params.get('full') })
    expect(scene.shadowValue - before).toBeCloseTo(0.4 * (1 - w), 6)
  })

  test('switching the weather off restores the AUTHORED clear day, not the captured one', () => {
    // "Clear weather" is a thing you define, not a snapshot of whatever
    // happened to be up at enable time. The reversal stays exact; it reverses
    // to the authored end.
    const { atmosphere, scene } = makeAtmosphere()
    atmosphere.params.set('walking', false)
    atmosphere.params.set('enabled', true)
    atmosphere.setChannel('overcast', 1)
    atmosphere.params.set('clear.glow', 0.11)
    atmosphere.params.set('enabled', false)
    expect(scene.glow).toBeCloseTo(0.11, 9)
  })

  test('an authored clear rides the snapshot', () => {
    const { atmosphere } = makeAtmosphere()
    atmosphere.params.set('walking', false)
    atmosphere.params.set('enabled', true)
    atmosphere.params.set('clear.aerialDesat', 0.21)
    expect(atmosphere.exportState().clear.aerialDesat).toBeCloseTo(0.21, 9)

    const b = makeAtmosphere()
    b.atmosphere.importState(atmosphere.exportState())
    expect(b.atmosphere.params.get('clear.aerialDesat')).toBeCloseTo(0.21, 9)
  })

  test('a junk or unknown clear write is refused rather than poisoning the scene', () => {
    const { atmosphere, scene } = makeAtmosphere()
    atmosphere.params.set('walking', false)
    atmosphere.params.set('enabled', true)
    atmosphere.params.set('clear.shadowValue', NaN)
    expect(atmosphere.params.set('clear.notAParameter', 1)).toBe(false)
    expect(atmosphere.params.get('clear.shadowValue')).toBeCloseTo(CLEAR.shadowValue, 9)
    expect(Number.isFinite(scene.shadowValue)).toBe(true)
  })
})

/**
 * Clear has to ride the snapshot. captureScene records the uniforms as they
 * currently are — the weather-driven values while the weather is up — so a restore
 * that re-derived clear from the scene would apply the weather on top of itself,
 * permanently, compounding on every cycle.
 *
 * These drive the full loop through the fake scene across two sessions: within
 * one session (enable and disable together) a lost clear cannot show.
 */
describe('clear survives a snapshot', () => {
  test('capture while driven -> restore -> the scene is where it was, not further', () => {
    const a = makeAtmosphere({ random: seededRandom(3) })
    a.atmosphere.params.set('walking', false)
    a.atmosphere.params.set('enabled', true)
    a.atmosphere.setChannel('overcast', 0.8)
    a.atmosphere.setChannel('haze', 0.5)
    const driven = { ...a.scene }
    const snap = JSON.parse(JSON.stringify(a.atmosphere.exportState()))

    // A fresh session whose scene has already been restored to the weather-driven
    // values, which is exactly the order applyScene runs in (terrain first).
    const b = makeAtmosphere({ random: seededRandom(3), live: driven })
    b.atmosphere.importState(snap)
    for (const k of Object.keys(CLEAR)) expect(b.scene[k]).toBeCloseTo(driven[k], 9)
  })

  test('...and the weather can then still be switched off, all the way back to clear', () => {
    const a = makeAtmosphere({ random: seededRandom(3) })
    a.atmosphere.params.set('walking', false)
    a.atmosphere.params.set('enabled', true)
    a.atmosphere.setChannel('overcast', 0.8)
    const driven = { ...a.scene }
    const snap = JSON.parse(JSON.stringify(a.atmosphere.exportState()))

    const b = makeAtmosphere({ random: seededRandom(3), live: driven })
    b.atmosphere.importState(snap)
    b.atmosphere.params.set('enabled', false)
    // The original clear day, not the driven look promoted to "clear".
    for (const k of Object.keys(CLEAR)) expect(b.scene[k]).toBeCloseTo(CLEAR[k], 9)
  })

  test('repeated export/import cycles do not drift toward heavy', () => {
    let session = makeAtmosphere({ random: seededRandom(9) })
    session.atmosphere.params.set('walking', false)
    session.atmosphere.params.set('enabled', true)
    session.atmosphere.setChannel('overcast', 0.7)
    const firstDriven = { ...session.scene }

    let snap = JSON.parse(JSON.stringify(session.atmosphere.exportState()))
    for (let i = 0; i < 5; i++) {
      session = makeAtmosphere({ random: seededRandom(9), live: { ...session.scene } })
      session.atmosphere.importState(snap)
      snap = JSON.parse(JSON.stringify(session.atmosphere.exportState()))
    }
    // Five round trips later the scene is still the same picture, not the
    // blend applied once more per cycle.
    for (const k of Object.keys(CLEAR)) expect(session.scene[k]).toBeCloseTo(firstDriven[k], 9)
  })

  test('importing a weather-OFF snapshot while running restores the snapshot, not the running clear', () => {
    // The other direction: the live session's clear must not be written over
    // the values the snapshot has just restored. A distinct value for every
    // driven parameter, so the assertion covers all of them.
    const authored = Object.fromEntries(
      Object.entries(CLEAR).map(([k, v]) => [k, k === 'skyHex' ? 0x223344 : v * 0.5 + 0.07]))
    const a = makeAtmosphere({ random: seededRandom(13), live: authored })
    a.atmosphere.params.set('enabled', false)   // weather off, for this case explicitly
    const snap = JSON.parse(JSON.stringify(a.atmosphere.exportState()))
    expect(snap.clear).toBe(null)

    const b = makeAtmosphere({ random: seededRandom(13) })
    b.atmosphere.params.set('walking', false)
    b.atmosphere.params.set('enabled', true)
    b.atmosphere.setChannel('overcast', 0.9)
    // applyScene restores the terrain uniforms first...
    Object.assign(b.scene, authored)
    // ...then hands the atmosphere its state.
    b.atmosphere.importState(snap)
    for (const k of Object.keys(CLEAR)) expect(b.scene[k]).toBeCloseTo(authored[k], 9)
  })

  test('a snapshot without a clear field still restores rather than refusing', () => {
    const a = makeAtmosphere({ random: seededRandom(21) })
    const saved = { u: { overcast: 0.5, haze: 0.5 }, enabled: true }
    const { unknown } = a.atmosphere.importState(saved)
    expect(unknown).toEqual([])
    expect(a.atmosphere.params.get('enabled')).toBe(true)
    for (const k of Object.keys(CLEAR)) expect(Number.isFinite(a.scene[k])).toBe(true)
  })

  test('an out-of-range latent in a hand-edited snapshot is clamped, not trusted', () => {
    // Clamped rather than reflected: reflect01 folds once, so an overcast of 3
    // reflects to -1 and is still out of range. Far-out values are pinned.
    const { atmosphere } = makeAtmosphere()
    atmosphere.importState({ u: { overcast: 3, haze: -0.4 } })
    expect(atmosphere.getOvercast()).toBe(1)
    expect(atmosphere.getHaze()).toBe(0)
  })
})

describe('every driven parameter is actually driven', () => {
  // A parameter can be added to the curves and forgotten in the heavy defaults,
  // or vice versa, and nothing else here would notice: the scene would simply
  // hold that one at its clear value forever, or write NaN into it.
  test('full overcast and full haze move all of them, and none goes NaN', () => {
    const a = makeAtmosphere()
    a.atmosphere.params.set('walking', false)
    const clear = { ...a.scene }
    a.atmosphere.params.set('enabled', true)
    a.atmosphere.setChannel('overcast', 1)
    a.atmosphere.setChannel('haze', 1)
    for (const k of Object.keys(CLEAR)) {
      expect(Number.isFinite(a.scene[k]), `${k} is not finite`).toBe(true)
      expect(a.scene[k], `${k} did not move`).not.toBe(clear[k])
    }
  })

  test('at clear weather every one of them reads back its captured value', () => {
    const a = makeAtmosphere()
    a.atmosphere.params.set('walking', false)
    a.atmosphere.params.set('enabled', true)
    a.atmosphere.setChannel('overcast', 0)
    a.atmosphere.setChannel('haze', 0)
    for (const k of Object.keys(CLEAR)) expect(a.scene[k]).toBeCloseTo(CLEAR[k], 9)
  })
})

describe('guards', () => {
  test('a NaN rate or spread cannot kill the walk', () => {
    const { dynamics, atmosphere } = makeAtmosphere({ random: seededRandom(5) })
    atmosphere.params.set('enabled', true)
    const rate = atmosphere.params.get('rate')
    atmosphere.params.set('rate', NaN)
    atmosphere.params.set('spread', NaN)
    expect(atmosphere.params.get('rate')).toBe(rate)
    const before = atmosphere.getOvercast()
    for (let i = 0; i < 600; i++) dynamics.tick(1 / 60)
    expect(atmosphere.getOvercast()).not.toBeCloseTo(before, 6)
  })
})

describe('settings are params', () => {
  test('no removed settings method remains in src/ or tests/', () => {
    const only = ['setWalking', 'getWalking', 'setOnset', 'getOnset', 'setSpread', 'getSpread', 'setFull', 'getFull']
    const shared = { receiver: '\\w*[aA]tmosphere', names: ['setEnabled', 'getEnabled', 'setRate', 'getRate'] }
    expect(removedNameHits(only, shared, import.meta.url)).toEqual([])
  })

  test('the snapshot keeps its flat setting keys and the grey-light window does not re-apply on restore', () => {
    const { atmosphere, applied } = makeAtmosphere()
    expect(Object.keys(atmosphere.exportState())).toEqual(expect.arrayContaining(['enabled', 'walking', 'spread', 'rate', 'onset', 'full']))
    const before = applied.length
    atmosphere.importState({ onset: 0.3, full: 0.7 })
    expect(applied.length - before).toBe(1)
    expect([atmosphere.params.get('onset'), atmosphere.params.get('full')]).toEqual([0.3, 0.7])
  })
})

/**
 * The weather's profiles as rows, generated from WEATHER_PARAMS: every entry
 * has the rows it declares, a clear row reads its source by mode, and the
 * snapshot keeps the clear and heavy profiles as its `clear` / `heavy` objects,
 * keyed by the weather key.
 */
describe('profile rows', () => {
  const rowsById = new Map(ATMOSPHERE_PARAMS.map(r => [`${r.key}`, r]))

  test.each(WEATHER_PARAMS.map(e => [e.key, e]))('%s has exactly the profile rows it declares, with the right shape', (_key, e) => {
    expect(rowsById.has(`heavy.${e.key}`)).toBe(e.heavy !== undefined)
    expect(rowsById.has(`clear.${e.key}`)).toBe(e.clear !== undefined)
    if (e.clear !== undefined) expect(rowsById.get(`clear.${e.key}`).mirrorOf).toBe(e.ref)
    if (e.heavy !== undefined) expect(rowsById.get(`heavy.${e.key}`).mirrorOf).toBeUndefined()
    for (const side of ['clear', 'heavy']) {
      if (e[side] === undefined) continue
      const row = rowsById.get(`${side}.${e.key}`)
      expect(row.persist, 'profile rows ride the snapshot as clear/heavy objects, not as rows').toBe(false)
      expect(row.owner).toBe('atmosphere')
    }
  })

  test('every driven key has a clear row, and every heavy default is the row it came from', () => {
    for (const key of WEATHER_DRIVEN_KEYS) expect(rowsById.has(`clear.${key}`), key).toBe(true)
    for (const [key, value] of Object.entries(HEAVY_START)) {
      const e = WEATHER_PARAMS.find(p => p.key === key)
      expect(value).toBe(e.kind === 'colour' ? hexToInt(e.heavy) : e.heavy)
    }
  })

  test.each(WEATHER_DRIVEN_KEYS.map(k => [k]))('%s: the clear row reads the captured value while on and the live param while off', key => {
    const { atmosphere, scene } = makeAtmosphere()
    const e = WEATHER_PARAMS.find(p => p.key === key)
    const shown = n => (e.kind === 'colour' ? intToHex(n) : n)
    atmosphere.params.set('walking', false)
    const captured = CLEAR[key]   // what the construction-time capture read
    atmosphere.setChannel('overcast', 1)   // the scene now holds the blend, not the clear day
    expect(atmosphere.params.get(`clear.${key}`)).toBe(shown(captured))
    atmosphere.params.set('enabled', false)
    scene[key] = captured === 1 ? 2 : 1   // an authored live value
    expect(atmosphere.params.get(`clear.${key}`)).toBe(shown(scene[key]))
  })

  test('a heavy row reads and writes the held heavy value, colours as #rrggbb, and a write re-applies while on', () => {
    const { atmosphere, applied } = makeAtmosphere()
    expect(atmosphere.params.get('heavy.skyHex')).toBe(intToHex(HEAVY_START.skyHex))
    applied.length = 0
    atmosphere.params.set('heavy.skyHex', '#102030')
    expect(applied).toHaveLength(1)
    expect(applied[0].heavy.skyHex).toBe(0x102030)
    expect(atmosphere.exportState().heavy.skyHex).toBe(0x102030)
  })

  test('a clear colour row writes the captured colour as an int', () => {
    const { atmosphere } = makeAtmosphere()
    atmosphere.params.set('clear.artSky', '#a0b0c0')
    expect(atmosphere.exportState().clear.artSky).toBe(0xa0b0c0)
  })

  test('the walked scalars are rows: reading is the walk position, writing is setChannel', () => {
    const { atmosphere } = makeAtmosphere()
    atmosphere.params.set('haze', 0.31)
    expect(atmosphere.getHaze()).toBeCloseTo(0.31, 12)
    expect(atmosphere.params.get('haze')).toBeCloseTo(0.31, 12)
  })

  test('a clear row follows the live param while the weather is off, and not while it is on', () => {
    const scene = { ...CLEAR }
    const hooks = new Map()
    const live = {
      get: k => scene[k], set: (k, v) => { scene[k] = v },
      onChange: (k, fn) => hooks.set(k, fn),
    }
    const atmosphere = new Atmosphere(fakeDynamics(), { apply: () => {}, live, noiseSpeed: () => 1 })
    const seen = []
    atmosphere.params.onChange('clear.glow', v => seen.push(v))
    hooks.get('glow')()
    expect(seen).toEqual([])           // on: the clear row shows the capture
    atmosphere.params.set('enabled', false)
    scene.glow = 0.4
    hooks.get('glow')()
    expect(seen).toEqual([0.4])        // off: it is the live value
  })

  test('the curves and colour blend key only parameters the list drives', () => {
    const clear = Object.fromEntries(WEATHER_DRIVEN_KEYS.map(k => [k, 0.5]))
    const heavy = { ...HEAVY_START }
    const keys = [
      ...Object.keys(overcastCurves(clear, heavy, 0.5, { onset: 0, full: 1 })),
      ...Object.keys(hazeCurves(clear, heavy, 0.5)),
      ...Object.keys(colourCurves({ ...clear, skyHex: 0, artSky: 0, zenithSky: 0, artGround: 0 }, heavy, 0.5, 0.5, 1)),
    ]
    expect(new Set(keys).size).toBe(keys.length)
    // Every driven param is written by exactly one curve.
    expect([...keys].sort()).toEqual([...WEATHER_DRIVEN_KEYS].sort())
  })

  test('a snapshot with clear/heavy objects loads, and re-exports the same objects', () => {
    const saved = {
      u: { overcast: 0.4, haze: 0.2 }, target: { overcast: 0.5, haze: 0.3 },
      enabled: true, walking: true, spread: 0.5, rate: 0.01, onset: 0.5, full: 1,
      clear: { ...CLEAR }, heavy: { ...HEAVY_START, shadowValue: 0.33 },
    }
    const { atmosphere } = makeAtmosphere()
    expect(atmosphere.importState(saved).unknown).toEqual([])
    const out = atmosphere.exportState()
    expect(out.clear).toEqual(saved.clear)
    expect(out.heavy).toEqual(saved.heavy)
    expect(Object.keys(out.heavy).sort()).toEqual(Object.keys(saved.heavy).sort())
    expect(atmosphere.params.get('heavy.shadowValue')).toBe(0.33)
  })

  test('no removed weather method or panel helper remains in src/ or tests/', () => {
    const only = ['captureClear', 'readClear', 'writeClear', 'syncAtmospherePanel', 'syncFormDependents', 'resyncWeatherPanel',
      'onWeatherWrote', 'declaredControlIds', 'controlIdFor', 'HEAVY_DEFAULTS', 'START_DEFAULTS', 'ATMO_SLIDER_ROWS']
    const shared = { receiver: '\\w*[aA]tmosphere', names: ['getClear', 'setClear', 'getHeavy', 'setHeavy'] }
    expect(removedNameHits(only, shared, import.meta.url)).toEqual([])
  })
})
