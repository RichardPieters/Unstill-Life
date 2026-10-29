import { describe, it, expect } from 'vitest'
import { Dynamics } from '../../src/dynamics/dynamics.js'
import { AnimSpeed } from '../../src/dynamics/animSpeed.js'
import { removedNameHits } from './sourceScan.js'

const artPass = { enabled: false, isExitPlaying: () => false, holdsSceneStill: () => false, params: { get: () => 0 } }

describe('dynamics and animSpeed params', () => {
  it('shipped defaults', () => {
    const d = new Dynamics()
    expect(d.params.get('momentumTau')).toBe(8)
    expect(d.params.get('settleIntervalAtMaxAttention')).toBe(15)
    expect(d.params.get('unfreezeAttention')).toBe(0.9)
    const a = new AnimSpeed(artPass, d)
    expect([a.params.get('targetSpeed'), a.params.get('waveWeatherGain'), a.params.get('cloudWeatherGain')])
      .toEqual([0.6, 0.25, 0.65])
  })

  it('snapshots keep their flat key names, so older snapshots import', () => {
    const d = new Dynamics()
    expect(Object.keys(d.exportState()).sort())
      .toEqual(['momentumTau', 'noiseTime', 'settleIntervalAtMaxAttention', 'unfreezeAttention'])
    expect(Object.keys(new AnimSpeed(artPass, d).exportState()).sort())
      .toEqual(['cloudWeatherGain', 'targetSpeed', 'waveWeatherGain'])
    d.importState({ momentumTau: 2, noiseTime: 7 })
    expect([d.params.get('momentumTau'), d.noiseTime]).toEqual([2, 7])
  })

  it('a value the arithmetic cannot use leaves the setting alone', () => {
    const d = new Dynamics()
    for (const bad of [0, -5, NaN]) d.params.set('settleIntervalAtMaxAttention', bad)
    expect(d.params.get('settleIntervalAtMaxAttention')).toBe(15)
    const a = new AnimSpeed(artPass, d)
    a.params.set('waveWeatherGain', -1)
    expect(a.params.get('waveWeatherGain')).toBe(0)
  })

  it('no removed method name remains in src/ or tests/', () => {
    const names = ['setMomentumInertia', 'getMomentumInertia', 'setSettleIntervalAtMaxAttention',
      'getSettleIntervalAtMaxAttention', 'setUnfreezeAttention', 'getUnfreezeAttention',
      'setTargetSpeed', 'getTargetSpeed', 'setWaveWeatherGain', 'getWaveWeatherGain',
      'setCloudWeatherGain', 'getCloudWeatherGain']
    expect(removedNameHits(names, undefined, import.meta.url)).toEqual([])
  })
})
