import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { createSimState, SIM_PARAMS } from '../../src/shared/simState.js'

describe('sim state', () => {
  it('starts at the control bar\'s resting values: full attention, running', () => {
    const { params } = createSimState()
    expect([params.get('manualAttention'), params.get('paused')]).toEqual([1, false])
  })

  it('is not scene state: nothing is exported', () => {
    const { params } = createSimState()
    params.set('manualAttention', 0.5)
    expect(params.export()).toEqual({})
  })

  it('tells a listener when pause flips', () => {
    const { params } = createSimState()
    const seen = []
    params.onChange('paused', v => seen.push(v))
    params.set('paused', true)
    params.set('paused', true)
    params.set('paused', false)
    expect(seen).toEqual([true, false])
  })

  it('the markup ranges are the rows\' ranges', () => {
    const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8')
    for (const r of SIM_PARAMS.filter(r => r.kind === 'slider')) {
      const tag = html.match(new RegExp(`<input id="${r.id}"[^>]*>`))[0]
      const attr = n => parseFloat(tag.match(new RegExp(`${n}="([^"]*)"`))[1])
      expect([attr('min'), attr('max'), attr('step')], r.id).toEqual([r.min, r.max, r.step])
    }
  })
})
