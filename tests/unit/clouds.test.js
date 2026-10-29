import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { VolumeClouds } from '../../src/clouds/cloudsVolume.js'
import { CLOUD_PARAMS } from '../../src/clouds/cloudParams.js'
import { createSceneUniforms } from '../../src/shared/sceneUniforms.js'
import { removedNameHits } from './sourceScan.js'
import { rollStepLimit, weatherRelightDistance } from '../../src/clouds/cloudVolumeMath.js'

/**
 * clouds.params (cloudsVolume.js over cloudParams.js's rows): what a write of
 * each key makes stale, the change guard, the worley-octave ceiling, the
 * cloud target and the snapshot shape. The volume builds THREE
 * materials and render targets only; no GL context is needed.
 */

const LAYERS = 32
const make = () => new VolumeClouds(createSceneUniforms())

// What a change of each key re-does, as the pre-accessor setCloudParam did it
// (its SHAPE_DIRTY_KEYS, ROLLABLE_KEYS, LIGHT_DIRTY_KEYS and _recomputeGrid
// calls), the sun and weather-sky setters, written out here independently of
// the rows. A rollable key with no baked volume to roll falls back to `shape`.
const GRID  = ['drawDistance', 'baseFreq', 'lacunarity', 'gain', 'worleyFreq', 'worleyOctaves', 'marchStepSize']
const SHAPE = ['drawDistance', 'baseFreq', 'lacunarity', 'gain', 'cloudLevel', 'cloudHeight', 'curlFreq',
  'curlStrength', 'worleyFreq', 'worleyAmount', 'worleyErosion', 'worleyOctaves']
const LIGHT = ['densityScale', 'coverage', 'lightSteps', 'lightStepSize', 'sunAzimuth', 'sunElevation',
  'weatherStrength', 'weatherScale']
const MARCH = ['weatherSky', 'weatherStrength', 'weatherScale']

/** A value for `key` that differs from what it holds. */
function another(v, r) {
  const cur = v.params.get(r.key)
  if (typeof cur === 'boolean') return !cur
  if (r.encode === 'srgb') return cur === '#123456' ? '#654321' : '#123456'
  if (r.encode === 'vec2') return new THREE.Vector2(cur.x + 0.1, cur.y - 0.1)
  if (r.key === 'worleyOctaves') return cur === 1 ? 3 : 1
  if (r.kind === 'slider') return cur === r.max ? r.min : r.max
  return cur + 0.25
}

/** A volume with every dirty flag clear, and a counter on _recomputeGrid. */
function settled() {
  const v = make()
  let grids = 0
  const recompute = v._recomputeGrid.bind(v)
  v._recomputeGrid = () => { grids++; recompute() }
  const clear = () => {
    v._shapeDirty = false
    v._bakedOrigin = { x: 0, z: 0 }
    v._lightPending = 0
    v._shapePending = 0
    v._marchDirty = false
    grids = 0
  }
  clear()
  const effects = () => {
    const out = []
    if (grids) out.push('grid')
    if (v._shapeDirty && v._bakedOrigin === null) out.push('shape')
    if (v._shapePending === LAYERS) out.push('roll')
    if (v._lightPending === LAYERS) out.push('light')
    if (v._marchDirty) out.push('march')
    return out
  }
  return { v, clear, effects }
}

describe('clouds.params', () => {
  it('holds every row at its default after construction', () => {
    const v = make()
    for (const r of CLOUD_PARAMS) {
      const got = v.params.get(r.key)
      const held = got && got.isVector2 ? [got.x, got.y] : got
      expect(held, r.key).toEqual(r.value)
    }
  })

  it('a change re-does exactly what that key invalidates', () => {
    const { v, clear, effects } = settled()
    for (const r of CLOUD_PARAMS) {
      clear()
      v.params.set(r.key, another(v, r))
      v.snapEases()                                // the eased rows land on their uniforms
      const expected = []
      if (GRID.includes(r.key)) expected.push('grid')
      if (SHAPE.includes(r.key)) expected.push('shape')
      if (LIGHT.includes(r.key)) expected.push('light')
      if (MARCH.includes(r.key)) expected.push('march')
      expect(effects(), r.key).toEqual(expected)
    }
  })

  it('a value equal to the current one invalidates nothing', () => {
    const { v, clear, effects } = settled()
    for (const r of CLOUD_PARAMS) {
      clear()
      const cur = v.params.get(r.key)
      v.params.set(r.key, cur && cur.isVector2 ? cur.clone() : cur)
      expect(effects(), r.key).toEqual([])
    }
    // The horizon colour arrives as a hex integer (main.js applyHorizon).
    clear()
    v.params.set('weatherSky', parseInt(v.params.get('weatherSky').slice(1), 16))
    expect(effects()).toEqual([])
  })

  it('a small frequency step over a baked volume rolls; a large one re-bakes', () => {
    const { v, clear, effects } = settled()
    const f0 = v.params.get('baseFreq')
    const bake = () => {
      v._shapeRT = {}
      v._layerBaseFreq.fill(v.params.get('baseFreq'))
      v._layerWorleyFreq.fill(v.params.get('worleyFreq'))
    }
    bake()
    clear()
    v.params.set('baseFreq', f0 * 1.00002)
    v.snapEases()
    expect(effects()).toEqual(['grid', 'roll'])
    expect(v._bakedOrigin).not.toBeNull()      // the window's content stays valid
    bake()
    clear()
    v.params.set('baseFreq', f0 * 1.5)
    v.snapEases()
    expect(effects()).toEqual(['grid', 'shape'])
  })

  it('worley octaves: a requested ceiling, read back as what the grid carries', () => {
    const v = make()
    const u = v._bakeMaterial.uniforms.uWorleyOctaves
    v.params.set('worleyOctaves', 3)
    v.params.set('worleyFreq', 0.02)              // too fine for 3 on this grid
    const carried = u.value
    expect(carried).toBeLessThan(3)
    expect(v.params.get('worleyOctaves')).toBe(carried)
    v.params.set('worleyFreq', 0.0005)            // coarse again: the ceiling comes back
    expect(u.value).toBe(3)
    // Asking for what the grid already carries is no change: the ceiling stays.
    v.params.set('worleyFreq', 0.02)
    v.params.set('worleyOctaves', carried)
    v.params.set('worleyFreq', 0.0005)
    expect(u.value).toBe(3)
  })

  it('the switch is the composite pass', () => {
    const v = make()
    expect(v.pass.enabled).toBe(true)
    v.params.set('enabled', false)
    expect(v.pass.enabled).toBe(false)
    expect(v.passes).toEqual([v.pass])
  })

  it('the per-frame budgets are whole numbers of layers, at least one', () => {
    const v = make()
    v.params.set('lightLayersPerFrame', 2.6)
    expect(v.params.get('lightLayersPerFrame')).toBe(3)
    v.params.set('lightLayersPerFrame', 0)
    expect(v.params.get('lightLayersPerFrame')).toBe(1)
    v.params.set('rollLayersPerFrame', 99)
    expect(v.params.get('rollLayersPerFrame')).toBe(LAYERS)
  })

  it('the cloud target is the canvas size and the composite reads it', () => {
    const v = make()
    v.setSize(200, 100)
    expect(v._cloudRT.width).toBe(200)
    expect(v._cloudRT.height).toBe(100)
    expect(v._compositeMaterial.uniforms.uCloudTex.value).toBe(v._cloudRT.texture)
  })
})

describe('clouds window placement', () => {
  /** A camera at the shipped pose, looking down -z. */
  const camera = () => {
    const c = new THREE.PerspectiveCamera(45, 16 / 9, 0.1, 3000)
    c.position.set(0, 72.36, 741.4)
    c.lookAt(0, 55, 642)
    c.updateMatrixWorld(true)
    return c
  }
  const origin = v => ({ ...v._origin })

  it('places the window at the first update and then holds still', () => {
    const v = make()
    const cam = camera()
    v.update(cam, 0)
    const first = origin(v)
    expect(first.x).not.toBeNaN()
    v._shapeDirty = false
    for (let i = 0; i < 10; i++) v.update(cam, 0)
    expect(origin(v)).toEqual(first)
    expect(v._shapeDirty).toBe(false)              // no re-anchor, so the held scene stays held
    expect(v.getDiagnostics().regionFits).toBe(true)
  })

  it('the window holds the region it was placed for', () => {
    const v = make()
    v.update(camera(), 0)
    const extent = v._shared.uExtent.value
    const c = extent / 256
    // The terrain plane (+-750 around the origin) and the wedge's far end (z about -1000).
    const min = { x: v._origin.x * c, z: v._origin.z * c }
    expect(min.x).toBeLessThan(-750)
    expect(min.x + extent).toBeGreaterThan(750)
    expect(min.z).toBeLessThan(-1000)
    expect(min.z + extent).toBeGreaterThan(741)
  })

  it('follows the wind: the region is in cloud space', () => {
    const v = make()
    const cam = camera()
    v.update(cam, 0)
    const first = origin(v)
    v._shapeDirty = false
    v.update(cam, 1000)                            // 1000 s of wind at the default speed
    expect(origin(v).x).toBeGreaterThan(first.x)
    expect(v._shapeDirty).toBe(true)
  })

  it('turning the camera moves the window once', () => {
    const v = make()
    const cam = camera()
    v.update(cam, 0)
    const first = origin(v)
    cam.lookAt(900, 55, 741)                       // a quarter turn, toward +x
    cam.updateMatrixWorld(true)
    v.update(cam, 0)
    const turned = origin(v)
    expect(turned).not.toEqual(first)
    v._shapeDirty = false
    for (let i = 0; i < 5; i++) v.update(cam, 0)
    expect(origin(v)).toEqual(turned)
    expect(v._shapeDirty).toBe(false)
  })

  it('a region wider than the window never re-anchors every frame', () => {
    const v = make()
    v.params.set('drawDistance', 3600)             // the longest draw distance ...
    v.params.set('sunElevation', 0.05)             // ... under a grazing sun
    const cam = camera()
    cam.lookAt(0, 0, 741.4 - 100)
    cam.position.y = 72.36
    cam.updateMatrixWorld(true)
    v.update(cam, 0)
    const placed = origin(v)
    v._shapeDirty = false
    for (let i = 0; i < 10; i++) v.update(cam, 0)
    expect(origin(v)).toEqual(placed)
    expect(v._shapeDirty).toBe(false)
  })

  it('looking straight up spans every heading and still places a window', () => {
    const v = make()
    const cam = camera()
    cam.lookAt(0, 5000, 741.4)
    cam.updateMatrixWorld(true)
    v.update(cam, 0)
    expect(v._origin.x).not.toBeNaN()
    expect(v.getDiagnostics().regionFits).toBe(false)   // too wide for the window: the wedge is centred, not held
  })
})

describe('clouds weather bias in the light', () => {
  const cam = () => new THREE.PerspectiveCamera()
  const settled = () => {
    const v = make()
    v.params.set('cloudSpeed', 10)
    v.params.set('weatherSpeed', 0)
    const c = cam()
    v.update(c, 0)
    v._lightPending = 0
    return { v, c }
  }

  it('a drift of the map against the field past the relight distance marks the light stale', () => {
    const { v, c } = settled()
    const limit = weatherRelightDistance(v.params.get('weatherScale'))
    // The field moves by (10, 6) per unit of time, the map not at all.
    v.update(c, 0.5 * limit / Math.hypot(10, 6))
    expect(v._lightPending).toBe(0)
    v.update(c, 0.7 * limit / Math.hypot(10, 6))   // to 1.2 × the limit in all
    expect(v._lightPending).toBe(32)
  })

  it('no drift, no stale light: map and field moving together keep it', () => {
    const { v, c } = settled()
    v.params.set('weatherSpeed', 10)
    for (let i = 0; i < 50; i++) v.update(c, 1)   // one unit of time a frame
    expect(v._lightPending).toBe(0)
  })

  it('with the weather strength at 0 the drift never marks it stale', () => {
    const { v, c } = settled()
    v.params.set('weatherStrength', 0)
    v._lightPending = 0
    for (let i = 0; i < 50; i++) v.update(c, 1)   // one unit of time a frame
    expect(v._lightPending).toBe(0)
  })

  it('changing the strength or the scale marks it stale', () => {
    const { v } = settled()
    v.params.set('weatherStrength', 2)
    expect(v._lightPending).toBe(32)
    v._lightPending = 0
    v.params.set('weatherScale', 3000)
    expect(v._lightPending).toBe(32)
  })
})

describe('clouds eased values', () => {
  const cam = () => new THREE.PerspectiveCamera()
  const frame = 1 / 60

  it('the coverage a pass uses eases toward its row, on the time constant', () => {
    const v = make()
    const c = cam()
    v.update(c, 0)                                 // place the window
    const from = v._shared.uCoverage.value
    v.params.set('coverage', from - 1)
    expect(v._shared.uCoverage.value).toBe(from)   // a write alone moves nothing
    v.params.set('coverageEase', 1)
    let t = 0
    let last = from
    while (t < 1 - 1e-9) {
      v.update(c, 0, frame); t += frame
      const now = v._shared.uCoverage.value
      expect(now).toBeLessThan(last)               // monotone toward the target
      expect(now).toBeGreaterThan(from - 1)        // never past it
      last = now
    }
    expect((from - last) / 1).toBeCloseTo(1 - Math.exp(-1), 1)   // 63% after one time constant
    for (let i = 0; i < 600; i++) v.update(c, 0, frame)
    expect(v._shared.uCoverage.value).toBe(from - 1)             // and it lands on the row
  })

  it('lands on its rows at once while the world holds still', () => {
    const v = make()
    const c = cam()
    v.update(c, 0)
    v.params.set('coverage', 0.5)
    v.params.set('baseFreq', v.params.get('baseFreq') * 1.05)
    v.setSceneStatic(true)
    v.update(c, 0, frame)
    expect(v._shared.uCoverage.value).toBe(0.5)
    expect(v._bakeMaterial.uniforms.uBaseFreq.value).toBe(v.params.get('baseFreq'))
  })

  it('lands exactly on the scale row, however many steps it took', () => {
    const v = make()
    const c = cam()
    v.update(c, 0)
    v.params.set('baseFreq', v.params.get('baseFreq') * 1.003)
    for (let i = 0; i < 60; i++) v.update(c, 0, frame)
    expect(v._bakeMaterial.uniforms.uBaseFreq.value).toBe(v.params.get('baseFreq'))
  })

  it('snaps without a dt or with an ease of 0, and holds at dt 0', () => {
    const v = make()
    v.params.set('coverage', 1.2)
    v.update(cam(), 0, 0)
    expect(v._shared.uCoverage.value).not.toBe(1.2)              // paused: held
    v.update(cam(), 0)
    expect(v._shared.uCoverage.value).toBe(1.2)                  // no dt: snaps
    v.params.set('coverage', 0.4)
    v.params.set('coverageEase', 0)
    v.update(cam(), 0, frame)
    expect(v._shared.uCoverage.value).toBe(0.4)
  })

  it('every frame of an ease marks the light stale', () => {
    const v = make()
    const c = cam()
    v.update(c, 0)
    v._lightPending = 0
    v.params.set('coverage', 0.5)
    v.update(c, 0, frame)
    expect(v._lightPending).toBe(32)
  })

  it('the cloud scale moves at most the roll limit per frame and rolls, never re-bakes', () => {
    const v = make()
    const c = cam()
    v.update(c, 0)
    v._shapeRT = {}                                // a baked volume, so a roll is possible
    v._shapeDirty = false
    v._bakedOrigin = { ...v._origin }
    const f0 = v._bakeMaterial.uniforms.uBaseFreq.value
    v._layerWorleyFreq.fill(v.params.get('worleyFreq'))
    v._layerBaseFreq.fill(f0)
    v.params.set('baseFreq', f0 * 1.3)             // a big scatter move
    const limit = rollStepLimit(256, 32, v.params.get('rollLayersPerFrame'))
    let last = f0
    for (let i = 0; i < 2000 && v._bakeMaterial.uniforms.uBaseFreq.value !== f0 * 1.3; i++) {
      v.update(c, 0, frame)
      const now = v._bakeMaterial.uniforms.uBaseFreq.value
      expect(now / last - 1, `frame ${i}`).toBeLessThanOrEqual(limit + 1e-12)
      expect(v._bakedOrigin, 'a full re-bake was asked for').not.toBeNull()
      // the layers baked so far stay within one cell of each other, as the roll requires
      v._layerBaseFreq.fill(last)
      last = now
    }
    expect(v._bakeMaterial.uniforms.uBaseFreq.value).toBe(f0 * 1.3)
  })

  it('an export holds the rows, and a restore snaps both uniforms to them', () => {
    const a = make()
    a.update(cam(), 0)
    a.params.set('coverage', 1.0)
    a.params.set('baseFreq', 0.009)
    a.update(cam(), 0, frame)                      // one frame into the ease
    const state = JSON.parse(JSON.stringify(a.exportState()))
    expect(state.params.coverage).toBe(1.0)
    expect(state.params.baseFreq).toBe(0.009)
    const b = make()
    b.importState(state)
    expect(b._shared.uCoverage.value).toBe(1.0)
    expect(b._bakeMaterial.uniforms.uBaseFreq.value).toBe(0.009)
  })
})

describe('clouds snapshot', () => {
  it('exports { format, params, integrated }: the rows, with the switch and held params among them', () => {
    const s = make().exportState()
    expect(Object.keys(s).sort()).toEqual(['format', 'integrated', 'params'])
    for (const k of ['enabled', 'incremental', 'lightLayersPerFrame',
      'rollLayersPerFrame', 'cloudSpeed', 'weatherSpeed']) expect(s.params, k).toHaveProperty(k)
    // The scrolling state is captured by name; the grid-derived uniforms are not.
    expect(Object.keys(s.integrated)).toContain('uWindOffset')
    expect(Object.keys(s.integrated)).not.toContain('uCellSize')
  })

  it('round-trips every held param, the switch and the uniforms', () => {
    const a = make()
    a.setSize(200, 100)
    a.params.set('enabled', false)
    a.params.set('lightLayersPerFrame', 5)
    a.params.set('rollLayersPerFrame', 9)
    a.params.set('incremental', false)
    a.params.set('coverage', 1.5)
    a.params.set('useSint', false)
    a.snapEases()
    const state = JSON.parse(JSON.stringify(a.exportState()))

    const b = make()
    b.setSize(200, 100)
    const report = b.importState(state)
    expect(report).toEqual({ unknown: [], rejected: [] })
    for (const key of ['enabled', 'lightLayersPerFrame', 'rollLayersPerFrame', 'incremental',
      'coverage', 'useSint']) {
      expect(b.params.get(key), key).toEqual(a.params.get(key))
    }
    expect(b._shapeDirty).toBe(true)                // and a full re-bake owed
  })
})

describe('clouds removed methods', () => {
  // Defined on no other module: any mention is a stale caller or comment.
  const ONLY_CLOUDS = [
    'setCloudParam', 'getCloudParam', 'setShadingParam', 'getShadingParam',
    'setUseSint', 'getUseSint', 'setPowderEnabled', 'getPowderEnabled',
    'setLightLayersPerFrame', 'getLightLayersPerFrame',
    'setRollLayersPerFrame', 'getRollLayersPerFrame', 'setIncrementalUpdates', 'getIncrementalUpdates',
    'setWeatherSky', 'getWeatherSky', 'setSunElevation', 'setSunAzimuth',
    'CloudSystem', 'cloudSystem', 'SHAPE_DIRTY_KEYS', 'ROLLABLE_KEYS', 'LIGHT_DIRTY_KEYS',
    'SHADING_KEYS', 'SHADING_EXTRA',
  ]
  // Still defined by other owners (godrays, the art pass, the weather, …):
  // only a call on `clouds` is stale.
  const SHARED = { receiver: 'clouds', names: ['setEnabled', 'getEnabled', 'setRenderScale', 'getRenderScale', 'setDebugView', 'getDebugView'] }

  it('no source or test still names them', () => {
    expect(removedNameHits(ONLY_CLOUDS, SHARED, import.meta.url)).toEqual([])
  })
})
