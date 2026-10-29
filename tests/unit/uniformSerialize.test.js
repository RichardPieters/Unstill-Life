import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import {
  captureUniforms, applyUniforms, namesOfClass, STATE_FORMAT,
} from '../../src/shared/uniformSerialize.js'

const num = v => ({ value: v })
const col = hex => ({ value: new THREE.Color(hex) })
const vec2 = (x, y) => ({ value: new THREE.Vector2(x, y) })
const tex = () => ({ value: new THREE.Texture() })

describe('captureUniforms', () => {
  it('encodes the named uniforms: numbers, bools, colours, vec2', () => {
    const u = { a: num(1.5), b: num(true), c: col(0x4f7d40), d: vec2(3, -2), other: num(9) }
    const s = captureUniforms([u], ['a', 'b', 'c', 'd'])
    expect(s).toEqual({ a: 1.5, b: true, c: '#4f7d40', d: { x: 3, y: -2 } })
    expect(JSON.parse(JSON.stringify(s))).toEqual(s)
  })

  it('reads each name from the first table that has it', () => {
    const shared = num(7)
    expect(captureUniforms([{ k: shared }, { k: num(8), extra: num(9) }], ['k', 'extra'])).toEqual({ k: 7, extra: 9 })
  })

  it('throws on a name no table holds or whose value cannot be JSON: a classification bug, not a gap', () => {
    expect(() => captureUniforms([{ a: num(1) }], ['gone'])).toThrow(/gone/)
    expect(() => captureUniforms([{ t: tex() }], ['t'])).toThrow(/t is not/)
    expect(() => captureUniforms([{ v: { value: new THREE.Vector3() } }], ['v'])).toThrow(/v is not/)
  })
})

describe('namesOfClass', () => {
  it('lists the names of one class in table order', () => {
    expect(namesOfClass({ a: 'frame', b: 'integrated', c: 'frame', d: 'row:x' }, 'frame')).toEqual(['a', 'c'])
  })
})

describe('applyUniforms', () => {
  it('writes values back in place without reassigning Color/Vector2 objects', () => {
    const u = { a: num(0), c: col(0x000000), d: vec2(0, 0) }
    const color = u.c.value, vec = u.d.value
    applyUniforms([u], { a: 2.5, c: '#ff8800', d: { x: 9, y: -9 } })
    expect(u.a.value).toBe(2.5)
    expect(u.c.value).toBe(color)                 // same object, mutated
    expect(color.getHexString()).toBe('ff8800')
    expect(u.d.value).toBe(vec)
    expect([vec.x, vec.y]).toEqual([9, -9])
  })

  it('routes each key to whichever table owns it (multi-material)', () => {
    const terrain = { uRidgeAmt: num(0) }
    const heightmap = { uErosionStrength: num(0) }
    applyUniforms([terrain, heightmap], { uRidgeAmt: 0.5, uErosionStrength: 0.9 })
    expect(terrain.uRidgeAmt.value).toBe(0.5)
    expect(heightmap.uErosionStrength.value).toBe(0.9)
  })

  it('reports unknown keys instead of silently dropping them', () => {
    const u = { a: num(0) }
    const { applied, unknown } = applyUniforms([u], { a: 1, uRenamedGone: 5 })
    expect(applied).toEqual(['a'])
    expect(unknown).toEqual(['uRenamedGone'])
  })

  it('rejects a value of the wrong kind: the live Color is kept, the key is not counted as applied', () => {
    const u = { c: col(0x336699), a: num(0) }
    const color = u.c.value
    const { applied, unknown, rejected } = applyUniforms([u], { c: 0.5, a: '#ffffff' })
    expect(u.c.value).toBe(color)
    expect(color.getHexString()).toBe('336699')
    expect(u.a.value).toBe(0)
    expect(applied).toEqual([])
    expect(unknown).toEqual([])
    expect(rejected.sort()).toEqual(['a', 'c'])
  })

  it('round-trips a capture back to the same capture', () => {
    const build = () => ({ a: num(0.1), b: num(false), c: col(0x123456), d: vec2(4, 5) })
    const src = build(), dst = build()
    dst.a.value = 9; dst.b.value = true; dst.c.value.set(0xffffff); dst.d.value.set(0, 0)
    const names = ['a', 'b', 'c', 'd']
    applyUniforms([dst], captureUniforms([src], names))
    expect(captureUniforms([dst], names)).toEqual(captureUniforms([src], names))
  })
})

describe('STATE_FORMAT', () => {
  it('is the marker owners stamp into their exported state', () => {
    expect(STATE_FORMAT).toBe(2)
  })
})
