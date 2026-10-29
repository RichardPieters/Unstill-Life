import { describe, test, expect } from 'vitest'
import {
  percentile, linearFit, bestLag, hitRate, leakModel, summariseTake, medianDt,
} from '../../src/interaction/micProbeMath.js'
import { MicProbe, analyseMode } from '../../src/interaction/micProbe.js'

describe('percentile', () => {
  test('exact ranks and interpolation', () => {
    expect(percentile([1, 2, 3, 4, 5], 50)).toBe(3)
    expect(percentile([1, 2, 3, 4, 5], 0)).toBe(1)
    expect(percentile([1, 2, 3, 4, 5], 100)).toBe(5)
    expect(percentile([0, 10], 25)).toBeCloseTo(2.5, 12)
  })
  test('empty → NaN', () => expect(percentile([], 50)).toBeNaN())
})

describe('linearFit', () => {
  test('recovers an exact line with r² = 1', () => {
    const x = [0, 1, 2, 3, 4]
    const f = linearFit(x, x.map(v => 0.4 * v + 0.05))
    expect(f.slope).toBeCloseTo(0.4, 12)
    expect(f.intercept).toBeCloseTo(0.05, 12)
    expect(f.r2).toBeCloseTo(1, 12)
  })
  test('a symmetric (zero-slope) cloud has r² = 0', () => {
    expect(linearFit([0, 1, 2, 3, 4], [1, -1, 0, -1, 1]).r2).toBeCloseTo(0, 12)
  })
  test('constant x → NaN, not a throw', () => expect(linearFit([2, 2, 2], [1, 2, 3]).slope).toBeNaN())
})

describe('bestLag', () => {
  test('finds a known shift', () => {
    const a = Array.from({ length: 200 }, (_, i) => Math.sin(i * 0.3) + (i % 17 === 0 ? 2 : 0))
    const shift = 7
    const b = a.map((_, i) => a[i - shift] ?? 0)
    const r = bestLag(a, b, 20)
    expect(r.lag).toBe(shift)
    expect(r.corr).toBeGreaterThan(0.95)
  })
  test('flat series → corr NaN', () => expect(bestLag([1, 1, 1, 1], [2, 2, 2, 2], 2).corr).toBeNaN())
})

describe('hitRate', () => {
  test('a take entirely above the leak clears it always', () => {
    expect(hitRate([1, 2, 3, 4, 5], [10, 11, 12])).toBe(1)
  })
  test('a take drawn from the leak itself is indistinguishable (~5% over its own p95)', () => {
    const leak = Array.from({ length: 1000 }, (_, i) => (i * 7919) % 1000)
    expect(hitRate(leak, leak, 95)).toBeCloseTo(0.05, 2)
  })
})

describe('leakModel', () => {
  test('recovers gain k and the delay from a synthetic delayed leak', () => {
    const dt = 1 / 60
    const lagFrames = 6                       // 100 ms
    const masterAt = i => (Math.floor(i / 40) % 4) * 0.1 + 0.05   // stepped gain sweep
    const rows = Array.from({ length: 480 }, (_, i) => ({
      t: i * dt,
      master: masterAt(i),
      rms: 0.3 * masterAt(i - lagFrames) + 0.002,
    }))
    const m = leakModel(rows)
    expect(m.lagMs).toBeCloseTo(lagFrames * dt * 1000, -1)   // within ~5 ms
    expect(m.k).toBeGreaterThan(0.25)
    expect(m.k).toBeLessThan(0.35)
  })
})

describe('summariseTake', () => {
  test('per-metric percentiles over the take', () => {
    const rows = [1, 2, 3, 4, 5].map((v, i) => ({ t: i, micDb: -v, rms: v, flux: v, restlessness: v, master: v }))
    const s = summariseTake(rows)
    expect(s.n).toBe(5)
    expect(s.flux.p50).toBe(3)
    expect(s.micDb.max).toBe(-1)
  })
  test('medianDt of a steady series', () => {
    expect(medianDt([{ t: 0 }, { t: 0.5 }, { t: 1 }])).toBe(0.5)
  })
})

// ── protocol runner, driven by a fake mic/audio with a known leak law ──────

function fakeWorld() {
  let clock = 0
  let muted = false
  let gain = 0.52
  let talking = 0   // rms added by "the person" — set per take by the fake ask()
  const master = () => (muted ? 0 : gain)
  const interaction = {
    _active: false,
    disableMic() { this._active = false },
    async enableMic(_ctx, opts) { this._active = true; this.aec = opts.echoCancellation; return true },
    getDiagnostics() { return { appliedEchoCancellation: this.aec } },
    getSignals() {
      const rms = 0.3 * master() + talking
      return { active: this._active, rms, micDb: 20 * Math.log10(Math.max(rms, 1e-8)),
        flux: talking * 2, restlessness: talking, attention: 0.5 }
    },
  }
  const audio = {
    getOutputLevel: master,
    params: { get: () => gain, set: (_key, v) => { gain = v; muted = false } },
    setMuted(m) { muted = m },
    getAudioContext: () => ({ sampleRate: 48000 }),
  }
  const io = {
    frame: async () => { clock += 1 / 60 },
    now: () => clock,
    sleep: async () => {},
    save: () => {}, log: () => {},
    ask: async (_text, name) => { talking = { 'speech-soft': 0.02, 'speech-normal': 0.06, 'speech-loud': 0.15, claps: 0.1 }[name] ?? 0 },
  }
  return { interaction, audio, io }
}

describe('MicProbe protocol', () => {
  test('runs every take for both echo-cancellation modes and passes the setting through', async () => {
    const { interaction, audio, io } = fakeWorld()
    const r = await new MicProbe({ interaction, audio }, io).run({ seconds: 3, aecModes: [false, true] })
    expect(Object.keys(r.modes)).toEqual(['aecOff', 'aecOn'])
    expect(r.modes.aecOff.requested).toBe(false)
    expect(r.modes.aecOn.applied).toBe(true)
    for (const t of ['floor', 'leak', 'sweep', 'speech-soft', 'speech-normal', 'speech-loud', 'claps']) {
      expect(r.modes.aecOff.takes[t].rows.length).toBeGreaterThan(100)
    }
  })

  test('recovers the known leak law and ranks speech levels', async () => {
    const { interaction, audio, io } = fakeWorld()
    const r = await new MicProbe({ interaction, audio }, io).run({ seconds: 6, aecModes: [false] })
    const m = r.modes.aecOff
    expect(m.leak.k).toBeCloseTo(0.3, 2)
    expect(m.leakOverFloorDb).toBeGreaterThan(40)          // muted floor is ~-160 dB in the fake
    expect(m.levelOrder.micDb).toBe(true)
    expect(m.separation['speech-loud'].micDb).toBe(1)
  })

  test('restores gain and mute state after the run', async () => {
    const { interaction, audio, io } = fakeWorld()
    await new MicProbe({ interaction, audio }, io).run({ seconds: 3, aecModes: [false] })
    expect(audio.params.get('masterGain')).toBe(0.52)
    expect(audio.getOutputLevel()).toBe(0.52)              // not left muted
  })

  test('the sweep take steps through more than one master level', async () => {
    const { interaction, audio, io } = fakeWorld()
    const r = await new MicProbe({ interaction, audio }, io).run({ seconds: 6, aecModes: [false] })
    const levels = new Set(r.modes.aecOff.takes.sweep.rows.map(x => x.master))
    expect(levels.size).toBeGreaterThanOrEqual(5)
  })
})

describe('MicProbe persistence', () => {
  test('defaults to one pass (echo cancellation off only)', async () => {
    const { interaction, audio, io } = fakeWorld()
    const r = await new MicProbe({ interaction, audio }, io).run({ seconds: 3 })
    expect(Object.keys(r.modes)).toEqual(['aecOff'])
  })

  test('saves after each mode, so an aborted second pass keeps the first', async () => {
    const { interaction, audio, io } = fakeWorld()
    const saved = []
    io.save = (name, json) => saved.push({ name, modes: Object.keys(json.modes) })
    let asks = 0
    const ask = io.ask
    io.ask = async (...a) => { if (++asks > 7) throw new Error('user closed the tab'); return ask(...a) }
    const probe = new MicProbe({ interaction, audio }, io)
    await expect(probe.run({ seconds: 3, aecModes: [false, true] })).rejects.toThrow('closed')
    expect(saved).toHaveLength(1)
    expect(saved[0].modes).toEqual(['aecOff'])
    expect(Object.keys(probe.last.modes)).toEqual(['aecOff'])
  })
})

describe('analyseMode', () => {
  test('a sensor where speech never clears the leak reports ~5% separation', () => {
    const rows = Array.from({ length: 400 }, (_, i) => ({ t: i / 60, micDb: -40 + (i % 20), rms: 0.01, flux: 0, restlessness: 0, master: 0.5 }))
    const take = { rows, summary: summariseTake(rows) }
    const takes = { floor: take, leak: take, sweep: take, 'speech-soft': take, 'speech-normal': take, 'speech-loud': take, claps: take }
    const a = analyseMode(takes)
    expect(a.separation['speech-loud'].micDb).toBeLessThan(0.1)
    expect(a.levelOrder.micDb).toBe(false)
  })
})
