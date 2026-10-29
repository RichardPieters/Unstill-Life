import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { Terrain } from '../../src/terrain/terrain.js'
import { Water } from '../../src/water/water.js'
import { Godrays } from '../../src/clouds/godrays.js'
import { ArtGBuffer } from '../../src/artpass/artGBuffer.js'
import { ArtPass } from '../../src/artpass/artPass.js'
import { VolumeClouds } from '../../src/clouds/cloudsVolume.js'
import { createSceneUniforms, SCENE_UNIFORM_NAMES } from '../../src/shared/sceneUniforms.js'

/**
 * Restoring a snapshot into consumers that share the scene-wide uniforms.
 *
 * The snapshot is captured from a source scene whose shared values were moved
 * off their defaults, then restored into a fresh one. It must restore with
 * nothing unknown or rejected. Shared values appear only in terrain's capture
 * (it hands them to the scene set): the result must not depend on the order
 * modules are restored in, and the derived shadow amount must come from the
 * restored master, never from a captured copy.
 */
const LIT_FRAME = { ground: {}, level: 80, height: 140, extent: 4096, windX: 0, windZ: 0, sunX: 0.6, sunY: 0.8, sunZ: 0 }

const SHARED = { fogNear: 123, fogFar: 999, fogCurve: 0.31, fogMaxAlpha: 0.77, lightLevel: 0.66,
  cloudShadowAbs: 0.21, cloudShadowTiers: 6, cloudShadowAmt: 0.35 }

function build() {
  const scene = createSceneUniforms()
  const terrain = new Terrain(new EventTarget(), scene)
  const water = new Water(new EventTarget(), scene)
  const mods = {
    terrain, water,
    clouds: new VolumeClouds(scene),
    artPass: new ArtPass(new ArtGBuffer(terrain, water), new THREE.PerspectiveCamera(), { sceneUniforms: scene }),
    godrays: new Godrays(scene),
  }
  scene.setCloudShadowFrame(LIT_FRAME)   // a light volume exists, as in the running piece
  return { scene, mods }
}

/** A snapshot of a scene whose shared values were moved, as `{ owner: state }`. */
function capture() {
  const { scene, mods } = build()
  for (const [k, v] of Object.entries(SHARED)) scene.params.set(k, v)
  scene.params.set('fogColor', 0x336699)
  return Object.fromEntries(Object.entries(mods).map(([k, m]) => [k, JSON.parse(JSON.stringify(m.exportState()))]))
}
const OLD = capture()

/** Every uniform table of every owner, keyed `owner.material`. */
function tablesOf(mods) {
  const out = {}
  for (const [owner, mod] of Object.entries(mods)) {
    for (const [k, m] of Object.entries(mod)) if (m && m.isMaterial) out[`${owner}.${k}`] = m.uniforms
  }
  return out
}

function restore(order, snap = OLD) {
  const { scene, mods } = build()
  const unknown = [], rejected = []
  for (const key of order) {
    const r = mods[key].importState(snap[key]) || {}
    unknown.push(...(r.unknown || []))
    rejected.push(...(r.rejected || []))
  }
  const read = ['fogColor', 'fogNear', 'fogFar', 'fogCurve', 'fogMaxAlpha', 'lightLevel',
    'cloudShadowAbs', 'cloudShadowFloor', 'cloudShadowTiers', 'cloudShadowAmt']
  const values = Object.fromEntries(read.map(k => {
    const v = scene.params.get(k)
    return [k, typeof v === 'string' ? parseInt(v.slice(1), 16) : v]
  }))
  values.amt = scene.mount(['uCloudShadowAmt']).uCloudShadowAmt.value
  return { values, unknown, rejected, scene, mods }
}

const ORDER = ['terrain', 'water', 'clouds', 'artPass', 'godrays']   // sceneModules.js's order

describe('a snapshot restored into the shared scene set', () => {
  it('restores with nothing unknown or rejected, every shared value as captured', () => {
    const { values, unknown, rejected } = restore(ORDER)
    expect(unknown).toEqual([])
    expect(rejected).toEqual([])
    for (const [k, v] of Object.entries(SHARED)) expect(values[k], k).toBe(v)
    expect(values.fogColor).toBe(0x336699)
  })

  it('derives the shadow amount from the restored master, not from a captured copy', () => {
    const { values } = restore(ORDER)
    // Scale 1 (nothing set the dial here) and a light volume present.
    expect(values.amt).toBeCloseTo(SHARED.cloudShadowAmt, 12)
  })

  it('gives the same scene whatever order the modules are restored in', () => {
    const forward = restore(ORDER).values
    const backward = restore([...ORDER].reverse()).values
    expect(backward).toEqual(forward)
  })

  it('leaves every owner holding the scene set\'s own objects after the restore', () => {
    const { scene, mods } = restore(ORDER)
    const tables = tablesOf(mods)
    const sharedObjects = new Set(Object.values(scene.mount(SCENE_UNIFORM_NAMES)))
    // Each mounted name is still the set's object: restore mutated, never replaced.
    const aliases = { uSunDir: 'uCloudSunDir', uShadowTiers: 'uCloudShadowTiers' }
    let checked = 0
    for (const [where, u] of Object.entries(tables)) {
      for (const [name, obj] of Object.entries(u)) {
        if (!sharedObjects.has(obj)) continue
        const shared = aliases[where.startsWith('godrays') ? name : ''] || name
        expect(obj, `${where}.${name}`).toBe(scene.mount([shared])[shared])
        checked++
      }
    }
    expect(checked).toBeGreaterThan(30)
    // The cloud volume mounts the usable radius and nothing else of the set
    // (its own uCloudLit/uCloudLevel/uCloudHeight are separate objects).
    const cloudMounted = Object.entries(tables).filter(([w]) => w.startsWith('clouds.'))
      .flatMap(([, u]) => Object.entries(u).filter(([, o]) => sharedObjects.has(o)).map(([n]) => n))
    expect([...new Set(cloudMounted)]).toEqual(['uUsableRadius'])
  })
})
