import { describe, test, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { SPECIES, SPECIES_FORM, speciesUniformArrays } from '../../src/terrain/treeSpecies.js'

// treeSpecies.js is the single source of truth for the forest's species, but
// the shader holds the count separately as `const int CAN_SPECIES` (GLSL needs
// a compile-time array size). That is a duplicated fact, so it is pinned here:
// a forgotten bump would read a uniform array element JS never wrote, which in
// GLSL is a silent zero — a species with radius 0 and a black crown, no error
// anywhere. This is the one seam the registry cannot close by construction.
const forestSrc = readFileSync(
  new URL('../../src/terrain/shaders/includes/forest.glsl', import.meta.url), 'utf8')

describe('tree species registry', () => {
  test('CAN_SPECIES in forest.glsl matches the species table', () => {
    const m = forestSrc.match(/const int CAN_SPECIES = (\d+);/)
    expect(m, 'CAN_SPECIES declaration not found in forest.glsl').not.toBeNull()
    expect(Number(m[1])).toBe(SPECIES.length)
  })

  test('every declared uniform array is seeded for every species', () => {
    // A short array is the same silent-zero failure as a stale CAN_SPECIES.
    const arrays = speciesUniformArrays()
    for (const [name, values] of Object.entries(arrays)) {
      expect(values, `${name} is not one value per species`).toHaveLength(SPECIES.length)
      for (const v of values) expect(Number.isFinite(v), `${name} has a non-finite entry`).toBe(true)
    }
  })

  test('each property is declared in the shader as an array of CAN_SPECIES', () => {
    for (const p of SPECIES_FORM) {
      expect(forestSrc, `${p.uniform} is not declared as a species array`)
        .toMatch(new RegExp(`uniform\\s+\\w+\\s+${p.uniform}\\[CAN_SPECIES\\]`))
    }
  })

  test('species 0 is the fallback every biome lands on', () => {
    // speciesFor() returns 0 for anything it does not name, so index 0 must be
    // the general-purpose tree. If a special-case species were moved to the
    // front, every unnamed biome would silently grow it.
    expect(SPECIES[0].key).toBe('conifer')
    expect(forestSrc).toMatch(/int speciesFor\(float matRoot\)/)
  })

  test('every form value sits inside its own slider range', () => {
    // The panel clamps to min/max, so a default outside them is unreachable
    // from the UI — the slider would jump on first touch and never return.
    for (const [i, sp] of SPECIES.entries()) {
      for (const p of SPECIES_FORM) {
        const v = sp.form[p.key]
        expect(v, `${sp.key}.${p.key} missing`).toBeTypeOf('number')
        expect(v, `${sp.key}.${p.key} = ${v} below min ${p.min}`).toBeGreaterThanOrEqual(p.min)
        expect(v, `${sp.key}.${p.key} = ${v} above max ${p.max}`).toBeLessThanOrEqual(p.max)
      }
      expect(sp.color, `species ${i} colour must be a 0xRRGGBB int`).toBeLessThanOrEqual(0xffffff)
    }
  })

  test('each species keeps its own crown inside the candidate-set support', () => {
    // forest.glsl clamps each species against ITS OWN reach:
    //   cap = min(radius*(1+sizeVar), (CAN_SUPPORT2 - jitter) / (elong*(1+|lean|)))
    // and exactness needs cap * elong*(1+|lean|) + jitter <= CAN_SUPPORT2 for
    // every species independently. Restated here rather than copied, and swept
    // over the jitter slider's whole range since jitter is what eats the budget.
    const CAN_SUPPORT2 = 1.41421
    for (let jitter = 0; jitter <= 0.2001; jitter += 0.01) {   // ctrl-forest-jitter
      for (const sp of SPECIES) {
        const f = sp.form
        const extent = Math.max(f.elong, 1) * (1 + Math.abs(f.lean))
        const cap = Math.min(f.radius * (1 + f.sizeVar), (CAN_SUPPORT2 - jitter) / extent)
        expect(cap * extent + jitter,
          `${sp.key} overruns its support at jitter ${jitter.toFixed(2)}`)
          .toBeLessThanOrEqual(CAN_SUPPORT2 + 1e-6)
      }
    }
  })

  test('a round species really can be wider than an elongated one', () => {
    // The reason radius is per-species at all. With ONE shared clamp the most
    // elongated species caps everyone's width, so this asserts the property the
    // per-species clamp exists to deliver — not just that the code runs.
    const cap = f => Math.min(f.radius * (1 + f.sizeVar),
                              (1.41421 - 0.2) / (Math.max(f.elong, 1) * (1 + Math.abs(f.lean))))
    const conifer = SPECIES.find(s => s.key === 'conifer')
    const broad   = SPECIES.find(s => s.key === 'broadleaf')
    expect(cap(broad.form)).toBeGreaterThan(cap(conifer.form) * 1.5)
  })
})
