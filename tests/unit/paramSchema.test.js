import { describe, it, expect } from 'vitest'
import { validateRows, rowDefaults, uniformsFor, toDisplay, fromDisplay } from '../../src/shared/paramSchema.js'
import { onStepGrid } from './paramTestHelpers.js'

const slider = over => ({
  id: 'ctrl-a', owner: 'terrain', key: 'a', kind: 'slider', uniform: 'uA', encode: 'float',
  value: 0.5, min: 0, max: 1, step: 0.1, digits: 1, label: 'a', ...over,
})

describe('validateRows', () => {
  it('checks the form of a mirrorOf reference', () => {
    expect(validateRows([slider({ mirrorOf: 'terrain.shadowValue' })])).toEqual([])
    expect(validateRows([slider({ mirrorOf: 'shadowValue' })])).toHaveLength(1)
    expect(validateRows([slider({ mirrorOf: null })])).toHaveLength(1)
  })

  it('checks a clamp: true needs min and max, an explicit pair must be ordered and hold the default', () => {
    expect(validateRows([slider({ clamp: true })])).toEqual([])
    expect(validateRows([slider({ clamp: [0, Infinity] })])).toEqual([])
    expect(validateRows([slider({ clamp: [1, 0] })])).toHaveLength(1)
    expect(validateRows([slider({ clamp: 'yes' })])).toHaveLength(1)
    expect(validateRows([slider({ kind: 'hidden', min: undefined, max: undefined, clamp: true })])).toHaveLength(1)
    expect(validateRows([slider({ clamp: [0.6, 1] })])).toEqual(expect.arrayContaining([expect.stringMatching(/outside its clamp/)]))
  })

  it('accepts a well-formed row', () => {
    expect(validateRows([slider()])).toEqual([])
  })

  it('names each problem with the row it is in', () => {
    const problems = validateRows([slider({ kind: 'knob', encode: 'double', typo: 1 })])
    expect(problems).toEqual(expect.arrayContaining([
      expect.stringMatching(/^ctrl-a: unknown kind "knob"/),
      expect.stringMatching(/^ctrl-a: unknown encode "double"/),
      expect.stringMatching(/^ctrl-a: unknown field "typo"/),
    ]))
  })

  it('checks the value against the declared encode, not its own type', () => {
    expect(validateRows([slider({ encode: 'int', value: 0.5 })])).toHaveLength(1)
    expect(validateRows([slider({ kind: 'toggle', encode: 'float01', value: 1 })])).toHaveLength(1)
    expect(validateRows([slider({ kind: 'colour', encode: 'rawRgb', value: '#12345' })])).toHaveLength(1)
    expect(validateRows([slider({ kind: 'colour', encode: 'rawRgb', value: '#c8bda4' })])).toEqual([])
  })

  it('rejects a slider default outside its range, or a range that is empty', () => {
    expect(validateRows([slider({ value: 1.5 })])[0]).toMatch(/outside/)
    expect(validateRows([slider({ min: 1, max: 1, value: 1 })])[0]).toMatch(/not below/)
  })

  it('rejects an id used twice, and a key used twice within one owner only', () => {
    expect(validateRows([slider(), slider({ key: 'b' })])[0]).toMatch(/id used twice/)
    expect(validateRows([slider(), slider({ id: 'ctrl-b' })])[0]).toMatch(/key "a" used twice/)
    expect(validateRows([slider(), slider({ id: 'ctrl-b', owner: 'water' })])).toEqual([])
  })

  it('rejects a uniform name that does not look like one', () => {
    expect(validateRows([slider({ uniform: 'snowBase' })])[0]).toMatch(/does not look like one/)
  })

  it('checks index, invalidates and persist', () => {
    expect(validateRows([slider({ index: 1 })])).toEqual([])
    expect(validateRows([slider({ index: -1 })])[0]).toMatch(/index/)
    const { uniform, ...noUniform } = slider({ index: 0 })
    expect(validateRows([noUniform])[0]).toMatch(/index/)
    expect(validateRows([slider({ invalidates: ['shape', 'light'] })])).toEqual([])
    expect(validateRows([slider({ invalidates: '' })])[0]).toMatch(/invalidates/)
    expect(validateRows([slider({ persist: 'no' })])[0]).toMatch(/persist/)
  })

  it('wants a pair declared from both ends, with opposite orders', () => {
    const lo = slider({ pair: { with: 'b', order: 'lo' } })
    const hi = slider({ id: 'ctrl-b', key: 'b', pair: { with: 'a', order: 'hi' } })
    expect(validateRows([lo, hi])).toEqual([])
    expect(validateRows([lo])[0]).toMatch(/pair partner "b"/)
    expect(validateRows([lo, { ...hi, pair: { with: 'a', order: 'lo' } }])).toHaveLength(2)
    expect(validateRows([slider({ pair: { with: 'b', order: 'up' } })])[0]).toMatch(/pair must be/)
  })
})

describe('displayScale and live', () => {
  it('validates them', () => {
    expect(validateRows([slider({ displayScale: 1000, live: true })])).toEqual([])
    for (const bad of [0, -1, NaN, '1000']) {
      expect(validateRows([slider({ displayScale: bad })])[0], String(bad)).toMatch(/displayScale/)
    }
    expect(validateRows([slider({ live: 1 })])[0]).toMatch(/live/)
  })

  it('toDisplay and fromDisplay convert between stored and shown, and are the identity with no scale', () => {
    const ms = slider({ displayScale: 1000 })
    expect(toDisplay(ms, 0.05)).toBeCloseTo(50, 12)
    expect(fromDisplay(ms, 120)).toBeCloseTo(0.12, 12)
    for (const v of [0, 0.3, 7]) expect(fromDisplay(ms, toDisplay(ms, v))).toBeCloseTo(v, 12)
    expect(toDisplay(slider(), 0.3)).toBe(0.3)
    expect(fromDisplay(slider(), 0.3)).toBe(0.3)
  })
})

describe('onStepGrid', () => {
  it('is true on the grid from min, within float noise, and false between', () => {
    expect(onStepGrid({ value: 0.3, min: 0, step: 0.1 })).toBe(true)
    expect(onStepGrid({ value: -0.2, min: -1, step: 0.05 })).toBe(true)
    expect(onStepGrid({ value: 0.15, min: 0, step: 0.02 })).toBe(false)
  })
})

describe('rowDefaults', () => {
  it('maps every key to its default and refuses a key given twice', () => {
    expect(rowDefaults([slider(), slider({ id: 'b', key: 'b', value: 0.2 })])).toEqual({ a: 0.5, b: 0.2 })
    expect(() => rowDefaults([slider(), slider({ id: 'b' })])).toThrow(/"a" used twice/)
  })
})

describe('uniformsFor', () => {
  it("seeds one { value } per named uniform with the row's default, in the uniform's type", () => {
    const u = uniformsFor([
      slider(),
      slider({ id: 'b', key: 'b', uniform: 'uB', encode: 'int', value: 3 }),
      slider({ id: 'c', key: 'c', uniform: 'uC', kind: 'toggle', encode: 'float01', value: true }),
      slider({ id: 'd', key: 'd', uniform: 'uD', kind: 'toggle', encode: 'bool', value: false }),
      slider({ id: 'e', key: 'e', uniform: undefined }),
    ])
    expect(u).toEqual({ uA: { value: 0.5 }, uB: { value: 3 }, uC: { value: 1 }, uD: { value: false } })
  })

  it('narrows by pick', () => {
    const rows = [slider({ group: 'x' }), slider({ id: 'b', key: 'b', uniform: 'uB', group: 'y' })]
    expect(Object.keys(uniformsFor(rows, r => r.group === 'y'))).toEqual(['uB'])
  })

  it('gives two rows of one uniform one object, and refuses two defaults for it', () => {
    expect(uniformsFor([slider(), slider({ id: 'b', key: 'b' })])).toEqual({ uA: { value: 0.5 } })
    expect(() => uniformsFor([slider(), slider({ id: 'b', key: 'b', value: 0.2 })])).toThrow(/uA has two defaults/)
  })

  it('refuses an encode it cannot build, unless the caller gives a maker', () => {
    const colour = slider({ kind: 'colour', encode: 'srgb', value: '#ffffff' })
    expect(() => uniformsFor([colour])).toThrow(/cannot seed/)
    expect(uniformsFor([colour], undefined, { srgb: hex => ({ hex }) })).toEqual({ uA: { value: { hex: '#ffffff' } } })
  })

  it('skips an array-element row (the owner builds the array)', () => {
    expect(uniformsFor([slider({ index: 0 })])).toEqual({})
  })

  it('builds fresh objects on every call, so two owners never share one by accident', () => {
    expect(uniformsFor([slider()]).uA).not.toBe(uniformsFor([slider()]).uA)
  })
})
