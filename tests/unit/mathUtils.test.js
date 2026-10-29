import { describe, test, expect } from 'vitest'
import { clamp, clamp01 } from '../../src/shared/mathUtils.js'

describe('clamp', () => {
  test('passes values inside the range through unchanged', () => {
    expect(clamp(0.3, 0, 1)).toBe(0.3)
    expect(clamp(-2, -5, 5)).toBe(-2)
  })
  test('pins values outside the range to the nearer bound', () => {
    expect(clamp(-1, 0, 1)).toBe(0)
    expect(clamp(7, 2, 4)).toBe(4)
    expect(clamp(Infinity, 0, 1)).toBe(1)
    expect(clamp(-Infinity, 0, 1)).toBe(0)
  })
  test('NaN and non-numbers become the lower bound', () => {
    expect(clamp(NaN, 2, 4)).toBe(2)
    expect(clamp(undefined, 2, 4)).toBe(2)
    expect(clamp(null, -1, 1)).toBe(-1)   // Math.min/max would read null as 0
  })
})

describe('clamp01', () => {
  test('is clamp to [0, 1]', () => {
    for (const x of [-3, 0, 0.25, 1, 3, NaN, undefined, Infinity]) {
      expect(clamp01(x)).toBe(clamp(x, 0, 1))
    }
  })
})
