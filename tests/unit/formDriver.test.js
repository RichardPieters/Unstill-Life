import { describe, test, expect } from 'vitest'
import { createFormDriver, formDrivenIds } from '../../src/scene/formDriver.js'
import { FORM_PARAMS } from '../../src/scene/formParams.js'
import { TERRAIN_PARAMS } from '../../src/terrain/terrainParams.js'
import { WATER_PARAMS } from '../../src/water/waterParams.js'
import { FORM_CORNERS, formTargets } from '../../src/drift/terrainForm.js'
import { absorptionToDensity } from '../../src/drift/cloudDialsMath.js'
import { removedNameHits } from './sourceScan.js'
import { Water } from '../../src/water/water.js'
import { createSceneUniforms } from '../../src/shared/sceneUniforms.js'

/**
 * formDriver.test.js — the form owner without a browser: the five dials'
 * writes, their order, and the single-blend batch. Terrain, the clouds and the
 * godrays are plain fakes writing into one object; the sea band uses the real
 * Water for its pair rule.
 */
function fakeParams(s) {
  const listeners = {}
  return {
    get: k => s[k],
    set: (k, v) => {
      if (s[k] === v) return true
      s[k] = v
      for (const fn of listeners[k] || []) fn(v)
      return true
    },
    onChange: (k, fn) => { (listeners[k] ||= []).push(fn) },
  }
}

function makeForm(extra = {}, water) {
  const s = { snowBase: 0.6, baseFreq: 0.002, absorption: 0.3 }
  const writes = []
  const terrainParams = fakeParams(s)
  const terrain = {
    params: { ...terrainParams, set: (k, v) => { writes.push(k); return terrainParams.set(k, v) } },
  }
  const fakeWater = water || { params: fakeParams(s), withSeaSnap: (snap, fn) => fn() }
  const clouds = { params: fakeParams(s) }
  const godrays = { params: fakeParams(s) }
  const sceneUniforms = createSceneUniforms()
  const form = createFormDriver({ terrain, water: fakeWater, clouds, godrays, sceneUniforms, ...extra })
  return { s, writes, form, sceneUniforms, terrain, clouds, water: fakeWater }
}

const POS = { ocean: 0, mountains: 0, snowline: 0.9, cloudScatter: 0.5, cloudDensity: 0.5 }

describe('form owner', () => {
  test('apply writes the snowline dial', () => {
    const { s, form } = makeForm()
    form.apply(POS)
    expect(s.snowBase).toBeCloseTo(0.4 + 0.9 * 0.6, 10)
    expect(form.params.get('snowline')).toBeCloseTo(0.9, 10)
  })

  test('apply blends once per call, however many dials moved', () => {
    const { writes, form } = makeForm()
    form.apply(POS)
    expect(writes.filter(k => k === 'fbm0Amp')).toHaveLength(1)
    writes.length = 0
    form.apply({ ...POS, ocean: 0.4, mountains: 0.7 })
    expect(writes.filter(k => k === 'fbm0Amp')).toHaveLength(1)
  })

  test('a hand-dragged ocean dial blends and leaves the cloud dials alone', () => {
    const { s, form } = makeForm()
    const before = { baseFreq: s.baseFreq, absorption: s.absorption }
    form.params.set('ocean', 0.3)
    expect(s.baseFreq).toBe(before.baseFreq)
    expect(s.absorption).toBe(before.absorption)
    expect(s.fbm0Amp).toBeCloseTo(formTargets(0.3, 1).fbm0Amp, 10)
  })

  test('importState restores the exported positions and writes nothing', () => {
    const a = makeForm()
    a.form.apply({ ocean: 0.7, mountains: 0.2, snowline: 0.1, cloudScatter: 0.9, cloudDensity: 0.8 })
    const saved = JSON.parse(JSON.stringify(a.form.exportState()))

    const b = makeForm()
    b.writes.length = 0
    const before = { ...b.s }
    const report = b.form.importState(saved)
    expect(b.form.positions()).toEqual(a.form.positions())
    expect(b.writes).toEqual([])
    expect(b.s).toEqual(before)
    expect(report).toEqual({ unknown: [], rejected: [] })
  })

  test('importState names a key that is no dial', () => {
    const { form } = makeForm()
    expect(form.importState({ ocean: 0.5, nonsense: 1 }).unknown).toEqual(['nonsense'])
  })

  test('positions reports what a drag and apply last set', () => {
    const { form } = makeForm()
    form.params.set('ocean', 0.7)
    form.params.set('mountains', 0.2)
    expect(form.positions().ocean).toBe(0.7)
    expect(form.positions().mountains).toBe(0.2)
    form.apply({ ...POS, ocean: 0.1 })
    expect(form.positions().ocean).toBe(0.1)
  })

  test('a position that is not finite keeps the held one and skips that cloud write', () => {
    const { s, form } = makeForm()
    form.apply(POS)
    const freq = s.baseFreq
    s.baseFreq = 0.123   // someone else moved it
    form.apply({ ...POS, cloudScatter: NaN })
    expect(form.params.get('cloudScatter')).toBe(0.5)
    expect(s.baseFreq).toBe(0.123)
    expect(freq).not.toBe(0.123)
  })

  test('the snowline position follows terrain when something else writes it', () => {
    const { terrain, form } = makeForm()
    form.apply(POS)
    terrain.params.set('snowBase', 0.7)   // a hand-drag of the snow-base slider
    expect(form.params.get('snowline')).toBeCloseTo(0.5, 10)
  })

  test('a hand-dragged ocean dial leaves the snowline alone', () => {
    const { s, form } = makeForm()
    form.apply(POS)
    const before = s.snowBase
    form.params.set('ocean', 0.5)
    expect(s.snowBase).toBe(before)
    expect(form.params.get('snowline')).toBeCloseTo(0.9, 10)
  })

  test('the scatter dial writes baseFreq continuously', () => {
    const { s, form } = makeForm()
    form.params.set('cloudScatter', 0.2)
    const low = s.baseFreq
    form.params.set('cloudScatter', 0.8)
    expect(s.baseFreq).not.toBe(low)
    const before = s.baseFreq
    form.params.set('cloudScatter', 0.8001)
    expect(s.baseFreq).not.toBe(before)
  })

  test('the density dial writes the scene-wide shadow scale and depth', () => {
    const { form, sceneUniforms } = makeForm()
    form.params.set('cloudDensity', 0.8)
    const abs = sceneUniforms.params.get('cloudShadowAbs')
    const scale = sceneUniforms.params.get('cloudShadowScale')
    form.params.set('cloudDensity', 0.2)
    expect(sceneUniforms.params.get('cloudShadowAbs')).not.toBe(abs)
    expect(sceneUniforms.params.get('cloudShadowScale')).not.toBe(scale)
  })

  test('the density dial calls back only when the effect factor changes', () => {
    // cloudDialsMath's DENSITY_EFFECT_FULL is 0.5: 0.9 and 0.95 share the flat-1 effect.
    let calls = 0
    const { form } = makeForm({ onDensityEffect: () => calls++ })
    form.apply({ ...POS, cloudDensity: 0.9 })
    const first = calls
    form.apply({ ...POS, cloudDensity: 0.95 })
    expect(calls).toBe(first)
    form.apply({ ...POS, cloudDensity: 0.1 })
    expect(calls).toBe(first + 1)
  })

  test('the density position follows the absorption slider, but not its own write', () => {
    const { clouds, form } = makeForm()
    form.params.set('cloudDensity', 0.5)
    expect(form.params.get('cloudDensity')).toBe(0.5)   // exact: the dial's own write is not read back
    clouds.params.set('absorption', 0.03)               // the absorption slider
    expect(form.params.get('cloudDensity')).toBeCloseTo(absorptionToDensity(0.03), 10)
  })
})

describe('form rows and driver ids', () => {
  test('every blended key has a terrain or water control, and the driver claims it', () => {
    const ids = formDrivenIds()
    for (const key of Object.keys(FORM_CORNERS)) {
      const row = [...TERRAIN_PARAMS, ...WATER_PARAMS].find(p => p.key === key)
      expect(row, key).toBeTruthy()
      expect(ids, key).toContain(row.id)
    }
  })

  test('the driver claims each dial that has a control, and no hidden row', () => {
    const ids = formDrivenIds()
    for (const r of FORM_PARAMS) expect(ids.includes(r.id), r.id).toBe(r.kind !== 'hidden')
    expect(ids).toContain('ctrl-cvol-freq')
    expect(ids).toContain('ctrl-cvol-absorb')
  })
})

describe('apply sea band', () => {
  function onRealWater() {
    const water = new Water(new EventTarget(), createSceneUniforms())
    const { form } = makeForm({}, water)
    return { water, form }
  }
  const REST = { snowline: 0.5, cloudScatter: 0.5, cloudDensity: 0.5 }

  test('every (ocean, mountains) jump between the form corners lands exactly on its band', () => {
    const corners = [[0, 0], [0, 1], [1, 0], [1, 1]]
    for (const [o1, m1] of corners) {
      for (const [o2, m2] of corners) {
        const { water, form } = onRealWater()
        form.apply({ ocean: o1, mountains: m1, ...REST })
        form.apply({ ocean: o2, mountains: m2, ...REST })
        const t = formTargets(o2, m2)
        expect(water.params.get('seaLow')).toBe(t.seaLow)
        expect(water.params.get('seaHigh')).toBe(t.seaHigh)
      }
    }
  })

  test('a small step keeps the band exact too (the walker path)', () => {
    const { water, form } = onRealWater()
    for (let o = 0; o <= 1; o += 0.01) {
      form.apply({ ocean: o, mountains: 0.2, ...REST }, { snapSea: false })
      const t = formTargets(o, 0.2)
      expect(water.params.get('seaLow')).toBe(t.seaLow)
      expect(water.params.get('seaHigh')).toBe(t.seaHigh)
    }
  })
})

describe('removed names', () => {
  test('the form half of weatherDriver and the hand id table are gone from src/ and tests/', () => {
    const hits = removedNameHits(
      ['setFormAxis', 'applyTerrainForm', 'FORM_CONTROL_IDS', 'resyncFormPanel', 'onFormWrote',
        'writeDensityDial', 'bindForm', 'bindDial'],
      undefined, import.meta.url)
    expect(hits).toEqual([])
  })
})
