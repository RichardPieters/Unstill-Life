import { describe, it, expect, vi } from 'vitest'
import { Audio } from '../../src/audio/audio.js'
import { AUDIO_PARAMS } from '../../src/audio/audioParams.js'
import { PaintVoice } from '../../src/audio/audioPaint.js'
import { removedNameHits } from './sourceScan.js'

// The values the soundscape shipped with, written out independently of the rows.
const SHIPPED = {
  masterGain: 0.52, windLevel: 0.7, treeLevel: 0.1, surfLevel: 1.3, breakLevel: 0.2,
  birdLevel: 0.1, paintLevel: 1.5, birdRateScale: 0.4, leafLevel: 0.7, leafFlutter: 13,
  leafTail: 1.95, leafTone: 0.76, reverbLevel: 0.8, distanceDepth: 0.6, distanceCutoff: 760,
  roomMode: false, paintEnabled: true,
}

// A built soundscape reduced to what the settings reach.
function built() {
  const a = new Audio()
  const calls = []
  const gain = name => ({ setTargetAtTime: (...args) => calls.push([name, ...args]), setValueAtTime() {} })
  a._ctx = { currentTime: 1, state: 'running' }
  a._g = {
    reverbReturn: { gain: gain('reverb') },
    master: { gain: gain('master') },
    voiceGains: { wind: { gain: gain('wind') }, birds: { gain: gain('birds') } },
    voiceSends: { wind: { gain: gain('windSend') }, birds: { gain: gain('birdsSend') } },
    paintBus: { gain: gain('paintBus') },
  }
  a._trees = {}
  for (const m of ['Level', 'Flutter', 'Tail', 'Tone']) a._trees['setLeaf' + m] = v => calls.push(['leaf' + m, v])
  return { a, calls }
}

describe('audio params', () => {
  it('start at the shipped defaults, one row per setting', () => {
    const a = new Audio()
    expect(Object.keys(SHIPPED).sort()).toEqual(AUDIO_PARAMS.map(r => r.key).sort())
    for (const [k, v] of Object.entries(SHIPPED)) expect(a.params.get(k), k).toBe(v)
  })

  it('a leaf setting reaches an already-built voice, and only the one set', () => {
    const { a, calls } = built()
    a.params.set('leafTail', 2.5)
    expect(calls).toEqual([['leafTail', 2.5]])
    a.params.set('leafLevel', 0.3); a.params.set('leafFlutter', 20); a.params.set('leafTone', 0.5)
    expect(calls.slice(1)).toEqual([['leafLevel', 0.3], ['leafFlutter', 20], ['leafTone', 0.5]])
  })

  it('a leaf setting before start only holds the value', () => {
    const a = new Audio()
    expect(() => a.params.set('leafTone', 0.1)).not.toThrow()
    expect(a.params.get('leafTone')).toBe(0.1)
  })

  it('reverb ramps the return gain', () => {
    const { a, calls } = built()
    a.params.set('reverbLevel', 1.1)
    expect(calls).toHaveLength(1)
    expect(calls[0][0]).toBe('reverb')
    expect(calls[0].slice(1, 3)).toEqual([1.1, 1])
  })

  it('bird level re-applies solo; an unrelated level does not', () => {
    const { a, calls } = built()
    a.params.set('windLevel', 1)
    expect(calls).toEqual([])
    a.params.set('birdLevel', 1.2)
    expect(calls.find(c => c[0] === 'birds')[1]).toBe(1.2)
  })

  it('master gain re-ramps the master only when unmuted', () => {
    const { a, calls } = built()
    a.params.set('masterGain', 0.3)           // muted at start: stored, no ramp
    expect(calls).toEqual([])
    a.setMuted(false)
    calls.length = 0
    a.params.set('masterGain', 0.4)
    expect(calls.filter(c => c[0] === 'master').map(c => c[1])).toEqual([0.4])
  })

  it('exports the flat { key: value } map the snapshots always held', () => {
    expect(new Audio().exportState()).toEqual(SHIPPED)
  })

  it('imports that flat map (a snapshot from before the params), into a built voice too', () => {
    const { a, calls } = built()
    const old = { ...SHIPPED, leafTail: 3, roomMode: 1, windLevel: 0.2, someFutureKey: 5 }
    expect(a.importState(old)).toEqual({ unknown: ['audio.someFutureKey'] })
    expect(a.params.get('leafTail')).toBe(3)
    expect(a.params.get('roomMode')).toBe(true)
    expect(a.params.get('windLevel')).toBe(0.2)
    expect(calls).toContainEqual(['leafTail', 3])
    expect(a.importState(null)).toEqual({ unknown: [] })
  })
})

describe('audio scene drive', () => {
  // A started soundscape whose voices only record what they were handed.
  function started(solo) {
    const a = new Audio()
    const paint = []
    const voice = { update() {}, getGust: () => 0.5 }
    a._started = true
    a._g = {}
    a._ctx = { currentTime: 0, state: 'running' }
    a._wind = voice; a._trees = voice; a._surf = voice; a._birds = voice
    a._paintVoice = { update: (dt, phase, level) => paint.push(level) }
    a._applyDistance = () => {}
    a._solo = solo
    return { a, paint }
  }

  it('the paint layer is audible with no solo or the paint soloed, and silent under any other solo', () => {
    for (const [solo, audible] of [[null, true], ['paint', true], ['wind', false], ['surf', false], ['birds', false], ['trees', false]]) {
      const { a, paint } = started(solo)
      a.setSceneState({ dt: 0.016 })
      expect(paint[0] > 0, String(solo)).toBe(audible)
    }
  })

  it('a suspended context is asked to resume once, not once per frame', () => {
    const a = new Audio()
    let calls = 0
    let settle
    a._ctx = { state: 'suspended', resume: () => { calls++; return new Promise(r => { settle = r }) } }
    a._resumeIfNeeded(); a._resumeIfNeeded(); a._resumeIfNeeded()
    expect(calls).toBe(1)
    settle()
    return Promise.resolve().then(() => Promise.resolve()).then(() => {
      a._resumeIfNeeded()
      expect(calls).toBe(2)
    })
  })
})

describe('paint cracks', () => {
  it('release their panner once the last of their sounds has ended', () => {
    const made = []
    const node = kind => {
      const n = { kind, connected: true, connect() {}, disconnect() { this.connected = false }, start() {}, stop() {},
        pan: { value: 0 }, gain: { value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} },
        frequency: { value: 0 }, Q: { value: 0 }, playbackRate: { value: 1 } }
      made.push(n)
      return n
    }
    const ctx = {
      currentTime: 0,
      createBufferSource: () => node('src'), createBiquadFilter: () => node('filter'),
      createGain: () => node('gain'), createStereoPanner: () => node('pan'),
    }
    const voice = new PaintVoice(ctx, node('dest'), { duration: 10 }, () => 0.5)
    const before = made.length
    voice.crackNow(1)
    const crack = made.slice(before)
    const pan = crack.find(n => n.kind === 'pan')
    // Creation order is snap, micro-fractures, peel; with a fixed rng the peel's
    // envelope is the longest, so it ends last.
    const sources = crack.filter(n => n.kind === 'src')
    for (const src of sources.slice(0, -1)) src.onended()
    expect(pan.connected).toBe(true)
    sources.at(-1).onended()
    expect(pan.connected).toBe(false)
  })
})

describe('removed audio methods', () => {
  it('are named nowhere in src/ or tests/', () => {
    const keys = [
      'MasterGain', 'WindLevel', 'SurfLevel', 'BreakLevel', 'BirdLevel', 'PaintLevel', 'BirdRateScale',
      'TreeVoiceLevel', 'LeafLevel', 'LeafFlutter', 'LeafTail', 'LeafTone', 'ReverbLevel', 'DistanceDepth',
      'DistanceCutoff', 'RoomMode', 'PaintEnabled',
    ]
    const names = keys.flatMap(k => ['get' + k, 'set' + k])
    // TreeVoice keeps its own setLeaf*: only a call on an `audio` receiver is stale.
    const treeVoice = names.filter(n => /^[gs]etLeaf/.test(n))
    const only = names.filter(n => !treeVoice.includes(n))
    expect(removedNameHits(only, { receiver: 'audio', names: treeVoice }, import.meta.url)).toEqual([])
  })
})
