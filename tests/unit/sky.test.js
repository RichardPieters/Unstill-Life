import { describe, it, expect, vi } from 'vitest'
import { removedNameHits } from './sourceScan.js'

// A canvas that records the gradient stops it is painted with.
function fakeDocument() {
  const stops = []
  const ctx = {
    createLinearGradient: () => ({ addColorStop: (at, css) => stops.push([at, css]) }),
    fillRect() {},
  }
  return { stops, createElement: () => ({ width: 0, height: 0, getContext: () => ctx }) }
}

async function builtSky() {
  const doc = fakeDocument()
  vi.stubGlobal('document', doc)
  const { Sky } = await import('../../src/render/sky.js')
  return { sky: new Sky(), stops: doc.stops }
}

describe('sky params', () => {
  it('a colour or reach change repaints the gradient with the new value', async () => {
    const { sky, stops } = await builtSky()
    stops.length = 0
    sky.params.set('zenithHex', 0x112233)
    expect(stops[0]).toEqual([0, '#112233'])
    stops.length = 0
    sky.params.set('reach', 0.5)
    expect(stops[1][0]).toBe(0.5)
    stops.length = 0
    sky.params.set('reach', 0.5)
    expect(stops).toEqual([])
  })

  it('reach is held in [0.05, 1], below the slider floor', async () => {
    const { sky } = await builtSky()
    sky.params.set('reach', 0)
    expect(sky.params.get('reach')).toBe(0.05)
    sky.params.set('reach', 7)
    expect(sky.params.get('reach')).toBe(1)
  })

  it('the snapshot is { reach } alone and old snapshots import', async () => {
    const { sky } = await builtSky()
    sky.importState({ reach: 0.4 })
    expect(sky.exportState()).toEqual({ reach: 0.4 })
    sky.importState({})
    expect(sky.params.get('reach')).toBe(0.4)
  })

  it('no removed method name remains in src/ or tests/', () => {
    const names = ['setHorizon', 'getHorizonHex', 'setZenith', 'getZenithHex', 'setReach', 'getReach']
    expect(removedNameHits(names, undefined, import.meta.url)).toEqual([])
  })
})
