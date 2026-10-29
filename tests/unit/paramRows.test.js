import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { validateRows } from '../../src/shared/paramSchema.js'
import { onStepGrid } from './paramTestHelpers.js'
import { TOOLTIPS } from '../../src/panel/tooltips.js'
import { createSceneUniforms } from '../../src/shared/sceneUniforms.js'
import { TERRAIN_PARAMS } from '../../src/terrain/terrainParams.js'
import { Terrain } from '../../src/terrain/terrain.js'
import { WATER_PARAMS } from '../../src/water/waterParams.js'
import { Water } from '../../src/water/water.js'
import { GODRAY_PARAMS } from '../../src/clouds/godrayParams.js'
import { Godrays } from '../../src/clouds/godrays.js'
import { CLOUD_PARAMS } from '../../src/clouds/cloudParams.js'
import { VolumeClouds } from '../../src/clouds/cloudsVolume.js'
import * as THREE from 'three'
import { ART_ROWS } from '../../src/artpass/artPassParams.js'
import { ArtPass } from '../../src/artpass/artPass.js'
import { ArtGBuffer } from '../../src/artpass/artGBuffer.js'
import { AUDIO_PARAMS } from '../../src/audio/audioParams.js'
import { MIC_PARAMS } from '../../src/interaction/interactionParams.js'
import { FLY_PARAMS } from '../../src/scene/flyCameraParams.js'
import { SKY_PARAMS } from '../../src/render/skyParams.js'
import { DYNAMICS_PARAMS, ANIM_SPEED_PARAMS } from '../../src/dynamics/dynamicsParams.js'
import { FORM_WALKER_PARAMS } from '../../src/drift/formWalkerParams.js'
import { FORM_PARAMS } from '../../src/scene/formParams.js'
import { ATMOSPHERE_PARAMS } from '../../src/drift/atmosphereParams.js'
import { SIM_PARAMS } from '../../src/shared/simState.js'
import { DISPLAY_PARAMS } from '../../src/render/display.js'
import { SCENE_PARAMS } from '../../src/shared/sceneParams.js'
import { HORIZON_COLOUR_PARAMS } from '../../src/scene/horizonColour.js'
import { rawRgbHex } from '../../src/shared/uniformValue.js'
import { CAM_POSITION } from '../../src/shared/sceneConfig.js'

/**
 * Every owner's param rows (shared/paramSchema.js), checked by one generic
 * suite. A typo in a row is silent everywhere it is used: a misspelled uniform
 * never reaches a shader, a duplicate key makes one row win. These are structural checks; nothing here pins a tuned
 * value. The last suite pins only that the owner takes its defaults from the
 * rows.
 */

const SRC = new URL('../../src/', import.meta.url)

/**
 * owner → its rows, the src/ folders holding its shaders, and how to reach the
 * uniform tables of a freshly built owner (each builds THREE materials only; no
 * GL context is needed). Every row goes through `<owner>.params` by key.
 */
const OWNERS = [
  {
    owner: 'terrain', rows: TERRAIN_PARAMS, shaders: ['terrain/'],
    tables: () => new Terrain(new EventTarget(), createSceneUniforms())._uniformTables(),
  },
  {
    owner: 'water', rows: WATER_PARAMS, shaders: ['water/'],
    tables: () => [new Water(new EventTarget(), createSceneUniforms())._material.uniforms],
  },
  {
    owner: 'clouds', rows: CLOUD_PARAMS, shaders: ['clouds/'],
    tables: () => new VolumeClouds(createSceneUniforms())._uniformTables(),
  },
  {
    owner: 'scene', rows: SCENE_PARAMS, shaders: ['terrain/', 'water/'],
    tables: () => {
      const scene = createSceneUniforms()
      return [scene.mount(SCENE_PARAMS.filter(r => r.uniform).map(r => r.uniform))]
    },
  },
  {
    owner: 'godrays', rows: GODRAY_PARAMS, shaders: ['clouds/'],
    tables: () => { const g = new Godrays(createSceneUniforms()); return [g._marchMaterial.uniforms, g._compositeMaterial.uniforms] },
  },
  {
    owner: 'artPass', rows: ART_ROWS, shaders: ['artpass/'],
    tables: () => {
      const scene = createSceneUniforms()
      const gbuffer = new ArtGBuffer(new Terrain(new EventTarget(), scene), new Water(new EventTarget(), scene))
      return new ArtPass(gbuffer, new THREE.PerspectiveCamera(), { sceneUniforms: scene }).uniformTables()
    },
  },
  // Non-shader owners: no uniform tables, nothing to compare against shaders.
  { owner: 'audio', rows: AUDIO_PARAMS, shaders: [] },
  { owner: 'sky', rows: SKY_PARAMS, shaders: [] },
  { owner: 'horizon', rows: HORIZON_COLOUR_PARAMS, shaders: [] },
  { owner: 'display', rows: DISPLAY_PARAMS, shaders: [] },
  { owner: 'sim', rows: SIM_PARAMS, shaders: [] },
  { owner: 'atmosphere', rows: ATMOSPHERE_PARAMS, shaders: [] },
  { owner: 'formWalker', rows: FORM_WALKER_PARAMS, shaders: [] },
  { owner: 'form', rows: FORM_PARAMS, shaders: [] },
  { owner: 'dynamics', rows: DYNAMICS_PARAMS, shaders: [] },
  { owner: 'animSpeed', rows: ANIM_SPEED_PARAMS, shaders: [] },
  { owner: 'interaction', rows: MIC_PARAMS, shaders: [] },
  { owner: 'flyCamera', rows: FLY_PARAMS, shaders: [] },
]

// A default off its own step grid makes the panel and the owner disagree from
// the moment the page loads: a range input snaps what it shows to the step, so
// the slider reports one number while the shader runs another, and the picture
// changes the first time the slider is touched without being moved. A driven
// default is exempt (the driver overwrites it at boot); the rest are listed
// here, not fixed: this phase changes no default and no range.
const OFF_GRID = {
  'ctrl-mic-floor': 'the measured quiet level, -46.6 dBFS, between the 1 dB steps of its slider',
}

// `uniform` names held in a JS-only { value } table, which no shader declares.
const JS_ONLY_UNIFORMS = {
  clouds: {
    uCloudSpeed: 'cloudsVolume._jsUniforms: drives the wind offset',
    uWeatherSpeed: 'cloudsVolume._jsUniforms: drives uWeatherOffset',
  },
}

/** name → the GLSL types it is declared with, across every shader of a folder. */
function shaderDeclarations(dirs) {
  const files = []
  const walk = dir => {
    for (const name of readdirSync(dir)) {
      const p = new URL(name, dir)
      if (statSync(p).isDirectory()) walk(new URL(name + '/', dir))
      else if (/\.(glsl|frag|vert)$/.test(name)) files.push(p)
    }
  }
  for (const d of [...dirs, 'shared/shaders/']) walk(new URL(d, SRC))
  const decl = new Map()
  for (const f of files) {
    const text = readFileSync(f, 'utf8')
    for (const m of text.matchAll(/^\s*uniform\s+(?:(?:lowp|mediump|highp)\s+)?(\w+)\s+([^;]+);/gm)) {
      for (const n of m[2].split(',')) {
        const name = n.trim().replace(/\[.*$/, '')
        if (!decl.has(name)) decl.set(name, new Set())
        decl.get(name).add(m[1])
      }
    }
  }
  return decl
}

// GLSL type → the encodes that can write it.
const ENCODES_FOR_TYPE = {
  float: ['float', 'float01', 'int'], int: ['int'], bool: ['bool'], vec2: ['vec2'], vec3: ['srgb', 'rawRgb'],
}

describe('camera-safety pit', () => {
  it('cannot be pushed to a floor the camera would clip: the floor slider tops out below CAM_POSITION.y with margin', () => {
    const floor = TERRAIN_PARAMS.find(r => r.key === 'camPitFloor')
    const SAFETY_MARGIN = 5   // world units, matches tests/visual/cam_pit.spec.js
    expect(floor.max).toBeLessThanOrEqual(CAM_POSITION.y - SAFETY_MARGIN)
  })
})

describe('param rows', () => {
  const all = OWNERS.flatMap(o => o.rows)

  it('are valid rows: shape, encode, range, unique ids, keys unique per owner', () => {
    expect(validateRows(all)).toEqual([])
  })

  for (const { owner, rows } of OWNERS) {
    // The panel binds a registry row through `<row.owner>.params`.
    it(`${owner}: every row names its owner`, () => {
      for (const r of rows) expect(r.owner, r.id).toBe(owner)
    })
  }

  it('start on their step grid, unless a driver writes them or they are listed', () => {
    const off = all.filter(r => r.kind === 'slider' && !r.drivenBy && !onStepGrid(r)).map(r => r.id)
    expect(off.sort()).toEqual(Object.keys(OFF_GRID).sort())
  })

  // A hidden row has no control; a radio row's tooltips sit on its individual
  // radios (tooltips.spec.js checks those in the page). A colour row without a
  // DOM id (a species' crown colour) is matched by its host's selector.
  it('each have a tooltip, if they have a control of their own', () => {
    const selectors = new Set(TOOLTIPS.map(t => t.selector))
    for (const r of all) {
      if (r.kind === 'hidden' || r.kind === 'radio' || r.id === `${r.owner}.${r.key}`) continue
      expect(selectors.has(`#${r.id}`) || selectors.has(`[id="${r.id}"]`), r.id).toBe(true)
    }
  })

  for (const { owner, rows, shaders } of OWNERS) {
    it(`${owner}: every uniform is declared in one of its shaders, with a type its encode can write`, () => {
      const decl = shaderDeclarations(shaders)
      const jsOnly = JS_ONLY_UNIFORMS[owner] || {}
      for (const r of rows) {
        if (!r.uniform || r.uniform in jsOnly) continue
        const types = decl.get(r.uniform)
        expect(types, `${r.id}: ${r.uniform} is declared nowhere`).toBeDefined()
        for (const t of types) expect(ENCODES_FOR_TYPE[t] || [], `${r.id}: ${t} ${r.uniform}`).toContain(r.encode)
      }
    })
  }

  for (const { owner, rows } of OWNERS) {
    const jsOnly = JS_ONLY_UNIFORMS[owner] || {}
    it(`${owner}: a JS-only uniform is still named by a row`, () => {
      for (const name of Object.keys(jsOnly)) expect(rows.map(r => r.uniform), name).toContain(name)
    })
  }
})

// A row is the one place its uniform's default lives: a freshly built owner
// must hold exactly that, in the uniform object itself (not through the key
// accessor, which would also pass if the owner seeded a second default and a
// writer copied it over). Nothing a driver writes is applied at construction.
describe("every row-backed uniform of a freshly built owner holds its row's value", () => {
  for (const { owner, rows, tables } of OWNERS.filter(o => o.tables)) {
    it(`${owner}`, () => {
      const built = tables()
      for (const r of rows.filter(r => r.uniform)) {
        const u = built.find(t => r.uniform in t)?.[r.uniform]
        expect(u, `${r.id}: ${r.uniform} is in none of the owner's uniform tables`).toBeDefined()
        const v = 'index' in r ? u.value[r.index] : u.value
        const held = v && v.isColor ? '#' + v.getHexString()
          : v && v.isVector3 ? rawRgbHex(v)
          : v && v.isVector2 ? [v.x, v.y] : v
        expect(held, r.id).toEqual(r.encode === 'float01' ? (r.value ? 1 : 0) : r.value)
      }
    })
  }
})
