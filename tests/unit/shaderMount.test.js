import { describe, test, expect } from 'vitest'
import { mountUniforms, injectIncludes } from '../../src/shared/shaderCompose.js'

describe('mountUniforms', () => {
  const shared = { uFrame: { value: 1 } }
  const rows = { uSize: { value: 2 }, uOther: { value: 3 } }
  const src = 'uniform sampler2D uFrame;\nuniform float uSize;\nuniform vec2 uRes;'

  test('takes each declared name from the pool that has it, as the same object', () => {
    const own = { uRes: { value: 'res' } }
    const u = mountUniforms(src, { own, shared, rows }, 'p')
    expect(Object.keys(u).sort()).toEqual(['uFrame', 'uRes', 'uSize'])
    expect(u.uFrame).toBe(shared.uFrame)
    expect(u.uSize).toBe(rows.uSize)
    expect(u.uRes).toBe(own.uRes)
  })

  test('does not mount what the shader does not declare', () => {
    expect(mountUniforms('uniform float uSize;', { rows }, 'p')).toEqual({ uSize: rows.uSize })
  })

  test('a declared name found in no pool throws', () => {
    expect(() => mountUniforms(src, { shared, rows }, 'p')).toThrow(/declares "uRes" but no uniform pool/)
  })

  test('a declared name found in two pools throws', () => {
    expect(() => mountUniforms('uniform float uSize;', { rows, shared: { uSize: { value: 0 } } }, 'p'))
      .toThrow(/"uSize" is in rows and shared/)
  })

  test('an own entry the shader does not declare throws', () => {
    expect(() => mountUniforms('uniform float uSize;', { own: { uGone: { value: 0 } }, rows }, 'p'))
      .toThrow(/"uGone" is listed as its own uniform/)
  })
})

describe('injectIncludes', () => {
  test('replaces each marker line with its include, in the shader\'s order', () => {
    const out = injectIncludes('a\n//#include two\n//#include one\nb', { one: '1', two: '2' })
    expect(out).toBe('a\n2\n1\nb')
  })

  test('an unknown include throws, and an indented marker still counts', () => {
    expect(() => injectIncludes('//#include nope', {})).toThrow(/unknown include "nope"/)
    expect(injectIncludes('  //#include x', { x: 'X' })).toBe('X')
  })
})
