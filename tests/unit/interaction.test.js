import { describe, test, expect, vi } from 'vitest'
import { Interaction } from '../../src/interaction/interaction.js'
import { removedNameHits } from './sourceScan.js'

// Interface contract for the fallback path — the mic path needs a real
// AudioContext/getUserMedia and is covered by interactionMath.test.js's pure
// helpers instead.

describe('interaction interface contract (mic inactive/unavailable)', () => {
  test('getAttentionLevel returns a number', () => {
    const i = new Interaction()
    expect(typeof i.getAttentionLevel()).toBe('number')
  })

  test('getAttentionLevel returns value in [0, 1]', () => {
    const i = new Interaction()
    const v = i.getAttentionLevel()
    expect(v).toBeGreaterThanOrEqual(0)
    expect(v).toBeLessThanOrEqual(1)
  })

  test('before enableMic(), returns the neutral fallback (0.5)', () => {
    const i = new Interaction()
    expect(i.getAttentionLevel()).toBe(0.5)
  })

  test('a step before enableMic() is a no-op, not a throw', () => {
    const i = new Interaction()
    expect(() => i._step()).not.toThrow()
  })
})

// ── analysis step against a fake analyser: leak removal ────────────────────

function fakeMic({ micRms, master }) {
  const i = new Interaction()
  i._active = true
  i._timeBuf = new Uint8Array(2048)
  i._freqBuf = new Uint8Array(1024)
  i._prevFreq = new Uint8Array(1024)
  i._fluxBinLo = 2
  i._fluxBinHi = 90
  i._analyser = {
    disconnect() {},
    getByteTimeDomainData(buf) {
      // ±micRms square wave → exactly that RMS
      for (let k = 0; k < buf.length; k++) buf[k] = 128 + (k % 2 ? 1 : -1) * Math.round(micRms * 128)
    },
    getByteFrequencyData(buf) {
      // a spectrum that jumps every call, so raw flux is non-zero
      i._toggle = !i._toggle
      buf.fill(i._toggle ? 10 : 0)   // raw flux ≈ 0.02 per step, the size a real sim's own modulation produces
    },
  }
  i.setLeakSource(() => master)
  i._lastStepMs = performance.now() - 50
  return i
}

function run(i, steps) {
  for (let n = 0; n < steps; n++) { i._lastStepMs = performance.now() - 50; i._step() }
  return i.getSignals()
}

describe('interaction leak removal', () => {
  test('the same mic signal reads as empty when the sim explains it, busy when it does not', () => {
    const master = 0.01
    const micRms = new Interaction().params.get('leakGain') * master + 0.0047   // exactly the predicted leak
    const mic = fakeMic({ micRms, master })
    const micNoSim = fakeMic({ micRms, master: 0 })                     // same mic, but the sim was silent
    const explained = { ...run(mic, 150), __mic: mic }
    const unexplained = { ...run(micNoSim, 150), __mic: micNoSim }
    expect(Math.abs(explained.excessDb)).toBeLessThan(1)               // 8-bit quantisation only
    const meanFlux = m => m.getFluxHistory().reduce((a, b) => a + b, 0) / m.getFluxHistory().length
    expect(meanFlux(explained.__mic)).toBeLessThan(0.1 * meanFlux(unexplained.__mic))   // the sim's own modulation is removed
    expect(explained.restlessness).toBeLessThan(0.5 * unexplained.restlessness)
  })

  test('a mic far louder than the leak still registers (a clap is not filtered away)', () => {
    const s = run(fakeMic({ micRms: 0.18, master: 0.005 }), 150)
    expect(s.excessDb).toBeGreaterThan(20)
    expect(s.restlessness).toBeGreaterThan(0.8)   // level term alone: ~22 dB over a 25 dB span
  })

  test('restlessness never exceeds 1', () => {
    const j = fakeMic({ micRms: 0.5, master: 0 })
    for (let n = 0; n < 200; n++) { j._lastStepMs = performance.now() - 250; j._step() }
    expect(j.getSignals().restlessness).toBeLessThanOrEqual(1)
  })

  test('leak gain and delay round-trip, and delay stays inside the history length', () => {
    const i = new Interaction()
    i.params.set('leakGain', 2.5)
    i.params.set('leakDelayS', 0.12)
    expect(i.params.get('leakGain')).toBe(2.5)
    expect(i.params.get('leakDelayS')).toBeCloseTo(0.12, 12)
    i.params.set('leakDelayS', 30)
    expect(i.params.get('leakDelayS')).toBeLessThanOrEqual(0.3)
  })

  test('floor slider still means "quiet level in dB"', () => {
    const i = new Interaction()
    i.params.set('floorDb', -40)
    expect(i.params.get('floorDb')).toBeCloseTo(-40, 9)
  })

  test('the floor starts at the measured quiet level, and calibration state reads back in dB', () => {
    const i = new Interaction()
    expect(i._quietRms).toBe(0.0047)
    expect(i.params.get('floorDb')).toBeCloseTo(20 * Math.log10(0.0047), 12)
  })
})

describe('interaction settings stay inside what the arithmetic needs', () => {
  const keys = ['floorDb', 'spanDb', 'tau', 'curve', 'fluxGain', 'leakGain', 'leakDelayS']
  test('hostile input never leaves a non-finite setting, a divisor or exponent <= 0, or a negative gain', () => {
    const i = new Interaction()
    for (const bad of [NaN, Infinity, -Infinity, 0, -3]) {
      for (const k of keys) i.params.set(k, bad)
      for (const k of keys) expect(Number.isFinite(i.params.get(k)), `${k} ${bad}`).toBe(true)
      expect(i.params.get('spanDb')).toBeGreaterThan(0)
      expect(i.params.get('curve')).toBeGreaterThan(0)
      for (const k of ['tau', 'fluxGain', 'leakGain', 'leakDelayS']) expect(i.params.get(k)).toBeGreaterThanOrEqual(0)
    }
  })

  test('the mic rows are not scene state: none is exported', () => {
    expect(new Interaction().params.export()).toEqual({})
  })
})

describe('removed interaction and fly-camera methods', () => {
  test('are named nowhere in src/ or tests/', () => {
    const only = [
      'getFloorDb', 'setFloorDb', 'getSpanDb', 'setSpanDb', 'getTau', 'setTau', 'getCurve', 'setCurve',
      'getFluxGain', 'setFluxGain', 'getLeakGain', 'setLeakGain', 'getLeakDelayS', 'setLeakDelayS',
    ]
    expect(removedNameHits(only, { receiver: '(?:fly|flyCamera|fc|cam)', names: ['setEnabled'] }, import.meta.url)).toEqual([])
  })
})

// ── lifecycle against a fake mic and audio context ─────────────────────────

function fakeAudio({ failAt } = {}) {
  const track = { stopped: false, stop() { this.stopped = true } }
  const stream = { getTracks: () => [track] }
  const node = () => ({ connect() {}, disconnect() {}, gain: {} })
  const ctx = {
    state: 'running', sampleRate: 44100, destination: {},
    createAnalyser: () => {
      if (failAt === 'analyser') throw new Error('no analyser')
      return { ...node(), fftSize: 0, frequencyBinCount: 1024 }
    },
    createMediaStreamSource: () => node(),
    createGain: () => node(),
  }
  return { ctx, stream, track }
}

describe('interaction mic lifecycle', () => {
  test('a failure while building the audio chain releases the mic track', async () => {
    const { ctx, stream, track } = fakeAudio({ failAt: 'analyser' })
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => stream } })
    const i = new Interaction()
    expect(await i.enableMic(ctx)).toBe(false)
    expect(track.stopped).toBe(true)
    expect(i.getSignals().active).toBe(false)
    vi.unstubAllGlobals()
  })

  test('disableMic during the permission prompt releases the track and stays off', async () => {
    const { ctx, stream, track } = fakeAudio()
    let grant
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: () => new Promise(r => { grant = r }) } })
    const i = new Interaction()
    const pending = i.enableMic(ctx)
    i.disableMic()
    grant(stream)
    expect(await pending).toBe(false)
    expect(track.stopped).toBe(true)
    expect(i.getSignals().active).toBe(false)
    vi.unstubAllGlobals()
  })

  test('a second enableMic during the prompt shares the first one', async () => {
    const { ctx, stream } = fakeAudio()
    const getUserMedia = vi.fn(async () => stream)
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })
    const i = new Interaction()
    const [a, b] = await Promise.all([i.enableMic(ctx), i.enableMic(ctx)])
    expect(a && b).toBe(true)
    expect(getUserMedia).toHaveBeenCalledTimes(1)
    i.disableMic()
    vi.unstubAllGlobals()
  })

  test('disabling clears the signals, so a re-enable starts from rest', async () => {
    const i = fakeMic({ micRms: 0.3, master: 0 })
    run(i, 20)
    expect(i.getSignals().restlessness).toBeGreaterThan(0)
    i.disableMic()
    const s = i.getSignals()
    expect(s.restlessness).toBe(0)
    expect(s.flux).toBe(0)
    expect(i.getFluxHistory()).toEqual([])
  })
})
