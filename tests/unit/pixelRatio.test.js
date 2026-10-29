import { describe, test, expect } from 'vitest'
import { removedNameHits } from './sourceScan.js'
import { cappedPixelRatio, PIXEL_RATIO_MIN } from '../../src/render/pixelRatio.js'

describe('cappedPixelRatio', () => {
  test('a Retina screen renders at the cap, not its own ratio', () => {
    expect(cappedPixelRatio(2, 1.25)).toBe(1.25)
  })
  test('a screen already at or below the cap is left alone', () => {
    expect(cappedPixelRatio(1, 1.25)).toBe(1)
    expect(cappedPixelRatio(1.25, 1.25)).toBe(1.25)
  })
  test('never drops below the floor, whatever the cap', () => {
    expect(cappedPixelRatio(2, 0.1)).toBe(PIXEL_RATIO_MIN)
    expect(cappedPixelRatio(0.25, 2)).toBe(PIXEL_RATIO_MIN)
  })
})

describe('the render-resolution cap is a display param', () => {
  test('no removed handle method remains in src/ or tests/', () => {
    expect(removedNameHits(['getPixelRatioCap', 'setPixelRatioCap', 'PIXEL_RATIO_CAP_DEFAULT'], undefined, import.meta.url)).toEqual([])
  })
})
