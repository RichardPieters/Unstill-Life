import { describe, it, expect } from 'vitest'
import { createHorizonColour, HORIZON_COLOUR_PARAMS } from '../../src/scene/horizonColour.js'
import { removedNameHits } from './sourceScan.js'

function build() {
  const calls = []
  const rec = name => ({ set: (k, v) => calls.push([name, k ?? v, v]) })
  const owners = {
    sky: { params: rec('sky') },
    fog: { color: { set: v => calls.push(['fog', v]) } },
    sceneUniforms: { params: rec('scene') },
    clouds: { params: rec('clouds') },
  }
  return { horizon: createHorizonColour(owners), calls }
}

describe('horizon', () => {
  it('one write reaches the sky, three\'s fog, the fog colour and the cloud copy', () => {
    const { horizon, calls } = build()
    horizon.params.set('hex', 0x123456)
    expect(calls).toEqual([
      ['sky', 'horizonHex', 0x123456],
      ['fog', 0x123456],
      ['scene', 'fogColor', 0x123456],
      ['clouds', 'weatherSky', 0x123456],
    ])
  })

  it('the first write fans out even when it equals the row default', () => {
    const { horizon, calls } = build()
    horizon.params.set('hex', HORIZON_COLOUR_PARAMS[0].value)
    expect(calls).toHaveLength(4)
    horizon.params.set('hex', HORIZON_COLOUR_PARAMS[0].value)
    expect(calls).toHaveLength(4)
  })

  it('forget() makes the next write fan out again, even when it equals the last one', () => {
    const { horizon, calls } = build()
    horizon.params.set('hex', 0x123456)
    horizon.forget()
    horizon.params.set('hex', 0x123456)
    expect(calls).toHaveLength(8)
  })

  it('no removed scene-set accessor remains in src/ or tests/', () => {
    const hits = removedNameHits(['(?!)'], { receiver: '(?:sceneUniforms|_scene)', names: ['set', 'get'] }, import.meta.url)
    expect(hits).toEqual([])
  })
})
