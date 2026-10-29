import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { Godrays } from '../../src/clouds/godrays.js'
import { VolumeClouds } from '../../src/clouds/cloudsVolume.js'
import { createSceneUniforms } from '../../src/shared/sceneUniforms.js'
import { GODRAY_PARAMS } from '../../src/clouds/godrayParams.js'
import { removedNameHits } from './sourceScan.js'

// The march draws through a renderer stub; materials and targets need no GL.
const RENDERER = { getRenderTarget: () => null, setRenderTarget() {}, render() {} }
const LIT_FRAME = { ground: {}, level: 80, height: 140, extent: 4096, windX: 0, windZ: 0, sunX: 0.6, sunY: 0.8, sunZ: 0 }

function heldGodrays() {
  const scene = createSceneUniforms()
  const clouds = new VolumeClouds(scene)   // writes the usable radius
  const g = new Godrays(scene)
  g.setSize(64, 36)
  g.setOvercast(1)                       // open the weather gate
  scene.setCloudShadowFrame(LIT_FRAME)   // a light volume to march
  g.setSceneStatic(true)                 // the world holds still
  return { scene, clouds, g, camera: new THREE.PerspectiveCamera() }
}

describe('Godrays usable radius', () => {
  it('is the cloud volume\'s own, and follows the draw distance', () => {
    const scene = createSceneUniforms()
    const clouds = new VolumeClouds(scene)
    const g = new Godrays(scene)
    const radius = () => g._marchMaterial.uniforms.uUsableRadius.value
    expect(radius()).toBe(clouds.getUsableRadius())
    const wide = radius()
    clouds.params.set('drawDistance', 1500)
    expect(radius()).toBe(clouds.getUsableRadius())
    expect(radius()).toBeLessThan(wide)   // a shorter draw distance fades the beams sooner
  })
})

describe('Godrays under a held scene', () => {
  it('re-marches when the ground shadow ladder moves, and only then', () => {
    const { scene, g, camera } = heldGodrays()
    g.render(RENDERER, camera)
    const first = g.marchCount
    g.render(RENDERER, camera)
    expect(g.marchCount).toBe(first)        // held: nothing changed
    scene.params.set('cloudShadowTiers', 6)        // the panel moves the ground ladder
    g.render(RENDERER, camera)
    expect(g.marchCount).toBe(first + 1)
    g.render(RENDERER, camera)
    expect(g.marchCount).toBe(first + 1)
  })

  it('re-marches when the draw distance moves the usable radius', () => {
    const { clouds, g, camera } = heldGodrays()
    g.render(RENDERER, camera)
    const first = g.marchCount
    clouds.params.set('drawDistance', 1500)
    g.render(RENDERER, camera)
    expect(g.marchCount).toBe(first + 1)
  })

  it('fails loudly on a scene set no cloud volume wrote, rather than fading every beam', () => {
    const scene = createSceneUniforms()
    const g = new Godrays(scene)
    g.setSize(64, 36)
    g.setOvercast(1)
    scene.setCloudShadowFrame(LIT_FRAME)
    expect(() => g.render(RENDERER, new THREE.PerspectiveCamera())).toThrow(/uUsableRadius/)
  })
})

describe('godrays.params', () => {
  const makeGodrays = () => new Godrays(createSceneUniforms())

  it('holds every row at its default after construction', () => {
    const g = makeGodrays()
    for (const r of GODRAY_PARAMS) expect(g.params.get(r.key), r.id).toEqual(r.value)
  })

  it('a march row marks the march dirty, and only a change does', () => {
    const { g, camera, scene } = heldGodrays()
    g.render(RENDERER, camera)
    const first = g.marchCount
    g.render(RENDERER, camera)
    expect(g.marchCount).toBe(first)
    g.params.set('density', g.params.get('density') * 2)
    g.render(RENDERER, camera)
    expect(g.marchCount).toBe(first + 1)
    g.params.set('density', g.params.get('density'))      // no change: nothing to redo
    g.render(RENDERER, camera)
    expect(g.marchCount).toBe(first + 1)
    expect(scene).toBeDefined()
  })

  it('a composite row, which the per-frame pass reads, does not force a march', () => {
    const { g, camera } = heldGodrays()
    g.render(RENDERER, camera)
    const first = g.marchCount
    g.params.set('intensity', 2)
    g.params.set('tiers', 5)
    g.params.set('soften', 0.5)
    g.params.set('rayColor', '#112233')
    g.render(RENDERER, camera)
    expect(g.marchCount).toBe(first)
    expect(g._compositeMaterial.uniforms.uRayIntensity.value).toBe(2)
    expect(g._compositeMaterial.uniforms.uRayColor.value.getHexString()).toBe('112233')
  })

  it('the density dial\'s intensity scale does force a march, and never goes negative', () => {
    const { g, camera } = heldGodrays()
    g.render(RENDERER, camera)
    const first = g.marchCount
    g.params.set('intensityScale', 0.4)
    g.render(RENDERER, camera)
    expect(g.marchCount).toBe(first + 1)
    g.params.set('intensityScale', -3)
    expect(g.params.get('intensityScale')).toBe(0)
  })

  it('the sample and tier counts are whole numbers; the sample count stays within the shader loop', () => {
    const g = makeGodrays()
    g.params.set('steps', 17.6)
    expect(g.params.get('steps')).toBe(18)
    g.params.set('steps', 500)
    expect(g.params.get('steps')).toBe(96)
    g.params.set('steps', -4)
    expect(g.params.get('steps')).toBe(1)
    g.params.set('tiers', 4.4)
    expect(g.params.get('tiers')).toBe(4)
  })

  describe('weather gate', () => {
    it('the onset moves the gate; the switch and the gate both have to be on for the pass', () => {
      const g = makeGodrays()
      g.setOvercast(0.95)
      g.params.set('gateOnset', 0.5)
      const wide = g.getWeatherGate()
      g.params.set('gateOnset', 0.94)
      expect(g.getWeatherGate()).toBeLessThan(wide)
      expect(g.pass.enabled).toBe(true)
      g.params.set('enabled', false)
      expect(g.pass.enabled).toBe(false)
      g.params.set('enabled', true)
      g.setOvercast(0)
      expect(g.pass.enabled).toBe(false)
    })

    it('the onset clamps to the slider range', () => {
      const g = makeGodrays()
      g.params.set('gateOnset', 5)
      expect(g.params.get('gateOnset')).toBe(0.99)
      g.params.set('gateOnset', -1)
      expect(g.params.get('gateOnset')).toBe(0)
    })
  })

  it('the march-target scale clamps and resizes the target', () => {
    const g = makeGodrays()
    g.setSize(200, 100)
    g.params.set('renderScale', 0.5)
    expect(g._rayRT.width).toBe(100)
    g.params.set('renderScale', 0)
    expect(g.params.get('renderScale')).toBe(0.1)
    g.params.set('renderScale', 9)
    expect(g.params.get('renderScale')).toBe(1)
    expect(g._rayRT.width).toBe(200)
  })

  it('a restore goes through the rows: switch, onset and target scale', () => {
    const g = makeGodrays()
    g.setSize(200, 100)
    const state = g.exportState()
    g.params.set('enabled', false)
    g.params.set('gateOnset', 0.3)
    g.params.set('renderScale', 0.3)
    g.importState(state)
    expect(g.params.get('enabled')).toBe(true)
    expect(g.params.get('gateOnset')).toBe(state.params.gateOnset)
    expect(g.params.get('renderScale')).toBe(state.params.renderScale)
  })
})

describe('Godrays removed methods', () => {
  // Defined on no other module: any mention is a stale caller or comment.
  const ONLY_GODRAYS = [
    'setSteps', 'getSteps', 'setMaxDist', 'getMaxDist', 'setAbsorption', 'getAbsorption',
    'setDensity', 'getDensity', 'setAniso', 'getAniso', 'setJitter', 'getJitter',
    'setHardness', 'getHardness', 'setThreshold', 'getThreshold', 'setDeckFade', 'getDeckFade',
    'setDrop', 'getDrop', 'setCutSnap', 'getCutSnap', 'setNearFade', 'getNearFade',
    'setIntensity', 'getIntensity', 'setTiers', 'getTiers', 'setSoften', 'getSoften',
    'setGateOnset', 'getGateOnset', 'setIntensityScale', 'getIntensityScale',
  ]
  // Still defined on other owners (the cloud volume's render scale, atmosphere's switch, ...).
  const SHARED = ['setEnabled', 'getEnabled', 'setRenderScale', 'getRenderScale', 'setColorHex', 'getColorHex']

  it('are referenced nowhere in src/ or tests/', () => {
    expect(removedNameHits(ONLY_GODRAYS, { receiver: 'godrays', names: SHARED }, import.meta.url)).toEqual([])
  })
})
