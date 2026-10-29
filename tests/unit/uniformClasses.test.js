import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { Terrain } from '../../src/terrain/terrain.js'
import { Water } from '../../src/water/water.js'
import { Godrays } from '../../src/clouds/godrays.js'
import { ArtGBuffer } from '../../src/artpass/artGBuffer.js'
import { ArtPass } from '../../src/artpass/artPass.js'
import { VolumeClouds } from '../../src/clouds/cloudsVolume.js'
import { createSceneUniforms, SCENE_UNIFORM_NAMES, SCENE_ALIASES } from '../../src/shared/sceneUniforms.js'
import { namesOfClass, captureUniforms } from '../../src/shared/uniformSerialize.js'
import { TERRAIN_PARAMS, UNIFORM_CLASSES as TERRAIN_CLASSES } from '../../src/terrain/terrainParams.js'
import { WATER_PARAMS, UNIFORM_CLASSES as WATER_CLASSES } from '../../src/water/waterParams.js'
import { CLOUD_PARAMS, UNIFORM_CLASSES as CLOUD_CLASSES } from '../../src/clouds/cloudParams.js'
import { GODRAY_PARAMS, UNIFORM_CLASSES as GODRAY_CLASSES } from '../../src/clouds/godrayParams.js'
import { ART_ROWS, UNIFORM_CLASSES as ART_CLASSES } from '../../src/artpass/artPassParams.js'

/**
 * Every uniform of every owner is classified (shared/uniformSerialize.js): a
 * row writes it, a derived entry computes it, the scene set owns it, or the
 * owner's UNIFORM_CLASSES lists it as integrated, derived, frame or constant.
 * A new uniform that is none of these fails here, which is what keeps it from
 * dropping out of snapshots silently.
 */
function build() {
  const scene = createSceneUniforms()
  const terrain = new Terrain(new EventTarget(), scene)
  const water = new Water(new EventTarget(), scene)
  const clouds = new VolumeClouds(scene)
  const artPass = new ArtPass(new ArtGBuffer(terrain, water), new THREE.PerspectiveCamera(), { sceneUniforms: scene })
  const godrays = new Godrays(scene)
  return {
    scene,
    owners: {
      terrain: { mod: terrain, rows: TERRAIN_PARAMS, classes: TERRAIN_CLASSES, tables: terrain._uniformTables() },
      water: { mod: water, rows: WATER_PARAMS, classes: WATER_CLASSES, tables: [water._material.uniforms] },
      clouds: { mod: clouds, rows: CLOUD_PARAMS, classes: CLOUD_CLASSES, tables: clouds._uniformTables() },
      godrays: {
        mod: godrays, rows: GODRAY_PARAMS, classes: GODRAY_CLASSES,
        tables: [godrays._marchMaterial.uniforms, godrays._compositeMaterial.uniforms],
      },
      artPass: { mod: artPass, rows: ART_ROWS, classes: ART_CLASSES, tables: artPass.uniformTables() },
    },
  }
}

const VALID = /^(integrated|derived|frame|constant|row:\w[\w:]*)$/
const namesOf = tables => [...new Set(tables.flatMap(t => Object.keys(t)))]
const holder = (tables, name) => tables.find(t => Object.hasOwn(t, name))[name]

describe('uniform classification', () => {
  const { scene, owners } = build()
  const sceneObjects = new Set(Object.values(scene.mount(SCENE_UNIFORM_NAMES)))

  for (const [name, { mod, rows, classes, tables }] of Object.entries(owners)) {
    describe(name, () => {
      const rowUniforms = new Set(mod.params.rowUniforms())
      const derived = new Set(mod.params.derivedUniforms())
      const isShared = n => sceneObjects.has(holder(tables, n))

      it('classifies every uniform of every table exactly once', () => {
        const unclassified = namesOf(tables).filter(n =>
          !rowUniforms.has(n) && !derived.has(n) && !isShared(n) && !(n in classes))
        expect(unclassified, `${name}: no row, derived entry, scene-set object or UNIFORM_CLASSES entry`).toEqual([])
        const twice = Object.keys(classes).filter(n => rowUniforms.has(n) || derived.has(n) || isShared(n))
        expect(twice, `${name}: listed in UNIFORM_CLASSES and also owned elsewhere`).toEqual([])
      })

      it('lists no name that no longer exists, and only valid classes', () => {
        const live = new Set(namesOf(tables))
        expect(Object.keys(classes).filter(n => !live.has(n))).toEqual([])
        expect(Object.entries(classes).filter(([, c]) => !VALID.test(c)).map(([n]) => n)).toEqual([])
      })

      it("points every 'row:<key>' at a row that names no uniform of its own", () => {
        for (const [n, c] of Object.entries(classes)) {
          if (!c.startsWith('row:')) continue
          const row = rows.find(r => r.key === c.slice(4))
          expect(row, `${n} → ${c}`).toBeTruthy()
          expect(row.uniform, `${c} must be a field row`).toBeUndefined()
        }
      })

      it('captures every integrated uniform (each is a serialisable value)', () => {
        const names = namesOfClass(classes, 'integrated')
        const out = captureUniforms(tables, names)
        expect(Object.keys(out)).toEqual(names)
      })

      // The cloud volume is the scene set's source, not a consumer: its own
      // level, height, extent and wind are rows under the same names.
      it.skipIf(name === 'clouds')('treats a scene-set name as the scene set\'s object, never a stray copy', () => {
        const sharedNames = new Set([...SCENE_UNIFORM_NAMES, ...SCENE_ALIASES])
        for (const n of namesOf(tables)) {
          expect(isShared(n), `${name}.${n}`).toBe(sharedNames.has(n))
        }
      })
    })
  }
})
