import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { writeUniformValue, rawRgbHex } from '../../src/shared/uniformValue.js'

// The one writer every snapshot restore and param accessor goes through. The
// property that matters: a Color, Vector2 or array uniform is mutated, never
// replaced (uniforms are shared by reference between materials), and a value
// of the wrong kind leaves the uniform untouched.

describe('writeUniformValue', () => {
  it('assigns numbers and booleans to a scalar uniform, either way round', () => {
    const f = { value: 0 }, b = { value: true }
    expect(writeUniformValue(f, 2.5)).toBe(true)
    expect(f.value).toBe(2.5)
    expect(writeUniformValue(b, false)).toBe(true)
    expect(b.value).toBe(false)
    expect(writeUniformValue(f, true)).toBe(true)   // GLSL float toggles take a bool too
    expect(f.value).toBe(true)
  })

  it("mutates a Vector3 in place from '#rrggbb' as raw bytes / 255, no colour management", () => {
    const u = { value: new THREE.Vector3() }
    const vec = u.value
    expect(writeUniformValue(u, '#c8bd04')).toBe(true)
    expect(u.value).toBe(vec)
    expect([vec.x, vec.y, vec.z]).toEqual([200 / 255, 189 / 255, 4 / 255])
    expect(rawRgbHex(vec)).toBe('#c8bd04')
    for (const bad of [0xffffff, '#fff', 'c8bd04', null]) {
      expect(writeUniformValue(u, bad), String(bad)).toBe(false)
    }
    expect(rawRgbHex(vec)).toBe('#c8bd04')
  })

  it('mutates a Color in place from a hex string or a hex int', () => {
    const u = { value: new THREE.Color(0x000000) }
    const color = u.value
    expect(writeUniformValue(u, '#ff8800')).toBe(true)
    expect(u.value).toBe(color)
    expect(color.getHexString()).toBe('ff8800')
    expect(writeUniformValue(u, 0x112233)).toBe(true)
    expect(u.value).toBe(color)
    expect(color.getHexString()).toBe('112233')
  })

  it('never replaces a Color with a number: a non-hex number is rejected', () => {
    const u = { value: new THREE.Color(0x445566) }
    const color = u.value
    for (const bad of [0.5, -1, 0x1000000, NaN, true, { x: 1, y: 2 }, null]) {
      expect(writeUniformValue(u, bad), String(bad)).toBe(false)
      expect(u.value).toBe(color)
      expect(color.getHexString()).toBe('445566')
    }
  })

  it('mutates a Vector2 in place and rejects anything without numeric x/y', () => {
    const u = { value: new THREE.Vector2(0, 0) }
    const vec = u.value
    expect(writeUniformValue(u, { x: 3, y: -4 })).toBe(true)
    expect(u.value).toBe(vec)
    expect([vec.x, vec.y]).toEqual([3, -4])
    expect(writeUniformValue(u, 7)).toBe(false)
    expect(writeUniformValue(u, { x: 1 })).toBe(false)
    expect([vec.x, vec.y]).toEqual([3, -4])
  })

  it('writes arrays element-wise up to the shorter length, keeping each Color', () => {
    const nums = { value: [0, 0, 0] }
    const arr = nums.value
    expect(writeUniformValue(nums, [1, 2, 3, 4])).toBe(true)
    expect(nums.value).toBe(arr)
    expect(arr).toEqual([1, 2, 3])

    const cols = { value: [new THREE.Color(0), new THREE.Color(0)] }
    const c0 = cols.value[0]
    expect(writeUniformValue(cols, ['#010203'])).toBe(true)
    expect(cols.value[0]).toBe(c0)
    expect(c0.getHexString()).toBe('010203')
  })

  it('rejects an array whose elements all fail, and a non-array aimed at an array', () => {
    const cols = { value: [new THREE.Color(0x111111)] }
    expect(writeUniformValue(cols, [0.5])).toBe(false)
    expect(cols.value[0].getHexString()).toBe('111111')
    expect(writeUniformValue({ value: [1, 2] }, 3)).toBe(false)
  })

  it('rejects writes into slots it does not own: textures, null, Vector3, typed arrays, strings into scalars', () => {
    const tex = new THREE.Texture()
    const cases = [
      [{ value: tex }, 1],
      [{ value: null }, 1],
      [{ value: new THREE.Vector3() }, { x: 1, y: 2 }],
      [{ value: new Float32Array(3) }, [1, 2, 3]],
      [{ value: 0 }, '#ffffff'],
    ]
    for (const [u, s] of cases) {
      const before = u.value
      expect(writeUniformValue(u, s)).toBe(false)
      expect(u.value).toBe(before)
    }
  })
})
