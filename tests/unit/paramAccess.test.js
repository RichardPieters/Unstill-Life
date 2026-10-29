import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { paramAccess } from '../../src/shared/paramAccess.js'

const row = (key, uniform, over = {}) => ({
  id: `ctrl-${key}`, owner: 't', key, kind: 'slider', encode: 'float', value: 0, ...(uniform ? { uniform } : {}), ...over,
})

describe('paramAccess', () => {
  it('routes each key to whichever table holds its uniform', () => {
    const material = { uSnowBase: { value: 0 } }
    const heightmap = { uErosionStrength: { value: 0 } }
    const p = paramAccess({ tables: [material, heightmap], rows: [row('snowBase', 'uSnowBase'), row('strength', 'uErosionStrength')] })
    p.set('snowBase', 0.8)
    p.set('strength', 0.6)
    expect(material.uSnowBase.value).toBe(0.8)
    expect(heightmap.uErosionStrength.value).toBe(0.6)
    expect(p.get('strength')).toBe(0.6)
  })

  it('writes the first table that has a name; a shared object then reaches every table', () => {
    const shared = { value: 1 }
    const a = { uX: shared }, b = { uX: shared }
    const p = paramAccess({ tables: [a, b], rows: [row('x', 'uX')] })
    p.set('x', 4)
    expect(a.uX.value).toBe(4)
    expect(b.uX.value).toBe(4)
  })

  it('applies a per-row encode before the write', () => {
    const u = { uEnableFog: { value: true } }
    const p = paramAccess({ tables: [u], rows: [row('fog', 'uEnableFog', { encode: 'bool' })] })
    p.set('fog', 0)
    expect(u.uEnableFog.value).toBe(false)
    p.set('fog', 1)
    expect(u.uEnableFog.value).toBe(true)
  })

  it('rejects an unknown encode name at construction', () => {
    expect(() => paramAccess({ tables: [{ uX: { value: 0 } }], rows: [row('x', 'uX', { encode: 'nope' })] })).toThrow(/encode/)
  })

  it('ignores an unknown key, or a row whose uniform no table holds, and reads it as null', () => {
    const u = { uX: { value: 1 } }
    const p = paramAccess({ tables: [u], rows: [row('x', 'uX'), row('gone', 'uGone')] })
    expect(p.set('nope', 5)).toBe(false)
    expect(p.get('nope')).toBe(null)
    expect(p.set('gone', 5)).toBe(false)
    expect(p.get('gone')).toBe(null)
    expect(p.has('x')).toBe(true)
    expect(p.has('nope')).toBe(false)
    expect(p.get('constructor')).toBe(null)   // no prototype leak through the key map
    expect(u.uX.value).toBe(1)
  })

  it('mutates a Color in place and never replaces it with a number', () => {
    const u = { uCol: { value: new THREE.Color(0x000000) } }
    const color = u.uCol.value
    const p = paramAccess({ tables: [u], rows: [row('col', 'uCol', { kind: 'colour', encode: 'srgb', value: '#000000' })] })
    expect(p.set('col', 0x336699)).toBe(true)
    expect(u.uCol.value).toBe(color)
    expect(color.getHexString()).toBe('336699')
    expect(p.set('col', 0.5)).toBe(false)
    expect(u.uCol.value).toBe(color)
    expect(p.get('col')).toBe('#336699')
  })
})

describe('paramAccess over rows', () => {
  it('notify runs the change hooks for a value that moved behind the accessor, and ignores an unknown key', () => {
    let held = 1
    const p = paramAccess({ tables: [], rows: [row('f', undefined, { encode: 'float' })], fields: { f: { get: () => held, set: v => { held = v } } } })
    const seen = [], any = []
    p.onChange('f', v => seen.push(v))
    p.onAnyChange((k, v) => any.push([k, v]))
    held = 7
    p.notify('f')
    p.notify('nope')
    expect(seen).toEqual([7])
    expect(any).toEqual([['f', 7]])
  })

  it('maps a row that names a uniform to it', () => {
    const u = { uA: { value: 0 } }
    const p = paramAccess({ tables: [u], rows: [row('a', 'uA')] })
    expect(p.set('a', 3)).toBe(true)
    expect(u.uA.value).toBe(3)
    expect(p.keys()).toEqual(['a'])
  })

  it("applies a row's bool, float01 and int encodes, and writes a float as given", () => {
    const u = { uOn: { value: false }, uF: { value: 0 }, uN: { value: 0 }, uX: { value: 0 } }
    const p = paramAccess({ tables: [u], rows: [
      row('on', 'uOn', { encode: 'bool' }), row('f', 'uF', { encode: 'float01' }),
      row('n', 'uN', { encode: 'int' }), row('x', 'uX'),
    ] })
    p.set('on', 1)
    p.set('f', true)
    p.set('n', 2.6)
    p.set('x', 2.6)
    expect(u.uOn.value).toBe(true)
    expect(u.uF.value).toBe(1)
    expect(u.uN.value).toBe(3)
    expect(u.uX.value).toBe(2.6)
  })

  it("reads a float01 row back as a boolean and an srgb row as '#rrggbb'", () => {
    const u = { uF: { value: 1 }, uC: { value: new THREE.Color(0x336699) } }
    const p = paramAccess({ tables: [u], rows: [
      row('f', 'uF', { kind: 'toggle', encode: 'float01', value: true }),
      row('c', 'uC', { kind: 'colour', encode: 'srgb', value: '#336699' }),
    ] })
    expect(p.get('f')).toBe(true)
    expect(p.get('c')).toBe('#336699')
    p.set('c', '#102030')
    expect(p.get('c')).toBe('#102030')
  })

  it("writes a rawRgb row into its Vector3 in place, reads it back as '#rrggbb', and guards by that hex", () => {
    const vec = new THREE.Vector3(0x33 / 255, 0x66 / 255, 0x99 / 255)
    const u = { uC: { value: vec } }
    let changes = 0
    const p = paramAccess({ tables: [u], rows: [row('c', 'uC', { kind: 'colour', encode: 'rawRgb', value: '#336699' })] })
    p.onChange('c', () => changes++)
    expect(p.get('c')).toBe('#336699')
    p.set('c', '#336699')
    p.set('c', '#336699'.toUpperCase())
    expect(changes).toBe(0)
    p.set('c', '#102030')
    expect(u.uC.value).toBe(vec)
    expect([vec.x, vec.y, vec.z]).toEqual([0x10 / 255, 0x20 / 255, 0x30 / 255])
    expect(p.get('c')).toBe('#102030')
    expect(changes).toBe(1)
  })

  it('writes one element of an array uniform for a row with an index', () => {
    const colors = [new THREE.Color(0), new THREE.Color(0)]
    const u = { uR: { value: [1, 2] }, uCol: { value: colors } }
    const p = paramAccess({ tables: [u], rows: [
      row('r1', 'uR', { index: 1 }),
      row('c0', 'uCol', { index: 0, kind: 'colour', encode: 'srgb', value: '#000000' }),
    ] })
    p.set('r1', 5)
    p.set('c0', '#ff0000')
    expect(u.uR.value).toEqual([1, 5])
    expect(p.get('r1')).toBe(5)
    expect(u.uCol.value[0]).toBe(colors[0])
    expect(p.get('c0')).toBe('#ff0000')
    expect(colors[1].getHex()).toBe(0)
  })

  it('refuses one key in two rows', () => {
    const u = { uA: { value: 0 }, uB: { value: 0 } }
    expect(() => paramAccess({ tables: [u], rows: [row('a', 'uA'), row('a', 'uB')] })).toThrow(/"a" is mapped twice/)
  })
})

describe('paramAccess fields and held state', () => {
  it("routes a field row to the owner's get/set", () => {
    let segs = 800
    const p = paramAccess({ tables: [{}], rows: [row('segments', null, { value: 800 })],
      fields: { segments: { get: () => segs, set: v => { segs = v } } } })
    expect(p.get('segments')).toBe(800)
    p.set('segments', 400)
    expect(segs).toBe(400)
  })

  it('holds a row with neither a uniform nor a field itself, seeded from the row', () => {
    const p = paramAccess({ tables: [{}], rows: [row('angle', null, { value: 336 })] })
    expect(p.get('angle')).toBe(336)
    p.set('angle', 12)
    expect(p.get('angle')).toBe(12)
  })

  it('refuses a field without a row, and a row that is both a uniform and a field', () => {
    const f = { get: () => 0, set: () => {} }
    expect(() => paramAccess({ tables: [{}], fields: { x: f } })).toThrow(/field "x" has no row/)
    expect(() => paramAccess({ tables: [{ uX: { value: 0 } }], rows: [row('x', 'uX')], fields: { x: f } }))
      .toThrow(/uniform and a field/)
  })
})

describe('paramAccess derived uniforms', () => {
  const build = () => {
    const u = { uDir: { value: new THREE.Vector2() }, uA: { value: 2 } }
    const p = paramAccess({
      tables: [u], rows: [row('angle', null, { value: 0 }), row('a', 'uA', { value: 2 })],
      derived: [{ uniform: 'uDir', from: ['angle', 'a'],
        fn: read => ({ x: read('a') * Math.cos(read('angle')), y: read('a') * Math.sin(read('angle')) }) }],
    })
    return { u, p }
  }

  it('computes the derived value once at construction', () => {
    const { u } = build()
    expect([u.uDir.value.x, u.uDir.value.y]).toEqual([2, 0])
  })

  it('recomputes it in place when any input key changes', () => {
    const { u, p } = build()
    const vec = u.uDir.value
    p.set('angle', Math.PI / 2)
    expect(u.uDir.value).toBe(vec)
    expect(vec.x).toBeCloseTo(0, 12)
    expect(vec.y).toBeCloseTo(2, 12)
    p.set('a', 3)
    expect(vec.y).toBeCloseTo(3, 12)
  })

  it('refuses a derived uniform a row names, or one that reads an unknown key', () => {
    const u = { uA: { value: 0 } }
    expect(() => paramAccess({ tables: [u], rows: [row('a', 'uA')], derived: [{ uniform: 'uA', from: ['a'], fn: () => 0 }] }))
      .toThrow(/also a row's uniform/)
    expect(() => paramAccess({ tables: [u], derived: [{ uniform: 'uA', from: ['nope'], fn: () => 0 }] }))
      .toThrow(/unknown key "nope"/)
  })
})

describe('paramAccess change guard, hooks and invalidation', () => {
  const build = () => {
    const u = { uA: { value: 1 }, uC: { value: new THREE.Color(0x336699) } }
    const dirty = []
    const p = paramAccess({ tables: [u], rows: [
      row('a', 'uA', { value: 1, invalidates: ['shape', 'light'] }),
      row('c', 'uC', { kind: 'colour', encode: 'srgb', value: '#336699' }),
    ], onInvalidate: cls => dirty.push(cls) })
    return { u, p, dirty }
  }

  it('notifies onChange, then onAnyChange, after a set, with the new value', () => {
    const { p } = build()
    const seen = []
    p.onChange('a', v => seen.push(['a', v]))
    p.onAnyChange((k, v) => seen.push(['any', k, v]))
    p.set('a', 4)
    expect(seen).toEqual([['a', 4], ['any', 'a', 4]])
  })

  it('treats a set equal to the current value as a no-op: no hook, no invalidation', () => {
    const { p, dirty } = build()
    const seen = []
    p.onAnyChange(k => seen.push(k))
    expect(p.set('a', 1)).toBe(true)
    expect(p.set('c', 0x336699)).toBe(true)
    expect(p.set('c', '#336699')).toBe(true)
    expect(seen).toEqual([])
    expect(dirty).toEqual([])
  })

  it('calls onInvalidate once per changed set for each class the row names', () => {
    const { p, dirty } = build()
    p.set('a', 2)
    expect(dirty).toEqual(['shape', 'light'])
  })

  it('unsubscribes', () => {
    const { p } = build()
    const seen = []
    const off = p.onChange('a', v => seen.push(v))
    off()
    p.set('a', 9)
    expect(seen).toEqual([])
  })
})

describe('paramAccess ordered pairs', () => {
  const build = (lo = 0.2, hi = 0.8) => {
    const u = { uLo: { value: lo }, uHi: { value: hi } }
    const ordered = []
    const p = paramAccess({ tables: [u], rows: [
      row('lo', 'uLo', { value: lo, pair: { with: 'hi', order: 'lo' } }),
      row('hi', 'uHi', { value: hi, pair: { with: 'lo', order: 'hi' } }),
    ] })
    // lo <= hi as it stands after EVERY individual write, partner moves included.
    p.onAnyChange(() => ordered.push(u.uLo.value <= u.uHi.value))
    return { u, p, ordered }
  }

  it('leaves the partner alone while the order holds', () => {
    const { u, p } = build()
    p.set('lo', 0.5)
    expect([u.uLo.value, u.uHi.value]).toEqual([0.5, 0.8])
  })

  it('moves the partner first when a write would cross it', () => {
    const { u, p, ordered } = build()
    p.set('lo', 0.9)
    expect([u.uLo.value, u.uHi.value]).toEqual([0.9, 0.9])
    p.set('hi', 0.1)
    expect([u.uLo.value, u.uHi.value]).toEqual([0.1, 0.1])
    expect(ordered).toEqual([true, true, true, true])
  })

  it('reaches any ordered band from any other by writing lo then hi, ordered throughout', () => {
    for (const [from, to] of [[[0.1, 0.2], [0.7, 0.9]], [[0.7, 0.9], [0.1, 0.2]], [[0.3, 0.6], [0.4, 0.5]]]) {
      const { u, p, ordered } = build(...from)
      p.set('lo', to[0])
      p.set('hi', to[1])
      expect([u.uLo.value, u.uHi.value]).toEqual(to)
      expect(ordered.every(Boolean)).toBe(true)
    }
  })

  describe('clamp', () => {
    const build = over => {
      const u = { uN: { value: 5 } }
      const p = paramAccess({ tables: [u], rows: [row('n', 'uN', { min: 2, max: 8, ...over })] })
      return { u, p }
    }

    it('true clamps a set to the row\'s [min, max]', () => {
      const { u, p } = build({ clamp: true })
      p.set('n', 99)
      expect(u.uN.value).toBe(8)
      p.set('n', -99)
      expect(u.uN.value).toBe(2)
      p.set('n', 6.5)
      expect(u.uN.value).toBe(6.5)
    })

    it('[lo, hi] bounds a value the slider range does not, and an open end stays open', () => {
      const { u, p } = build({ clamp: [0, Infinity] })
      p.set('n', -1)
      expect(u.uN.value).toBe(0)
      p.set('n', 1e6)
      expect(u.uN.value).toBe(1e6)
    })

    it('an int row rounds, then clamps; NaN lands on the lower bound', () => {
      const { u, p } = build({ encode: 'int', clamp: [1, 96] })
      p.set('n', 96.4)
      expect(u.uN.value).toBe(96)
      p.set('n', 96.6)
      expect(u.uN.value).toBe(96)
      p.set('n', NaN)
      expect(u.uN.value).toBe(1)
    })

    it('clamps before the change guard: a value that clamps to the current one changes nothing', () => {
      const { p } = build({ clamp: true })
      const seen = []
      p.onChange('n', v => seen.push(v))
      p.set('n', 8)
      p.set('n', 500)
      expect(seen).toEqual([8])
    })

    it('a row without clamp writes what it is given', () => {
      const { u, p } = build()
      p.set('n', 99)
      expect(u.uN.value).toBe(99)
    })
  })
})

describe('paramAccess export and import', () => {
  function build() {
    const u = {
      uA: { value: 1 }, uTint: { value: new THREE.Color(0x102030) }, uSun: { value: new THREE.Vector2(1, 2) },
      uOn: { value: 1 }, uDerived: { value: 0 }, uLo: { value: 0.2 }, uHi: { value: 0.6 },
    }
    let held = 5
    const rows = [
      row('a', 'uA', { value: 1 }),
      row('tint', 'uTint', { kind: 'colour', encode: 'srgb', value: '#102030' }),
      row('sun', 'uSun', { kind: 'hidden', encode: 'vec2', value: [1, 2] }),
      row('on', 'uOn', { kind: 'toggle', encode: 'float01', value: true }),
      row('lo', 'uLo', { pair: { with: 'hi', order: 'lo' } }),
      row('hi', 'uHi', { pair: { with: 'lo', order: 'hi' } }),
      row('field', undefined, { value: 5 }),
      row('test', undefined, { kind: 'hidden', value: 0, persist: false }),
    ]
    const p = paramAccess({
      tables: [u], rows,
      fields: { field: { get: () => held, set: v => { held = v } } },
      derived: [{ uniform: 'uDerived', from: ['a'], fn: read => read('a') * 10 }],
    })
    return { u, p }
  }

  it('exports every persisted row as JSON, in row order, leaving persist:false rows out', () => {
    const { p } = build()
    const out = p.export()
    expect(Object.keys(out)).toEqual(['a', 'tint', 'sun', 'on', 'lo', 'hi', 'field'])
    expect(out).toEqual({ a: 1, tint: '#102030', sun: { x: 1, y: 2 }, on: true, lo: 0.2, hi: 0.6, field: 5 })
    expect(JSON.parse(JSON.stringify(out))).toEqual(out)
  })

  it('imports through set: derived uniforms recompute and hooks fire', () => {
    const { u, p } = build()
    const seen = []
    p.onAnyChange(key => seen.push(key))
    const r = p.import({ a: 3, tint: '#ffffff', sun: { x: 0.5, y: 0.25 }, on: false, field: 9 })
    expect(r).toEqual({ applied: ['a', 'tint', 'sun', 'on', 'field'], unknown: [], rejected: [] })
    expect(u.uDerived.value).toBe(30)
    expect(u.uTint.value.getHex()).toBe(0xffffff)
    expect([u.uSun.value.x, u.uSun.value.y]).toEqual([0.5, 0.25])
    expect(u.uOn.value).toBe(0)
    expect(p.get('field')).toBe(9)
    expect(seen).toEqual(['a', 'tint', 'sun', 'on', 'field'])
  })

  it('reports a key with no row as unknown, ignores a persist:false row, rejects a wrong kind', () => {
    const { u, p } = build()
    const r = p.import({ gone: 1, test: 7, tint: 12.5 })
    expect(r.unknown).toEqual(['gone'])
    expect(r.rejected).toEqual(['tint'])
    expect(r.applied).toEqual([])
    expect(p.get('test')).toBe(0)
    expect(u.uTint.value.getHex()).toBe(0x102030)
  })

  it('restores an ordered pair whichever end is applied first', () => {
    const { p } = build()
    p.import({ lo: 0.8, hi: 0.9 })
    expect([p.get('lo'), p.get('hi')]).toEqual([0.8, 0.9])
    p.import({ lo: 0.1, hi: 0.3 })
    expect([p.get('lo'), p.get('hi')]).toEqual([0.1, 0.3])
  })

  it('round-trips into a fresh accessor', () => {
    const a = build(), b = build()
    a.p.import({ a: 2.5, tint: '#abcdef', sun: { x: 3, y: 4 }, on: false, lo: 0.1, hi: 0.2, field: 1 })
    b.p.import(JSON.parse(JSON.stringify(a.p.export())))
    expect(b.p.export()).toEqual(a.p.export())
  })

  it('names the uniforms its rows and its derived entries write', () => {
    const { p } = build()
    expect(p.rowUniforms().sort()).toEqual(['uA', 'uHi', 'uLo', 'uOn', 'uSun', 'uTint'])
    expect(p.derivedUniforms()).toEqual(['uDerived'])
  })
})
