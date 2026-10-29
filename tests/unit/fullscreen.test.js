import { describe, it, expect } from 'vitest'
import { inRevealZone } from '../../src/panel/fullscreen.js'

describe('fullscreen reveal zone', () => {
  it('shows the bar only near the bottom edge', () => {
    expect(inRevealZone(1079, 1080)).toBe(true)
    expect(inRevealZone(960, 1080)).toBe(true)
    expect(inRevealZone(959, 1080)).toBe(false)
    expect(inRevealZone(0, 1080)).toBe(false)
  })
})
