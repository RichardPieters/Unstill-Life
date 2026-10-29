/**
 * micProbe.js — guided measurement of the mic's self-noise: how much of what
 * the mic hears is the sim's OWN audio, how that scales with output level, how
 * late it arrives, and whether quiet / normal / loud human sound can still be
 * told apart from it — with browser echo cancellation off and, optionally, on.
 * Its sweep take is where interaction.js's leak gain and quiet level come from.
 *
 * USE  Dev tool, no debug-panel control: `await __d.micProbe.run()` from the
 * console (Mic source on or off — the probe manages the mic itself and restores
 * it afterwards). An overlay walks through the takes; then it prints a summary
 * and downloads a JSON with every frame.
 *
 * It reads the same signals the attention path uses (`interaction.getSignals()`
 * and `audio.getOutputLevel()`), so it measures what dynamics actually sees.
 */
import { summariseTake, hitRate, leakModel } from './micProbeMath.js'

const DEFAULT_TAKE_S = 20
const COUNTDOWN_S = 3
const SWEEP_GAINS = [0.1, 0.2, 0.35, 0.52, 0.7, 0.9]   // absolute masterGain steps

// name → what the person should do. `sim`: 'on' | 'off' (muted) | 'sweep'.
const TAKES = [
  { name: 'floor',         sim: 'off',   ask: 'Stay silent. The sim is MUTED for this take (true room floor).' },
  { name: 'leak',          sim: 'on',    ask: 'Stay silent. Sim plays normally — everything the mic hears is leak.' },
  { name: 'sweep',         sim: 'sweep', ask: 'Stay silent. Sim volume steps up and down on its own.' },
  { name: 'speech-soft',   sim: 'on',    ask: 'Speak SOFTLY, steadily, at your usual seat distance (~1 m).' },
  { name: 'speech-normal', sim: 'on',    ask: 'Speak at NORMAL conversation volume, steadily, ~1 m.' },
  { name: 'speech-loud',   sim: 'on',    ask: 'Speak LOUDLY, steadily, ~1 m.' },
  { name: 'claps',         sim: 'on',    ask: 'Clap once every ~2 seconds.' },
]

const realFrame = () => new Promise(r => requestAnimationFrame(r))
const realSleep = ms => new Promise(r => setTimeout(r, ms))

export class MicProbe {
  /**
   * @param {{interaction, audio}} deps
   * @param {object} [io] — injectable for tests: `ask(text, name)` resolves when
   *   the person is ready; `frame()` resolves once per frame; `now()` seconds;
   *   `sleep(ms)`; `save(name, json)`; `log(...)`.
   */
  constructor({ interaction, audio }, io = {}) {
    this._interaction = interaction
    this._audio = audio
    this._ask = io.ask ?? overlayAsk
    this._frame = io.frame ?? realFrame
    this._sleep = io.sleep ?? realSleep
    this._now = io.now ?? (() => performance.now() / 1000)
    this._save = io.save ?? downloadJson
    this._log = io.log ?? ((...a) => console.log(...a))
    this.last = null   // most recent (possibly partial) result — `__d.micProbe.last`
  }

  /** One frame's readout: what interaction.js and audio.js report right now. */
  _row(t0) {
    const s = this._interaction.getSignals()
    return {
      t: this._now() - t0,
      micDb: s.micDb, rms: s.rms, flux: s.flux, restlessness: s.restlessness,
      attention: s.attention, master: this._audio.getOutputLevel(),
      gain: this._audio.params.get('masterGain'),
    }
  }

  /** Collect one row per frame for `seconds`; `onFrame(elapsed)` lets a take drive the sim. */
  async record(seconds, onFrame) {
    const rows = []
    const t0 = this._now()
    while (this._now() - t0 < seconds) {
      await this._frame()
      onFrame?.(this._now() - t0)
      rows.push(this._row(t0))
    }
    return rows
  }

  async _runTake(take, seconds) {
    const a = this._audio
    const gain0 = a.params.get('masterGain')
    a.setMuted(take.sim === 'off')
    let stepIdx = -1
    const drive = take.sim === 'sweep'
      ? (elapsed) => {
          const i = Math.min(SWEEP_GAINS.length - 1, Math.floor(elapsed / (seconds / SWEEP_GAINS.length)))
          if (i !== stepIdx) { stepIdx = i; a.params.set('masterGain', SWEEP_GAINS[i]) }
        }
      : undefined
    try {
      return await this.record(seconds, drive)
    } finally {
      a.params.set('masterGain', gain0)   // stored only while muted —
      a.setMuted(false)        // unmuting applies it
    }
  }

  /** Full protocol for one echo-cancellation setting. */
  async _runMode(echoCancellation, seconds) {
    const i = this._interaction
    const ctx = this._audio.getAudioContext()
    i.disableMic()
    const ok = await i.enableMic(ctx, { echoCancellation })
    if (!ok) throw new Error('mic unavailable — allow microphone access and retry')
    const applied = i.getDiagnostics().appliedEchoCancellation
    await this._sleep(1000)   // let the analyser fill before the first take

    const takes = {}
    for (const take of TAKES) {
      await this._ask(`[echoCancellation ${echoCancellation ? 'ON' : 'OFF'}, applied=${applied}] ${take.ask}`, take.name)
      const rows = await this._runTake(take, seconds)
      takes[take.name] = { rows, summary: summariseTake(rows) }
    }
    return { requested: echoCancellation, applied, takes, ...analyseMode(takes) }
  }

  /**
   * Run the guided protocol. `aecModes`: which echo-cancellation settings to
   * run (default just OFF; pass [false, true] to A/B — doubles the takes).
   * After EACH mode the result so far is kept on `this.last` and downloaded as
   * JSON, so an aborted run still leaves the finished modes behind.
   */
  async run({ seconds = DEFAULT_TAKE_S, aecModes = [false] } = {}) {
    const wasActive = this._interaction.getSignals().active
    const result = {
      meta: {
        when: new Date().toISOString(),
        userAgent: navigator.userAgent,
        sampleRate: this._audio.getAudioContext()?.sampleRate,
        outputLatencyS: this._audio.getAudioContext()?.outputLatency,
        baseLatencyS: this._audio.getAudioContext()?.baseLatency,
        masterGain: this._audio.params.get('masterGain'),
        takeSeconds: seconds,
      },
      modes: {},
    }
    try {
      const stamp = Date.now()
      for (const aec of aecModes) {
        result.modes[aec ? 'aecOn' : 'aecOff'] = await this._runMode(aec, seconds)
        this.last = result
        this._save(`micprobe-${stamp}-${Object.keys(result.modes).join('+')}.json`, result)
      }
    } finally {
      if (typeof document !== 'undefined') document.querySelectorAll('[data-micprobe]').forEach(n => n.remove())
      this._interaction.disableMic()
      if (wasActive) await this._interaction.enableMic(this._audio.getAudioContext())
    }
    this._log(formatSummary(result))
    return result
  }
}

/**
 * Per-mode derived numbers.
 * leak — mic-vs-master fit and delay (from the sweep take).
 * separation[take] — per metric, the fraction of that take's frames above the
 *   silent-sim take's p95: does human sound clear the sim's own leak?
 * levelOrder — do the three speech takes rank soft < normal < loud in p50
 *   micDb / flux (a sensor that cannot tell noise levels apart fails here).
 */
export function analyseMode(takes) {
  const leakRows = takes.leak.rows
  const col = (rows, k) => rows.map(r => r[k])
  const separation = {}
  for (const name of ['speech-soft', 'speech-normal', 'speech-loud', 'claps']) {
    separation[name] = {}
    for (const m of ['micDb', 'flux', 'restlessness']) {
      separation[name][m] = hitRate(col(leakRows, m), col(takes[name].rows, m))
    }
  }
  const p50 = (name, m) => takes[name].summary[m].p50
  const ranks = m => p50('speech-soft', m) < p50('speech-normal', m) && p50('speech-normal', m) < p50('speech-loud', m)
  return {
    leak: leakModel(takes.sweep.rows),
    leakOverFloorDb: takes.leak.summary.micDb.p50 - takes.floor.summary.micDb.p50,
    separation,
    levelOrder: { micDb: ranks('micDb'), flux: ranks('flux'), restlessness: ranks('restlessness') },
  }
}

/** Compact console readout of a result. */
export function formatSummary(result) {
  const f = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '—')
  const lines = ['=== mic probe ===']
  for (const [mode, m] of Object.entries(result.modes)) {
    lines.push(`\n[${mode}] requested=${m.requested} applied=${m.applied}`)
    lines.push(`  sim leak sits ${f(m.leakOverFloorDb, 1)} dB above the muted room floor`)
    lines.push(`  leak model: mic_rms = ${f(m.leak.k, 3)}·master_rms + ${f(m.leak.c, 4)}  (r²=${f(m.leak.r2)}, delay ≈ ${f(m.leak.lagMs, 0)} ms, corr ${f(m.leak.lagCorr)})`)
    lines.push('  frames above the silent-sim p95 (1 = human always clears the leak, 0.05 = indistinguishable):')
    for (const [name, s] of Object.entries(m.separation)) {
      lines.push(`    ${name.padEnd(14)} level ${f(s.micDb)}  flux ${f(s.flux)}  restlessness ${f(s.restlessness)}`)
    }
    lines.push(`  soft<normal<loud ordering held: level ${m.levelOrder.micDb}, flux ${m.levelOrder.flux}, restlessness ${m.levelOrder.restlessness}`)
  }
  return lines.join('\n')
}

// ─── browser-only I/O (replaced in tests) ─────────────────────────────────

/** Overlay with the instruction + a Start button, then a 3-2-1 countdown. */
function overlayAsk(text, name) {
  return new Promise(resolve => {
    document.querySelectorAll('[data-micprobe]').forEach(n => n.remove())
    const box = document.createElement('div')
    box.dataset.micprobe = ''
    box.style.cssText = 'position:fixed;left:50%;top:16px;transform:translateX(-50%);z-index:99999;' +
      'max-width:min(560px,90vw);padding:14px 18px;border-radius:10px;background:#111e;color:#fff;' +
      'font:15px/1.4 system-ui;box-shadow:0 4px 24px #0008;text-align:center'
    const msg = document.createElement('div')
    msg.textContent = `Take "${name}": ${text}`
    const btn = document.createElement('button')
    btn.textContent = 'Start take'
    btn.style.cssText = 'margin-top:10px;padding:6px 16px;font:inherit;cursor:pointer'
    box.append(msg, btn)
    document.body.appendChild(box)
    btn.onclick = async () => {
      btn.disabled = true
      for (let s = COUNTDOWN_S; s > 0; s--) { btn.textContent = `starting in ${s}…`; await realSleep(1000) }
      btn.textContent = 'recording — do it now'
      resolve()   // box stays up so the instruction is visible; the next ask / run() end removes it
    }
  })
}

function downloadJson(filename, obj) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(obj)], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url; a.download = filename
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
