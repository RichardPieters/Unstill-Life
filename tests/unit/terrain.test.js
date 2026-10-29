import { describe, it, expect } from 'vitest'
import { Terrain } from '../../src/terrain/terrain.js'
import { createSceneUniforms } from '../../src/shared/sceneUniforms.js'
import { TERRAIN_PARAMS } from '../../src/terrain/terrainParams.js'
import { SPECIES } from '../../src/terrain/treeSpecies.js'
import { PALETTE } from '../../src/shared/palette.js'
import { readFileSync, readdirSync, statSync } from 'node:fs'

// Terrain builds THREE materials and render targets, which need no GL context;
// only renderDataMap() touches a renderer, and it is not called here.
const LIT_FRAME = { ground: {}, level: 80, height: 70, extent: 4096, windX: 0, windZ: 0, sunX: 0, sunY: 1, sunZ: 0 }

const makeTerrain = (dyn = new EventTarget(), scene = createSceneUniforms()) => new Terrain(dyn, scene)

function tick(dyn, detail) {
  dyn.dispatchEvent(new CustomEvent('tick', { detail: { dt: 0.1, momentum: 1, restlessness: 1, ...detail } }))
}

describe('Terrain cloud shadow', () => {
  it('reads the scene-wide shadow amount: one object, written by the scene set', () => {
    const scene = createSceneUniforms()
    const t = makeTerrain(undefined, scene)
    scene.params.set('cloudShadowAmt', 0.4)
    scene.setCloudShadowFrame(LIT_FRAME)
    expect(t._material.uniforms.uCloudShadowAmt).toBe(scene.mount(['uCloudShadowAmt']).uCloudShadowAmt)
    expect(t._material.uniforms.uCloudShadowAmt.value).toBeCloseTo(0.4, 12)
  })
})

describe('Terrain snapshot', () => {
  it('round-trips the cloud-shadow master, which the uniform only holds multiplied or zeroed', () => {
    const sa = createSceneUniforms()
    const a = makeTerrain(undefined, sa)
    sa.params.set('cloudShadowAmt', 0.35)
    sa.params.set('cloudShadowScale', 0.5)
    sa.setCloudShadowFrame({ ...LIT_FRAME, ground: null })   // uniform is 0 here
    const snap = JSON.parse(JSON.stringify(a.exportState()))
    expect(snap.scene.cloudShadowAmt).toBeCloseTo(0.35, 12)

    const sb = createSceneUniforms()
    const b = makeTerrain(undefined, sb)
    sb.setCloudShadowFrame(LIT_FRAME)
    b.importState(snap)
    expect(sb.params.get('cloudShadowAmt')).toBeCloseTo(0.35, 12)
    expect(sb.params.get('cloudShadowScale')).toBe(0.5)
    // The derived amount is recomputed from the restored master and scale, not
    // copied from the capture (where it was 0 for want of a light volume).
    expect(b._material.uniforms.uCloudShadowAmt.value).toBeCloseTo(0.35 * 0.5, 12)
  })

  it('round-trips the drift state, so a restore resumes the same heading', () => {
    const dynA = new EventTarget()
    const a = makeTerrain(dynA)
    a.params.set('baseSpeed1', 2.0)
    for (let i = 1; i <= 15; i++) tick(dynA, { noiseTime: i })
    const snap = JSON.parse(JSON.stringify(a.exportState()))

    const b = makeTerrain()
    b.importState(snap)
    expect(b.getDriftAngle(0)).toBe(a.getDriftAngle(0))
    expect(b.getDriftAngle(1)).toBe(a.getDriftAngle(1))
    expect(b.params.get('baseSpeed1')).toBe(2.0)
  })

  it('loads a snapshot that predates the cloud-shadow and driver keys', () => {
    const scene = createSceneUniforms()
    const t = makeTerrain(undefined, scene)
    const before = scene.params.get('cloudShadowAmt')
    const angle = t.getDriftAngle(0)
    t.importState({ uniforms: { uRidgeAmt: 0.5 }, segments: t.params.get('segments') })   // no format, no master, no driver
    expect(scene.params.get('cloudShadowAmt')).toBe(before)
    expect(t.getDriftAngle(0)).toBe(angle)
  })

  it('restores the scene-wide values its capture holds', () => {
    const sa = createSceneUniforms()
    const a = makeTerrain(undefined, sa)
    sa.params.set('fogCurve', 0.83)
    sa.params.set('cloudShadowTiers', 6)
    const snap = JSON.parse(JSON.stringify(a.exportState()))
    const sb = createSceneUniforms()
    makeTerrain(undefined, sb).importState(snap)
    expect(sb.params.get('fogCurve')).toBe(0.83)
    expect(sb.params.get('cloudShadowTiers')).toBe(6)
  })

  it('re-derives the sun azimuth angle and radius from restored uniforms', () => {
    const a = makeTerrain()
    a.params.set('sunAzimuth', 100)
    const snap = JSON.parse(JSON.stringify(a.exportState()))
    const b = makeTerrain()
    b.importState(snap)
    expect(b.params.get('sunAzimuth')).toBeCloseTo(100, 6)
    // A later rotation keeps the restored radius rather than snapping back.
    const r = Math.hypot(b.getSunAzimuth().x, b.getSunAzimuth().y)
    b.params.set('sunAzimuth', 200)
    expect(Math.hypot(b.getSunAzimuth().x, b.getSunAzimuth().y)).toBeCloseTo(r, 12)
  })

  it('restores the segment count through the field, rebuilding the geometry once', () => {
    const a = makeTerrain()
    a.params.set('segments', 400)
    const snap = JSON.parse(JSON.stringify(a.exportState()))
    const b = makeTerrain()
    const geo = b.mesh.geometry
    b.importState(snap)
    expect(b.params.get('segments')).toBe(400)
    expect(b.mesh.geometry).not.toBe(geo)
    const rebuilt = b.mesh.geometry
    b.importState(snap)                       // same count: no second rebuild
    expect(b.mesh.geometry).toBe(rebuilt)
  })
})

describe('Terrain params', () => {
  it('keeps the two ridge roundness keys apart: one namespace over all three data materials', () => {
    const t = makeTerrain()
    t.params.set('ridgeRound', 0.11)
    t.params.set('erosionRidgeRound', 0.77)
    expect(t._material.uniforms.uRidgeRound.value).toBe(0.11)
    expect(t._heightmapMaterial.uniforms.uErosionRidgeRound.value).toBe(0.77)
    expect(t.params.get('ridgeRound')).toBe(0.11)
    expect(t.params.get('erosionRidgeRound')).toBe(0.77)
  })

  it('writes the lighting and erosion toggles as GLSL bools, the forest as 1/0', () => {
    const t = makeTerrain()
    t.params.set('fog', 0)
    expect(t._material.uniforms.uEnableFog.value).toBe(false)
    t.params.set('fog', 1)
    expect(t.params.get('fog')).toBe(true)
    t.params.set('erosion', 0)
    expect(t._heightmapMaterial.uniforms.uErosionEnabled.value).toBe(false)
    t.params.set('forest', false)
    expect(t._material.uniforms.uForestOn.value).toBe(0)
    expect(t.params.get('forest')).toBe(false)
  })

  it('writes one value into both instances\' mantle octaves', () => {
    const t = makeTerrain()
    t.params.set('mantleOctaves', 5)
    expect(t._material.uniforms.uFBM0Octaves.value).toBe(5)
    expect(t._material.uniforms.uFBM1Octaves.value).toBe(5)
    expect(t.params.get('mantleOctaves')).toBe(5)
  })

  it("reaches the driver's settings as fields", () => {
    const t = makeTerrain()
    t.params.set('driftEnabled', false)
    t.params.set('baseSpeed1', 1.5)
    expect(t._driver.settings.driftEnabled).toBe(false)
    expect(t.params.get('baseSpeed1')).toBe(1.5)
  })

  it('writes one species element of an array uniform, colour included', () => {
    const t = makeTerrain()
    const radius = t._material.uniforms.uSpRadius.value
    const other = radius[1]
    t.params.set(`sp:${SPECIES[0].key}:radius`, 0.3)
    t.params.set(`sp:${SPECIES[0].key}:color`, '#123456')
    expect(radius[0]).toBe(0.3)
    expect(radius[1]).toBe(other)
    expect(t._material.uniforms.uSpColor.value[0].getHexString()).toBe('123456')
  })

  it('derives uSunAzimuth from the compass angle, at a fixed radius', () => {
    const t = makeTerrain()
    const az = t.getSunAzimuth()
    const r = Math.hypot(az.x, az.y)
    t.params.set('sunAzimuth', 90)
    expect(t.getSunAzimuth()).toBe(az)            // mutated in place
    expect(az.x).toBeCloseTo(0, 12)
    expect(az.y).toBeCloseTo(r, 12)
  })

  it('keeps each lo/hi pair ordered when one end is written past the other', () => {
    const t = makeTerrain()
    for (const [lo, hi] of [['gateLo', 'gateHi'], ['shadeLo', 'shadeHi'], ['heightLo', 'heightHi']]) {
      t.params.set(lo, t.params.get(hi) + 0.1)
      expect(t.params.get(lo)).toBeLessThanOrEqual(t.params.get(hi))
      t.params.set(hi, t.params.get(lo) - 0.2)
      expect(t.params.get(lo)).toBeLessThanOrEqual(t.params.get(hi))
    }
  })

  it("starts every field and held row at its row's value", () => {
    const t = makeTerrain()
    for (const r of TERRAIN_PARAMS.filter(r => !r.uniform)) expect(t.params.get(r.key), r.key).toBe(r.value)
  })

  it("has a row for every palette entry the boot palette writes, at the palette's value", () => {
    const cap = s => s[0].toUpperCase() + s.slice(1)
    const hex = n => '#' + n.toString(16).padStart(6, '0')
    const byKey = new Map(TERRAIN_PARAMS.map(r => [r.key, r]))
    for (const [b, v] of Object.entries(PALETTE.terrain)) expect(byKey.get(`col${cap(b)}`)?.value, b).toBe(hex(v).toLowerCase())
    for (const [b, v] of Object.entries(PALETTE.glow)) expect(byKey.get(`glow${cap(b)}`)?.value, b).toBe(v)
    for (const [b, v] of Object.entries(PALETTE.shade)) expect(byKey.get(`shade${cap(b)}`)?.value, b).toBe(v)
    expect(byKey.get('shadowHue').value).toBe(hex(PALETTE.light.shadowHue))
    expect(byKey.get('glowHue').value).toBe(hex(PALETTE.light.glowHue))
  })
})

// The per-value methods terrain.params replaced. A caller left on one would
// throw at runtime (a browser spec, a panel tab nobody opened), so the names
// are checked as text over src/ and tests/.
describe('Terrain removed methods', () => {
  // Defined on no other module: any mention is a stale caller or comment.
  const ONLY_TERRAIN = [
    'setFBMParam', 'getFBMParam', 'setTimeSpeed', 'setOctaves', 'setTimeAxisEnabled', 'getTimeAxisEnabled',
    'setNoiseEnabled', 'getNoiseEnabled', 'setFrozen', 'getFrozen', 'setBaseSpeed', 'getBaseSpeed',
    'setDriftEnabled', 'getDriftEnabled',
    'setBedrockOctaves', 'getBedrockOctaves',
    'setMantleRelief', 'getMantleRelief', 'setFieldSolo', 'getFieldSolo', 'setErosionEnabled',
    'getErosionEnabled', 'setErosionParam', 'getErosionParam', 'setMaterialParam', 'getMaterialParam',
    'setLightingEnabled', 'getLightingEnabled', 'setBandNoise', 'setHeightSpread', 'setSunAzimuthAngle',
    'getSunAzimuthAngle', 'setForestEnabled', 'getForestEnabled', 'setSpeciesParam', 'getSpeciesParam',
    'setSpeciesColorHex', 'getSpeciesColorHex', 'getSegments', 'setProbeRaw', 'terrainForest',
  ]
  // Still defined on other owners (water, godrays, clouds, art pass): a stale
  // caller is one that calls them on the terrain.
  const SHARED = ['setPalette', 'setColorHex', 'getColorHex', 'setDebugView', 'setArtData', 'setSeaLevel']
  const anywhere = new RegExp(`\\b(${ONLY_TERRAIN.join('|')})\\b`)
  const onTerrain = new RegExp(`\\bterrain\\??\\.(${SHARED.join('|')})\\b`)
  // A temporary review note at the top of a changed file may name what it removed.
  const reviewNote = /^\s*\/\/\s+- (changed|question|follow-up)/

  const files = []
  const walk = dir => {
    for (const name of readdirSync(dir)) {
      const p = new URL(name, dir)
      if (statSync(p).isDirectory()) walk(new URL(name + '/', dir))
      else if (/\.(js|mjs)$/.test(name)) files.push(p)
    }
  }
  walk(new URL('../../src/', import.meta.url))
  walk(new URL('../../tests/', import.meta.url))
  const root = new URL('../../', import.meta.url).pathname
  const self = new URL(import.meta.url).pathname

  it('are referenced nowhere in src/ or tests/', () => {
    const hits = []
    for (const f of files) {
      if (f.pathname === self) continue
      readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        if (reviewNote.test(line)) return
        if (anywhere.test(line) || onTerrain.test(line)) hits.push(`${f.pathname.slice(root.length)}:${i + 1}: ${line.trim()}`)
      })
    }
    expect(hits).toEqual([])
  })
})
