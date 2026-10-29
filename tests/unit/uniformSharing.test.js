import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { Terrain } from '../../src/terrain/terrain.js'
import { Water } from '../../src/water/water.js'
import { ArtGBuffer } from '../../src/artpass/artGBuffer.js'
import { ArtPass } from '../../src/artpass/artPass.js'
import { VolumeClouds } from '../../src/clouds/cloudsVolume.js'
import { Godrays } from '../../src/clouds/godrays.js'
import { createSceneUniforms } from '../../src/shared/sceneUniforms.js'

const newTerrain = (scene = createSceneUniforms()) => new Terrain(new EventTarget(), scene)
const newWater = (scene = createSceneUniforms()) => new Water(new EventTarget(), scene)
function newArtPass() {
  const scene = createSceneUniforms()
  const gbuffer = new ArtGBuffer(newTerrain(scene), newWater(scene))
  return new ArtPass(gbuffer, new THREE.PerspectiveCamera(), { sceneUniforms: scene })
}

/**
 * Invariant: inside one owner, one uniform NAME is one { value } object, in
 * every material that declares it. Snapshot restore and the param accessors
 * write the first table that has a name; a second, separate copy under the
 * same name would silently keep its old value in the other program.
 *
 * Owner tables are the materials held directly on the owner (or in an array
 * on it). Every module here builds its materials without a GL context.
 *
 * PASS_INPUTS lists the names that are deliberately separate per program:
 * per-pass inputs the render step writes into one material right before that
 * material's own draw (a different texture, step or resolution per pass), so
 * they are not one value at all.
 */
const PASS_INPUTS = {
  artPass: {
    uRes:   'full-frame, prepass and pick-grid resolutions differ per pass',
    uPrev:  'the ground blur and growth relax ping-pong their own targets',
    uSeed:  'the jump flood ping-pongs; the tangent fit reads its last target',
    uStep:  'the jump flood and the growth relax each run their own step sequence',
  },
  clouds: {
    uLayer: 'the shape bake and the light bake each walk their own layer cursor',
  },
}

function ownerTables(owner) {
  const tables = new Map()   // uniforms table → material key
  const add = (key, m) => {
    if (m && m.isMaterial && m.uniforms && !tables.has(m.uniforms)) tables.set(m.uniforms, key)
  }
  for (const [key, v] of Object.entries(owner)) {
    if (Array.isArray(v)) v.forEach((m, i) => add(`${key}[${i}]`, m))
    else add(key, v)
  }
  return [...tables].map(([uniforms, key]) => ({ key, uniforms }))
}

/** `name: [table keys]` for every name held as different objects in two tables. */
function splitNames(owner, allowed = {}) {
  const byName = new Map()
  for (const { key, uniforms } of ownerTables(owner)) {
    for (const name of Object.keys(uniforms)) {
      if (!byName.has(name)) byName.set(name, [])
      byName.get(name).push({ key, obj: uniforms[name] })
    }
  }
  const out = {}
  for (const [name, holders] of byName) {
    if (name in allowed) continue
    if (new Set(holders.map(h => h.obj)).size > 1) out[name] = holders.map(h => h.key)
  }
  return out
}

describe('one uniform object per name per owner', () => {
  it('art pass', () => {
    const art = newArtPass()
    expect(ownerTables(art).length).toBeGreaterThan(8)
    expect(splitNames(art, PASS_INPUTS.artPass)).toEqual({})
  })

  it('terrain', () => {
    const t = newTerrain()
    expect(ownerTables(t).length).toBe(3)   // material (depth, forest-site reuse it), heightmap, derive
    expect(splitNames(t)).toEqual({})
  })

  it('terrain: the fixture height field reaches the derive pass through the one uDataMap', () => {
    const t = newTerrain()
    t.setFixtureHeightfield(() => 0)
    const fixture = t._material.uniforms.uDataMap.value
    expect(t._deriveMaterial.uniforms.uDataMap.value).toBe(fixture)
    t.setFixtureHeightfield(null)
    expect(t._deriveMaterial.uniforms.uDataMap.value).toBe(t._dataMapRT.texture)
  })

  it('cloud volume', () => {
    const v = new VolumeClouds(createSceneUniforms())
    expect(ownerTables(v).length).toBe(4)
    expect(splitNames(v, PASS_INPUTS.clouds)).toEqual({})
  })

  it('cloud volume: the one key accessor reaches bake, light, march and the JS-only table', () => {
    const v = new VolumeClouds(createSceneUniforms())
    v.params.set('lightSteps', 11)
    v.params.set('cloudSpeed', 2.5)
    v.params.set('colorSteps', 6)
    v.params.set('lacunarity', 2.5)
    expect(v._lightMaterial.uniforms.uLightSteps.value).toBe(11)
    expect(v._jsUniforms.uCloudSpeed.value).toBe(2.5)
    expect(v._marchMaterial.uniforms.uCloudColorSteps.value).toBe(6)
    expect(v._bakeMaterial.uniforms.uLacunarity.value).toBe(2.5)
    expect(v._marchMaterial.uniforms.uLacunarity.value).toBe(2.5)
  })

  it('water and godrays', () => {
    expect(splitNames(newWater())).toEqual({})
    expect(splitNames(new Godrays(createSceneUniforms()))).toEqual({})
  })

  it('godrays reads the ground shadow\'s frame and ladder as the same objects, under its own names', () => {
    const scene = createSceneUniforms()
    const t = newTerrain(scene)._material.uniforms
    const g = new Godrays(scene)._marchMaterial.uniforms
    const w = newWater(scene)._material.uniforms
    expect(g.uShadowTiers).toBe(t.uCloudShadowTiers)
    expect(g.uSunDir).toBe(w.uCloudSunDir)
    for (const name of ['uCloudGround', 'uCloudLevel', 'uCloudHeight', 'uCloudExtent', 'uCloudWind']) {
      expect(g[name], name).toBe(t[name])
    }
  })

  it('art pass: a snapshot restore reaches every program that reads a shared name', () => {
    const art = newArtPass()
    art.importState({ format: 2, params: { weave: 0.37, edgeTau: 0.21 } })
    // Every table that declares the name, not the first one found.
    const all = name => art.uniformTables().filter(t => name in t).map(t => t[name].value)
    expect(all('uWeave').length).toBeGreaterThan(1)
    expect(all('uWeave').every(v => v === 0.37)).toBe(true)
    expect(all('uEdgeTau').length).toBeGreaterThan(1)
    expect(all('uEdgeTau').every(v => v === 0.21)).toBe(true)
  })

  it('the check itself catches a by-value copy', () => {
    const owner = {
      a: new THREE.ShaderMaterial({ uniforms: { uX: { value: 1 } } }),
      b: new THREE.ShaderMaterial({ uniforms: { uX: { value: 1 } } }),
    }
    expect(splitNames(owner)).toEqual({ uX: ['a', 'b'] })
  })
})
