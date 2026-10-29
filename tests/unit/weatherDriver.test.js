import { describe, test, expect } from 'vitest'
import { createWeatherDriver, weatherLockedIds } from '../../src/scene/weatherDriver.js'
import { PANEL_ROWS } from '../../src/panel/panelRows.js'
import { WEATHER_PARAMS, WEATHER_DRIVEN_KEYS, HEAVY_START } from '../../src/drift/atmosphereParams.js'
import { overcastCurves, hazeCurves, mixHex, scaleHex, shapeOvercast } from '../../src/drift/atmosphereMath.js'
import { densityToWeatherEffect, absorptionToDensity } from '../../src/drift/cloudDialsMath.js'
import { createSceneUniforms } from '../../src/shared/sceneUniforms.js'

/**
 * weatherDriver.test.js — the weather's write path, without a browser.
 * `tests/unit/atmosphere.test.js` mocks this port entirely, so these cases
 * are what exercise the real write path outside `tests/visual/atmosphere.spec.js`.
 *
 * Every scene/water/clouds/artPass method below is a minimal fake writing
 * into one shared plain object (`s`), the same shape atmosphere.test.js's
 * `CLEAR` uses for its own stand-in scene.
 */
function makeFakeScene(overrides = {}) {
  const s = {
    shadowValue: 0.05, glow: 0.30,
    shadowHueAmt: 0.45, aerialDesat: 0.55,
    skyHex: 0xc8ddf0, zenithSky: 0x2a4d7a, artSky: 0x8fa8c4, artGround: 0xc8bda4,
    cloudCoverage: 1.16, cloudGrey: 0.0, specAmt: 0.80, reflectAmt: 1.00,
    baseFreq: 0.002, absorption: 0.3,
    snowBase: 0.6,
    ...overrides,
  }
  // terrain.params over `s`; this suite asserts only the keys it names.
  const terrain = {
    params: { get: k => s[k], set: (k, v) => { s[k] = v } },
  }
  const water = {
    params: { get: k => s[k], set: (k, v) => { s[k] = v } },
    withSeaSnap: (snap, fn) => fn(),
  }
  // clouds.params over `s`, under the fixture's names for coverage and grey.
  const CLOUD_KEY = { coverage: 'cloudCoverage', weatherGrey: 'cloudGrey' }
  const clouds = {
    params: { get: k => s[CLOUD_KEY[k] || k], set: (k, v) => { s[CLOUD_KEY[k] || k] = v } },
  }
  // artPass.params' colour rows over `s`, as '#rrggbb'.
  const artPass = {
    params: {
      get: k => '#' + (s[k] >>> 0).toString(16).padStart(6, '0'),
      set: (k, hex) => { s[k] = parseInt(hex.slice(1), 16) },
    },
  }
  const godrays = { params: { set: (k, v) => { if (k === 'intensityScale') s.rayScale = v } } }
  const sky = {
    params: {
      get: k => (k === 'horizonHex' ? s.skyHex : s.zenithSky),
      set: (k, v) => { if (k === 'zenithHex') s.zenithSky = v },
    },
  }
  const scene = { background: { getHex: () => s.skyHex }, fog: { near: 400, far: 1100 } }
  // The horizon owner: one write that the fixture keeps as the sky's colour.
  const horizon = { params: { get: () => s.skyHex, set: (_k, hex) => { s.skyHex = hex } } }
  // The real scene-wide set: it has no dependencies of its own.
  const sceneUniforms = createSceneUniforms()
  return { s, terrain, water, clouds, artPass, godrays, sky, scene, sceneUniforms, horizon }
}

function makeBindings(overrides, extra) {
  const fake = makeFakeScene(overrides)
  const bindings = createWeatherDriver({
    terrain: fake.terrain, water: fake.water, clouds: fake.clouds,
    artPass: fake.artPass, godrays: fake.godrays, sky: fake.sky, scene: fake.scene,
    sceneUniforms: fake.sceneUniforms, horizon: fake.horizon, ...extra,
  })
  return { ...fake, bindings }
}

const SHAPE = { onset: 0.5, full: 1 }

/** The clear day of the fixture: every driven parameter, as the weather captures it. */
function captureClearDay(bindings) {
  return Object.fromEntries(WEATHER_DRIVEN_KEYS.map(k => [k, bindings.live.get(k)]))
}

/**
 * The weather's blend written out independently of weatherDriver: each curve
 * and colour mix as the arithmetic says, per key, with the cloud amount snapped
 * to its 0.002 grid. What applyWeather must have written for a state.
 */
function expectedBlend(state, absorption) {
  const { clear, heavy, overcast, haze } = state
  const effect = densityToWeatherEffect(absorptionToDensity(absorption))
  const lit = overcastCurves(clear, heavy, overcast, SHAPE, effect, haze)
  const dist = hazeCurves(clear, heavy, haze)
  const litW = shapeOvercast(overcast, SHAPE) * effect
  const sky = k => mixHex(mixHex(clear[k], heavy.skyHex, litW), heavy.hazeSky, haze)
  return {
    ...lit, ...dist,
    cloudCoverage: Math.round(lit.cloudCoverage / 0.002) * 0.002,
    skyHex: sky('skyHex'), artSky: sky('artSky'), zenithSky: sky('zenithSky'),
    artGround: scaleHex(clear.artGround, lit.lightLevel / Math.max(clear.lightLevel, 1e-4)),
  }
}

describe('weatherDriver', () => {
  test('live reads and writes every driven parameter by the weather key', () => {
    const { bindings } = makeBindings()
    const cases = [
      ['shadowValue', 0.2], ['glow', 0.5], ['shadowHueAmt', 0.1],
      ['aerialDesat', 0.3], ['fogCurve', 0.4], ['fogMaxAlpha', 0.7],
      ['skyHex', 0x112233], ['artSky', 0x445566], ['artGround', 0x778899],
      ['zenithSky', 0x0a0b0c], ['specAmt', 0.6], ['reflectAmt', 0.9],
    ]
    for (const [key, value] of cases) {
      bindings.live.set(key, value)
      expect(bindings.live.get(key)).toBe(value)
    }
  })

  test('the fog range reaches the scene-wide uniforms and three\'s scene.fog together', () => {
    const { bindings, sceneUniforms, scene } = makeBindings()
    bindings.live.set('fogNear', 123)
    expect(sceneUniforms.params.get('fogNear')).toBe(123)
    expect(scene.fog.near).toBe(123)
    expect(scene.fog.far).toBe(sceneUniforms.params.get('fogFar'))
  })

  test('every WEATHER_PARAMS ref resolves to a live target, and nothing else does', () => {
    const { bindings } = makeBindings()
    for (const e of WEATHER_PARAMS) {
      if (e.ref) expect(() => bindings.live.get(e.key), e.key).not.toThrow()
      else expect(() => bindings.live.get(e.key), e.key).toThrow()
    }
  })

  test('weatherLockedIds: the visible panel rows of the driven params, minus the opt-outs', () => {
    const ids = weatherLockedIds(PANEL_ROWS)
    expect(ids).toContain('ctrl-shadow-value')
    expect(ids).toContain('col-sky')
    expect(ids).toContain('art-col-sky')
    // No panel control (hidden rows) or the clear-authoring swatch: not locked.
    expect(ids).not.toContain('art-col-ground')
    expect(ids.every(Boolean)).toBe(true)
    expect(new Set(ids).size).toBe(ids.length)
    expect([...ids].sort()).toEqual([
      'art-col-sky', 'col-sky', 'ctrl-aerial-desat', 'ctrl-cvol-coverage', 'ctrl-fog-curve',
      'ctrl-fog-max', 'ctrl-glow', 'ctrl-light-level', 'ctrl-shadow-hue-amt', 'ctrl-shadow-value',
      'ctrl-water-reflect', 'ctrl-water-spec',
    ])
  })

  test('applyWeather restores the clear snapshot verbatim when disabled', () => {
    const { s, bindings } = makeBindings()
    const clear = captureClearDay(bindings)
    s.glow = 0.99   // scene drifted away from clear after capture
    bindings.applyWeather({ enabled: false, clear, heavy: clear, overcast: 0, haze: 0, shape: SHAPE })
    expect(s.glow).toBe(clear.glow)
  })

  test('applyWeather with no clear writes nothing', () => {
    const { bindings } = makeBindings()
    const clear = captureClearDay(bindings)
    bindings.applyWeather({ enabled: true, clear: null })
    expect(captureClearDay(bindings)).toEqual(clear)
  })

  test.each([
    ['clear', 0, 0], ['full overcast', 1, 0], ['full haze', 0, 1],
    ['overcast mid', 0.7, 0.3], ['haze mid', 0.2, 0.55], ['both', 1, 1],
  ])('applyWeather writes what an independent blend says: %s', (_name, overcast, haze) => {
    const { bindings, s } = makeBindings()
    const clear = captureClearDay(bindings)
    const state = { enabled: true, clear, heavy: { ...HEAVY_START }, overcast, haze, shape: SHAPE }
    bindings.applyWeather(state)
    const want = expectedBlend(state, s.absorption)
    for (const [key, value] of Object.entries(want)) {
      expect(bindings.live.get(key), key).toBeCloseTo(value, 9)
    }
  })

  test('reapplyWeather re-runs the last state only', () => {
    const { bindings, s } = makeBindings()
    bindings.reapplyWeather()   // no weather applied yet: nothing to re-run
    const clear = captureClearDay(bindings)
    bindings.applyWeather({ enabled: false, clear, heavy: clear, overcast: 0, haze: 0, shape: SHAPE })
    s.glow = 0.99
    bindings.reapplyWeather()
    expect(s.glow).toBe(clear.glow)
  })
})
