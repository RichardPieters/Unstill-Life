import { describe, it, expect } from 'vitest'
import { createDrivenRegistry, CLOBBERED, SCALED } from '../../src/panel/drivenRegistry.js'

describe('drivenRegistry', () => {
  it('claims nothing until a driver is active', () => {
    const r = createDrivenRegistry()
    r.declare('form', ['a', 'b'])
    expect(r.resolve().size).toBe(0)
    r.setActive('form', true)
    expect([...r.resolve().keys()]).toEqual(['a', 'b'])
  })

  it('unions overlapping claims instead of letting the last one win', () => {
    // Two drivers owning one control must not leave it to whichever ran last
    // to decide whether it looks driven.
    const r = createDrivenRegistry()
    r.declare('form', ['shared'])
    r.declare('weather', ['shared'])
    r.setActive('form', true)
    r.setActive('weather', true)
    expect(r.resolve().get('shared')).toBe(CLOBBERED)

    // Still owned while EITHER driver holds it.
    r.setActive('form', false)
    expect(r.resolve().get('shared')).toBe(CLOBBERED)
    r.setActive('weather', false)
    expect(r.resolve().has('shared')).toBe(false)
  })

  it('lets being overwritten outrank being scaled, whatever the order', () => {
    const write = order => {
      const r = createDrivenRegistry()
      for (const [driver, state] of order) r.declare(driver, ['x'], state)
      r.setActive('a', true); r.setActive('b', true)
      return r.resolve().get('x')
    }
    expect(write([['a', SCALED], ['b', CLOBBERED]])).toBe(CLOBBERED)
    expect(write([['a', CLOBBERED], ['b', SCALED]])).toBe(CLOBBERED)
  })

  it('keeps a scaled claim distinct from a clobbered one', () => {
    // A scaled control still has real authority over its own value, so it must
    // not be reported the same as one that is overwritten outright.
    const r = createDrivenRegistry()
    r.declare('density', ['intensity'], SCALED)
    r.setActive('density', true)
    expect(r.resolve().get('intensity')).toBe(SCALED)
  })

  it('reports every declared id for the guard test, active or not', () => {
    const r = createDrivenRegistry()
    r.declare('form', ['a'])
    r.declare('weather', ['b', 'a'])
    expect(r.declaredIds().sort()).toEqual(['a', 'b'])
  })

  it('ignores empty ids so a missing control cannot claim the whole panel', () => {
    const r = createDrivenRegistry()
    r.declare('form', ['a', undefined, '', null])
    r.setActive('form', true)
    expect([...r.resolve().keys()]).toEqual(['a'])
  })
})
