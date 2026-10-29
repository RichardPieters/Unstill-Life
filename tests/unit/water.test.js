import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { Water } from '../../src/water/water.js'
import { Terrain } from '../../src/terrain/terrain.js'
import { createSceneUniforms } from '../../src/shared/sceneUniforms.js'
import { WATER_PARAMS } from '../../src/water/waterParams.js'
import { removedNameHits } from './sourceScan.js'

// Water builds a THREE.ShaderMaterial, which needs no GL context; the GPU
// passes run against a renderer stub whose methods do nothing.
const RENDERER = { getRenderTarget: () => null, setRenderTarget() {}, render() {} }
const LIT_FRAME = { ground: {}, level: 80, height: 70, extent: 4096, windX: 0, windZ: 0, sunX: 0.788, sunY: 0.615, sunZ: 0 }

const makeWater = (scene = createSceneUniforms()) => new Water(new EventTarget(), scene)

function viewCamera() {
  const cam = new THREE.PerspectiveCamera(50, 4 / 3, 0.5, 3000)
  cam.position.set(40, 60, 300)
  cam.lookAt(0, -10, 0)
  cam.updateMatrixWorld(true)
  return cam
}

describe('Water and terrain share the scene-wide uniforms', () => {
  it('every name both read is one object, so the shoreline cannot seam', () => {
    const scene = createSceneUniforms()
    const w = makeWater(scene)._material.uniforms
    const t = new Terrain(new EventTarget(), scene)._material.uniforms
    const both = ['uFogColor', 'uFogNear', 'uFogFar', 'uFogCurve', 'uFogMaxAlpha', 'uLightLevel',
      'uCloudGround', 'uCloudShadowAmt', 'uCloudShadowAbs', 'uCloudShadowFloor', 'uCloudShadowTiers',
      'uCloudLevel', 'uCloudExtent', 'uCloudWind']
    for (const name of both) expect(w[name], name).toBe(t[name])
    scene.params.set('fogCurve', 0.31)
    scene.setCloudShadowFrame(LIT_FRAME)
    expect(w.uFogCurve.value).toBe(0.31)
    expect(w.uCloudShadowAmt.value).toBeGreaterThan(0)
  })
})

describe('Water pre-passes', () => {
  it('leave a hidden plane hidden and a shown plane shown', () => {
    const w = makeWater()
    w.setSize(64, 48)
    const cam = viewCamera()
    w.params.set('enabled', false)
    w.depthPrePass(RENDERER, {}, cam)
    w.reflectionPrePass(RENDERER, {}, cam)
    expect(w.mesh.visible).toBe(false)
    w.params.set('enabled', true)
    w.depthPrePass(RENDERER, {}, cam)
    w.reflectionPrePass(RENDERER, {}, cam)
    expect(w.mesh.visible).toBe(true)
  })

  it('the mirror camera sees what lies above the water and clips what lies below', () => {
    const w = makeWater()
    w.setSize(64, 48)
    w.reflectionPrePass(RENDERER, {}, viewCamera())
    const mirror = w._reflectCamera
    const sea = w.getSeaLevel()

    // Mirrored across the sea level: same x/z, height reflected.
    const cam = viewCamera()
    expect(mirror.position.x).toBeCloseTo(cam.position.x, 9)
    expect(mirror.position.z).toBeCloseTo(cam.position.z, 9)
    expect(mirror.position.y).toBeCloseTo(2 * sea - cam.position.y, 9)

    // Walk the mirror camera's view axis: it starts below the water and
    // looks up through it. NDC z in [-1, 1] means inside the frustum.
    const dir = new THREE.Vector3()
    mirror.getWorldDirection(dir)
    const crossing = (sea - mirror.position.y) / dir.y          // ray length to the plane
    const ndcZ = t => mirror.position.clone().addScaledVector(dir, t).project(mirror).z
    expect(ndcZ(crossing * 0.5)).toBeLessThan(-1)                // under water: clipped
    expect(ndcZ(crossing * 0.95)).toBeLessThan(-1)
    const above = ndcZ(crossing * 1.5)
    expect(above).toBeGreaterThanOrEqual(-1)                     // above water: drawn
    expect(above).toBeLessThanOrEqual(1)
  })
})

const tickAt = (dyn, restlessness) =>
  dyn.dispatchEvent(new CustomEvent('tick', { detail: { dt: 0.1, momentum: 0.5, restlessness } }))

describe('water.params', () => {
  it('holds every row at its default after construction', () => {
    const w = makeWater()
    for (const r of WATER_PARAMS) {
      const v = w.params.get(r.key)
      expect(v, r.id).toEqual(r.value)
    }
  })

  it('writes a colour row from a string or an int, and reads it back as #rrggbb', () => {
    const w = makeWater()
    w.params.set('waterDeep', '#112233')
    expect(w.params.get('waterDeep')).toBe('#112233')
    w.params.set('waterShallow', 0x445566)
    expect(w.params.get('waterShallow')).toBe('#445566')
    expect(w._material.uniforms.uWaterShallow.value.getHex()).toBe(0x445566)
  })

  describe('sea band', () => {
    it('a write snaps the level to its target at once; withSeaSnap(false) leaves the easing alone', () => {
      const dyn = new EventTarget()
      const w = new Water(dyn, createSceneUniforms())
      tickAt(dyn, 1)
      w.params.set('seaLow', w.params.get('seaLow') - 25)
      expect(w.mesh.position.y).toBeCloseTo(w.params.get('seaLow'), 9)
      const before = w.mesh.position.y
      w.withSeaSnap(false, () => w.params.set('seaLow', before - 10))
      expect(w.mesh.position.y).toBe(before)
      // The scope restores the default.
      w.params.set('seaLow', before - 20)
      expect(w.mesh.position.y).toBeCloseTo(before - 20, 9)
    })

    it('the bounds cannot cross: the other end moves along', () => {
      const w = makeWater()
      w.params.set('seaHigh', -500)
      expect(w.params.get('seaLow')).toBeLessThanOrEqual(w.params.get('seaHigh'))
      expect(w.params.get('seaHigh')).toBe(-500)
      w.params.set('seaLow', 500)
      expect(w.params.get('seaHigh')).toBeGreaterThanOrEqual(w.params.get('seaLow'))
      expect(w.params.get('seaLow')).toBe(500)
    })

    it('a jump of the whole band past its old high lands both ends exactly', () => {
      const w = makeWater()
      const hi = w.params.get('seaHigh')
      w.params.set('seaLow', hi + 30)
      w.params.set('seaHigh', hi + 50)
      expect(w.params.get('seaLow')).toBe(hi + 30)
      expect(w.params.get('seaHigh')).toBe(hi + 50)
    })

    it('tells onChange listeners when the other end was moved', () => {
      const w = makeWater()
      const seen = []
      w.params.onChange('seaLow', v => seen.push(v))
      w.params.set('seaHigh', w.params.get('seaLow') - 10)
      expect(seen).toEqual([w.params.get('seaHigh')])
    })
  })

  it('the base-tracked rows set the driver base, which the tick turns into the uniform', () => {
    const dyn = new EventTarget()
    const w = new Water(dyn, createSceneUniforms())
    const u = w._material.uniforms
    w.setTerrainScale(249.5)
    w.params.set('deepShare', 0.45)
    tickAt(dyn, 1)
    const atFirst = u.uDepthMax.value
    w.params.set('deepShare', 0.9)
    tickAt(dyn, 1)
    expect(u.uDepthMax.value / atFirst).toBeCloseTo(2, 6)
    expect(w.params.get('deepShare')).toBe(0.9)
    expect(w._driver.settings.foamShare).toBe(w.params.get('foamShare'))
    w.params.set('foamShare', 0.4)
    expect(w._driver.settings.foamShare).toBe(0.4)
    w.params.set('sparkleThreshold', 0.3)
    expect(w._driver.settings.sparkleThreshold).toBe(0.3)
  })

  it('the mirror resolution clamps to [0.05, 1] and resizes the target', () => {
    const w = makeWater()
    w.setSize(200, 100)
    w.params.set('reflectScale', 0.25)
    expect(w._reflectRT.width).toBe(50)
    w.params.set('reflectScale', 0)
    expect(w.params.get('reflectScale')).toBe(0.05)
    w.params.set('reflectScale', 7)
    expect(w.params.get('reflectScale')).toBe(1)
    expect(w._reflectRT.width).toBe(200)
  })

  it('the art-data switch also flips depthWrite, and back', () => {
    const w = makeWater()
    expect(w._material.depthWrite).toBe(false)
    w.params.set('artData', true)
    expect(w._material.uniforms.uArtData.value).toBe(1)
    expect(w._material.depthWrite).toBe(true)
    w.params.set('artData', false)
    expect(w._material.uniforms.uArtData.value).toBe(0)
    expect(w._material.depthWrite).toBe(false)
  })

  it('a restored mirror scale goes through the clamp', () => {
    const w = makeWater()
    w.setSize(200, 100)
    w.importState({ format: 2, params: { reflectScale: 0.3 } })
    expect(w.params.get('reflectScale')).toBe(0.3)
  })
})

describe('Water removed methods', () => {
  // Defined on no other module: any mention is a stale caller or comment.
  const ONLY_WATER = [
    'setWaterParam', 'getWaterParam', 'setSeaLow', 'getSeaLow', 'setSeaHigh', 'getSeaHigh',
    'setSparkleThreshold', 'getSparkleThreshold', 'setFoamWidth', 'getFoamWidth',
    'setDepthMax', 'getDepthMax', 'setReflectionScale', 'getReflectionScale',
  ]
  // Still defined on other owners (terrain's palette, godrays' colour, flyCamera, ...).
  const SHARED = ['setPalette', 'setColorHex', 'getColorHex', 'setArtData', 'setEnabled', 'getEnabled']

  it('are referenced nowhere in src/ or tests/', () => {
    expect(removedNameHits(ONLY_WATER, { receiver: 'water', names: SHARED }, import.meta.url)).toEqual([])
  })
})
