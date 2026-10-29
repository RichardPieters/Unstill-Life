import { describe, it, expect } from 'vitest'
import { createDisplay } from '../../src/render/display.js'

function fakeRenderer() {
  const ratios = []
  return { ratios, setPixelRatio: r => ratios.push(r) }
}

describe('display owner', () => {
  it('sets the renderer to the capped device ratio at once', () => {
    const r = fakeRenderer()
    const d = createDisplay(r, () => 3)
    expect(r.ratios).toEqual([2])
    expect(d.ratio()).toBe(2)
  })

  it('a lower cap re-sets the renderer and notifies, a screen below the cap changes nothing', () => {
    const r = fakeRenderer()
    const d = createDisplay(r, () => 1.25)
    const seen = []
    d.params.onChange('pixelRatioCap', v => seen.push(v))
    d.params.set('pixelRatioCap', 1)
    expect(r.ratios.at(-1)).toBe(1)
    expect(seen).toEqual([1])
    d.params.set('pixelRatioCap', 1.5)   // above the device's own 1.25
    expect(r.ratios.at(-1)).toBe(1.25)
    expect(d.ratio()).toBe(1.25)
  })

  it('writing the held cap again does nothing', () => {
    const r = fakeRenderer()
    const d = createDisplay(r, () => 2)
    const n = r.ratios.length
    d.params.set('pixelRatioCap', 2)
    expect(r.ratios.length).toBe(n)
  })
})
