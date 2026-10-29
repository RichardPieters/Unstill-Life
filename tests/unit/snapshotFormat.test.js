import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { Terrain } from '../../src/terrain/terrain.js'
import { Godrays } from '../../src/clouds/godrays.js'
import { VolumeClouds } from '../../src/clouds/cloudsVolume.js'
import { GODRAY_PARAMS } from '../../src/clouds/godrayParams.js'
import { ArtGBuffer } from '../../src/artpass/artGBuffer.js'
import { ArtPass } from '../../src/artpass/artPass.js'
import { ART_ROWS } from '../../src/artpass/artPassParams.js'
import { Water } from '../../src/water/water.js'
import { UNIFORM_CLASSES as WATER_CLASSES } from '../../src/water/waterParams.js'
import { createSceneUniforms } from '../../src/shared/sceneUniforms.js'
import { UNIFORM_CLASSES as TERRAIN_CLASSES } from '../../src/terrain/terrainParams.js'
import { namesOfClass } from '../../src/shared/uniformSerialize.js'

/**
 * The snapshot format of each owner (shared/uniformSerialize.js): the state it
 * exports, a round trip of it, and the refusal of a state of another format.
 */
const LIT_FRAME = { ground: {}, level: 80, height: 140, extent: 4096, windX: 0, windZ: 0, sunX: 0.6, sunY: 0.8, sunZ: 0 }
const json = v => JSON.parse(JSON.stringify(v))

describe('terrain snapshot', () => {
  const make = () => {
    const scene = createSceneUniforms()
    const dyn = new EventTarget()
    const terrain = new Terrain(dyn, scene)
    scene.setCloudShadowFrame(LIT_FRAME)
    return { scene, dyn, terrain }
  }

  it('exports { format, params, integrated, driver, scene } and no derived, frame or constant uniform', () => {
    const { terrain } = make()
    const s = json(terrain.exportState())
    expect(s.format).toBe(2)
    expect(Object.keys(s).sort()).toEqual(['driver', 'format', 'integrated', 'params', 'scene'])
    expect(Object.keys(s.integrated).sort()).toEqual(namesOfClass(TERRAIN_CLASSES, 'integrated').sort())
    expect(s.params).not.toHaveProperty('probeRaw')       // persist:false rows stay out
    expect(s.params).not.toHaveProperty('seaLevel')
    expect(s.params).toHaveProperty('segments')
    expect(s.params).toHaveProperty('baseSpeed1')          // the driver's settings travel as rows
    expect(s.driver).not.toHaveProperty('baseSpeed0')
  })

  it('round-trips into a fresh terrain: rows, integrated uniforms, headings, the master', () => {
    const a = make()
    a.terrain.params.set('snowBase', 0.61)
    a.terrain.params.set('sp:conifer:radius', 3.3)
    a.terrain.params.set('baseSpeed1', 2.2)
    a.terrain.params.set('sunAzimuth', 123)
    a.scene.params.set('cloudShadowAmt', 0.33)
    a.scene.params.set('fogCurve', 0.71)
    for (let i = 1; i <= 12; i++) a.dyn.dispatchEvent(new CustomEvent('tick', { detail: { dt: 0.1, momentum: 1, restlessness: 1, noiseTime: i } }))
    const snap = json(a.terrain.exportState())

    const b = make()
    const report = b.terrain.importState(snap)
    expect(report).toEqual({ unknown: [], rejected: [] })
    expect(json(b.terrain.exportState())).toEqual(snap)
    expect(b.terrain.getDriftAngle(1)).toBe(a.terrain.getDriftAngle(1))
    expect(b.scene.params.get('cloudShadowAmt')).toBeCloseTo(0.33, 12)
    expect(b.scene.params.get('fogCurve')).toBe(0.71)
    // Derived uniforms come from the restored rows, not from the capture.
    const au = a.terrain._material.uniforms, bu = b.terrain._material.uniforms
    expect(bu.uSunAzimuth.value.x).toBeCloseTo(au.uSunAzimuth.value.x, 12)
    expect(b.terrain._heightmapMaterial.uniforms.uErosionStrength.value).toBe(a.terrain._heightmapMaterial.uniforms.uErosionStrength.value)
  })

  it('recomputes uHeightMax and uMantleDC from the restored rows, though no tick runs', () => {
    const a = make()
    a.terrain.params.set('fbm0Amp', 90)
    a.dyn.dispatchEvent(new CustomEvent('tick', { detail: { dt: 0.1, momentum: 1, restlessness: 1, noiseTime: 1 } }))
    const snap = json(a.terrain.exportState())
    const b = make()
    b.terrain.importState(snap)
    expect(b.terrain._material.uniforms.uHeightMax.value).toBe(a.terrain._material.uniforms.uHeightMax.value)
    expect(b.terrain._material.uniforms.uMantleDC.value).toBe(a.terrain._material.uniforms.uMantleDC.value)
    expect(b.terrain._material.uniforms.uHeightMax.value).not.toBe(make().terrain._material.uniforms.uHeightMax.value)
  })

  it('reports a key that is no row, and a state of another format', () => {
    const { terrain } = make()
    const snap = json(terrain.exportState())
    snap.params.nope = 1
    snap.integrated.uGone = 2
    expect(terrain.importState(snap).unknown.sort()).toEqual(['nope', 'uGone'])
    expect(terrain.importState({ format: 99 }).unknown).toEqual(['terrain.format 99'])
  })
})

describe('water snapshot', () => {
  const make = () => {
    const scene = createSceneUniforms()
    const dyn = new EventTarget()
    const water = new Water(dyn, scene)
    return { scene, dyn, water }
  }
  const tick = (dyn, i) => dyn.dispatchEvent(new CustomEvent('tick', { detail: { dt: 0.1, momentum: 0.8, restlessness: 0.3, noiseTime: i } }))

  it('exports { format, params, integrated, driver }; the integrated names are the classified ones', () => {
    const { water } = make()
    const s = json(water.exportState())
    expect(s.format).toBe(2)
    expect(Object.keys(s).sort()).toEqual(['driver', 'format', 'integrated', 'params'])
    expect(Object.keys(s.integrated).sort()).toEqual(namesOfClass(WATER_CLASSES, 'integrated').sort())
    expect(Object.keys(s.driver)).toEqual(['seaLevel'])
    expect(s.params).not.toHaveProperty('artData')   // persist:false
    expect(s.params).not.toHaveProperty('enabled')
  })

  it('round-trips the depth, foam and sparkle bases and the sea band (plan bug 4), and the integrated reactions', () => {
    const a = make()
    a.water.params.set('seaHigh', -2)
    a.water.params.set('seaLow', -14)
    a.water.params.set('deepShare', 1.2)
    a.water.params.set('foamShare', 0.4)
    a.water.params.set('sparkleThreshold', 0.29)
    a.water.params.set('reflectScale', 0.4)
    for (let i = 1; i <= 8; i++) tick(a.dyn, i)
    const snap = json(a.water.exportState())

    const b = make()
    expect(b.water.importState(snap)).toEqual({ unknown: [], rejected: [] })
    for (const k of ['seaLow', 'seaHigh', 'deepShare', 'foamShare', 'sparkleThreshold', 'reflectScale']) {
      expect(b.water.params.get(k), k).toBe(a.water.params.get(k))
    }
    expect(b.water.getSeaLevel()).toBe(a.water.getSeaLevel())
    expect(b.water.mesh.position.y).toBe(a.water.mesh.position.y)
    const au = a.water._material.uniforms, bu = b.water._material.uniforms
    for (const n of ['uTime', 'uFoamWidth', 'uSparkleThreshold', 'uDepthMax']) expect(bu[n].value, n).toBe(au[n].value)
    expect(json(b.water.exportState())).toEqual(snap)
  })

  it('a restored depth base survives the next tick: the uniform follows it, not the default', () => {
    const a = make()
    a.water.params.set('deepShare', 1.5)
    const b = make()
    b.water.importState(json(a.water.exportState()))
    tick(b.dyn, 1)
    tick(a.dyn, 1)
    expect(b.water._material.uniforms.uDepthMax.value).toBe(a.water._material.uniforms.uDepthMax.value)
  })

  it('reports a key that is no row', () => {
    const { water } = make()
    const snap = json(water.exportState())
    snap.params.nope = 1
    expect(water.importState(snap).unknown).toEqual(['nope'])
  })
})

describe('godrays snapshot', () => {
  const make = () => {
    const scene = createSceneUniforms()
    const clouds = new VolumeClouds(scene)   // owns uUsableRadius, which godrays reads
    const godrays = new Godrays(scene)
    godrays.setSize(200, 100)
    return { scene, clouds, godrays }
  }

  it('exports { format, params } and every row, the user switch among them', () => {
    const { godrays } = make()
    godrays.params.set('enabled', false)
    const s = json(godrays.exportState())
    expect(Object.keys(s).sort()).toEqual(['format', 'params'])
    expect(s.format).toBe(2)
    expect(s.params.enabled).toBe(false)
    expect(Object.keys(s.params)).toEqual(godrays.params.keys())
  })

  it('round-trips every row, and re-derives the gate from the restored switch and onset', () => {
    const a = make()
    for (const r of GODRAY_PARAMS) {
      if (r.kind === 'slider') a.godrays.params.set(r.key, r.min + 0.4 * (r.max - r.min))
    }
    a.godrays.params.set('gateOnset', 0.5)
    a.godrays.setOvercast(0.8)
    const snap = json(a.godrays.exportState())
    const b = make()
    b.godrays.setOvercast(0.8)
    expect(b.godrays.importState(snap)).toEqual({ unknown: [], rejected: [] })
    expect(json(b.godrays.exportState())).toEqual(snap)
    expect(b.godrays._compositeMaterial.uniforms.uRayWeather.value).toBe(a.godrays._compositeMaterial.uniforms.uRayWeather.value)
    expect(a.godrays._compositeMaterial.uniforms.uRayWeather.value).toBeGreaterThan(0)   // the gate is open, so this is not vacuous
  })

  it('reports a key that is no row', () => {
    const { godrays } = make()
    const snap = json(godrays.exportState())
    snap.params.nope = 1
    expect(godrays.importState(snap).unknown).toEqual(['nope'])
  })
})

describe('clouds snapshot', () => {
  const make = () => {
    const scene = createSceneUniforms()
    const clouds = new VolumeClouds(scene)
    clouds.setSize(200, 100)
    return clouds
  }
  const vec = v => [v.x, v.y]

  it('round-trips the rows and the scrolling state, and re-derives the grid from them', () => {
    const a = make()
    a.params.set('drawDistance', 2500)
    a.params.set('baseFreq', 0.0123)
    a.params.set('coverage', 0.77)
    a.snapEases()
    const au = a._bakeMaterial.uniforms, mu = a._marchMaterial.uniforms
    au.uFreqPhase.value.set(0.25, 0.5)
    au.uWorleyPhase.value.set(0.75, 0.125)
    au.uFreqAnchor.value.set(40, -80)
    mu.uWindOffset.value.set(11, 22)
    mu.uWeatherOffset.value.set(0.3, 0.6)
    a._shared.uOriginCell.value.set(3, -4)
    const snap = json(a.exportState())

    const b = make()
    expect(b.importState(snap)).toEqual({ unknown: [], rejected: [] })
    expect(json(b.exportState())).toEqual(snap)
    const bu = b._bakeMaterial.uniforms, bm = b._marchMaterial.uniforms
    expect(vec(bu.uFreqPhase.value)).toEqual([0.25, 0.5])
    expect(vec(bu.uWorleyPhase.value)).toEqual([0.75, 0.125])
    expect(vec(bm.uWindOffset.value)).toEqual([11, 22])
    expect(b._origin).toEqual({ x: 3, z: -4 })           // the JS copy follows the uniform
    // Derived, not captured: equal to what the source's rows give.
    for (const n of ['uCellSize', 'uOctaves', 'uAmpNorm']) {
      expect(bu[n] ? bu[n].value : b._shared[n].value, n).toBeCloseTo(au[n] ? au[n].value : a._shared[n].value, 12)
    }
    expect(bm.uDetailFreq.value).toBeCloseTo(mu.uDetailFreq.value, 12)
    expect(b._shapeDirty).toBe(true)
  })

  it('the restored wind offsets survive the next frame: the clock comes back with them', () => {
    const cam = new THREE.PerspectiveCamera()
    const offsets = v => ['uWindOffset', 'uMidWindOffset', 'uFineWindOffset', 'uWeatherOffset']
      .map(n => vec(v._marchMaterial.uniforms[n].value))
    for (const cloudSpeed of [6, 0]) {
      const a = make()
      a.params.set('cloudSpeed', cloudSpeed)
      a.params.set('weatherSpeed', 0.5)
      a.update(cam, 0)
      a.update(cam, 163.25)
      const snap = json(a.exportState())

      const b = make()
      b.importState(snap)
      b.update(cam, 0)
      const got = offsets(b), want = offsets(a)
      for (let i = 0; i < want.length; i++) {
        expect(got[i][0], `speed ${cloudSpeed}, offset ${i}`).toBeCloseTo(want[i][0], 9)
        expect(got[i][1], `speed ${cloudSpeed}, offset ${i}`).toBeCloseTo(want[i][1], 9)
      }
    }
  })

  it('reports a key that is no row and an integrated name that is no uniform', () => {
    const a = make()
    const snap = json(a.exportState())
    snap.params.nope = 1
    snap.integrated.uGone = 1
    expect(a.importState(snap).unknown.sort()).toEqual(['nope', 'uGone'])
  })
})

describe('art pass snapshot', () => {
  const make = () => {
    const scene = createSceneUniforms()
    const art = new ArtPass(new ArtGBuffer(new Terrain(new EventTarget(), scene), new Water(new EventTarget(), scene)),
      new THREE.PerspectiveCamera(), { sceneUniforms: scene })
    return art
  }
  const uni = (art, n) => art.uniformValue(n)

  it('round-trips every row (the colours, radio choices, toggles and held ones among them) and the switch', () => {
    const a = make()
    for (const r of ART_ROWS) {
      if (r.kind === 'slider') a.params.set(r.key, r.min + 0.3 * (r.max - r.min))
      else if (r.kind === 'toggle') a.params.set(r.key, !r.value)
    }
    a.params.set('colSky', '#123456')
    a.params.set('groundMode', 3)
    a.params.set('debugView', 2)
    a.enabled = false
    const snap = json(a.exportState())
    const b = make()
    expect(b.importState(snap)).toEqual({ unknown: [], rejected: [] })
    expect(json(b.exportState())).toEqual(snap)
    expect(b.enabled).toBe(false)
    for (const n of ['uHeightScale', 'uGroundSigma', 'uRespectEdges', 'uDebugView', 'uOrientMode', 'uDebug']) {
      expect(uni(b, n), n).toBeCloseTo(uni(a, n), 12)
    }
  })

  it('reports a key that is no row', () => {
    const art = make()
    const snap = json(art.exportState())
    snap.params.nope = 1
    expect(art.importState(snap).unknown).toEqual(['nope'])
  })
})

describe('a state of another format', () => {
  const scene = () => createSceneUniforms()
  const owners = {
    terrain: () => new Terrain(new EventTarget(), scene()),
    water: () => new Water(new EventTarget(), scene()),
    clouds: () => new VolumeClouds(scene()),
    godrays: () => new Godrays(scene()),
    artPass: () => {
      const sc = scene()
      return new ArtPass(new ArtGBuffer(new Terrain(new EventTarget(), sc), new Water(new EventTarget(), sc)),
        new THREE.PerspectiveCamera(), { sceneUniforms: sc })
    },
  }

  for (const [name, make] of Object.entries(owners)) {
    it(`${name} names the format as unknown and changes nothing`, () => {
      const owner = make()
      const before = json(owner.exportState())
      for (const stale of [{ uniforms: { uTime: 3 } }, { format: 1, params: { nope: 1 } }]) {
        const report = owner.importState(stale)
        expect(report.unknown).toEqual([`${name}.format ${stale.format}`])
        expect(report.rejected).toEqual([])
      }
      expect(json(owner.exportState())).toEqual(before)
    })
  }
})
