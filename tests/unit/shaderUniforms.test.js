/**
 * shaderUniforms.test.js — the composed GLSL must declare each uniform once.
 *
 * Why this exists: the includes are spliced into their host shader by
 * terrain.js/water.js, so a uniform declared in BOTH an include and its host
 * becomes a duplicate declaration in one translation unit. GLSL rejects that,
 * and a rejected program is silent until runtime — the whole terrain simply
 * stops rendering. That is exactly how `uForestSnowGap`, declared in both
 * forest.glsl and terrain.frag, blanked the scene.
 *
 * Ground truth is the GLSL rule itself (one declaration per name per program),
 * not a re-statement of any shader's contents, so this cannot drift with tuning.
 */
import { describe, test, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { inject, declaredUniforms } from '../../src/shared/shaderCompose.js'

const read = p => readFileSync(new URL(`../../src/${p}`, import.meta.url), 'utf8')

const noise      = read('shared/shaders/noise.glsl')
const fbm        = read('terrain/shaders/includes/fbm.glsl')
const erosion    = read('terrain/shaders/includes/erosion.glsl')
const material   = read('terrain/shaders/includes/material.glsl')
const forest     = read('terrain/shaders/includes/forest.glsl')
const dataSample = read('terrain/shaders/includes/dataMapSample.glsl')

// Mirrors the compose calls in terrain.js / water.js. If one of those gains an
// include, add it here — that is the point: this list IS the program layout.
const PROGRAMS = {
  'terrain.vert': inject(read('terrain/shaders/terrain.vert'), [
    ['// dataMapSample.glsl injected here by terrain.js at shader compile time', dataSample],
    ['// noise.glsl injected here by terrain.js at shader compile time', noise],
    ['// fbm.glsl injected here by terrain.js at shader compile time', fbm],
  ]),
  'terrain.frag': inject(read('terrain/shaders/terrain.frag'), [
    ['// noise.glsl injected by terrain.js', noise],
    ['// material.glsl injected by terrain.js', material],
    ['// forest.glsl injected by terrain.js', forest],
  ]),
  'heightmap.frag': inject(read('terrain/shaders/heightmap.frag'), [
    ['// noise.glsl injected by terrain.js', noise],
    ['// fbm.glsl injected by terrain.js', fbm],
    ['// erosion.glsl injected by terrain.js', erosion],
  ]),
  'derive.frag': inject(read('terrain/shaders/derive.frag'), [
    ['// dataMapSample.glsl injected by terrain.js', dataSample],
  ]),
  'water.vert': inject(read('water/shaders/water.vert'), [['// noise.glsl injected by water.js', noise]]),
  'water.frag': inject(read('water/shaders/water.frag'), [['// noise.glsl injected by water.js', noise]]),
}

describe('composed GLSL uniform declarations', () => {
  for (const [name, src] of Object.entries(PROGRAMS)) {
    test(`${name} declares each uniform exactly once`, () => {
      const seen = new Map()
      for (const u of declaredUniforms(src)) seen.set(u, (seen.get(u) ?? 0) + 1)
      const dupes = [...seen].filter(([, n]) => n > 1).map(([u, n]) => `${u} x${n}`)
      expect(dupes, `duplicate uniform declaration(s) in ${name}`).toEqual([])
    })
  }

  test('the check has teeth — a planted duplicate is caught', () => {
    const planted = PROGRAMS['terrain.frag'] + '\nuniform float uForestCell;\n'
    const seen = new Map()
    for (const u of declaredUniforms(planted)) seen.set(u, (seen.get(u) ?? 0) + 1)
    expect([...seen].filter(([, n]) => n > 1).map(([u]) => u)).toContain('uForestCell')
  })

  test('every include actually spliced in — no marker left behind', () => {
    for (const [name, src] of Object.entries(PROGRAMS)) {
      expect(src, `${name} still contains an un-spliced include marker`)
        .not.toMatch(/\/\/ \w+\.glsl injected/)
    }
  })
})

describe('declaredUniforms', () => {
  test('reads lists and arrays, and ignores comments of both kinds', () => {
    const src = `
      uniform float uA, uB;
      uniform vec3 uPalette[16];
      // uniform float uCommented;
      /** uniform float uDocumented; */
      uniform sampler2D uTex;  // trailing uniform float uAlso;
    `
    expect(declaredUniforms(src)).toEqual(['uA', 'uB', 'uPalette', 'uTex'])
  })
})
