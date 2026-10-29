/**
 * interaction.js — the microphone attention sensor: how STILL and QUIET the
 * room is (not a headcount), as the attention level dynamics reads.
 *
 * SIGNAL
 *   restlessness [0,1]  room activity, eased toward its target (tau slider, 2 s)
 *   attention    [0,1]  1 − restlessness^curve (curve slider, 1.6); the neutral
 *                       0.5 whenever the mic is off, denied or not yet enabled
 *   Restlessness aims at the larger of two terms:
 *   - flux: mean positive frame-to-frame change of the 100–4000 Hz bins (voice,
 *     footsteps) × flux gain. A steady sound adds little flux, so this is the
 *     primary term. Level alone would close a loop: the piece's own filter
 *     sweep (driven by momentum in audio.js) would feed back through the mic.
 *   - level: dB above the expected mic level over a 25 dB span, so a loud but
 *     steady room (a fan, HVAC) still counts as restless.
 *
 * SPEAKER LEAK
 *   The installation's own speakers reach the mic (measured: mic RMS ≈ 1.8 ×
 *   output RMS + quiet room, r² 0.96, dev machine). Unremoved, an empty room
 *   reads as busy and the piece's own sound feeds back into its attention. The
 *   output level (setLeakSource), read 50 ms late for the trip through the air,
 *   predicts the leak; the level term counts dB above that prediction, and flux
 *   is scaled by the share of the mic signal the prediction does not explain.
 *
 * TIMING
 *   Analysis runs on its own timer, one FFT window (2048 samples, 46 ms at
 *   44.1 kHz) per step, so consecutive reads tile the signal. Not per render
 *   frame: a slow frame would leave most of the audio between frames unread.
 *
 * The debug panel reads getAttentionLevel() in Mic mode only; main.js passes
 * it on to dynamics.update().
 */
import { paramAccess } from '../shared/paramAccess.js'
import { clamp01 } from '../shared/mathUtils.js'
import { MIC_PARAMS, QUIET_RMS_DEFAULT, LEAK_HISTORY_S } from './interactionParams.js'
import {
  NEUTRAL_ATTENTION, byteWaveformLevel,
  rmsToDbfs, dbfsToRms, spectralFlux, fractionOfSpan, emaStep,
  restlessnessToAttention, sanitiseAttention,
  predictedMicRms, excessDb, unexplainedFraction, valueAt,
} from './interactionMath.js'

const FFT_SIZE = 2048             // 46 ms at 44.1 kHz; the step timer runs once per window

const MIN_QUIET_RMS = 1e-4         // keeps the quiet level (and its dB) finite if calibration reads ≤ 0
const MAX_STEP_DT_S = 0.25         // a stalled tab must not integrate one giant step
const CALIBRATE_FRAMES = 60        // ~1 s of analyser reads averaged for calibrateFloor()

// Flux is averaged across this band only — voice and footsteps. The ~4/5 of
// bins above it stay flat whatever happens in the room, and averaging over all
// 1024 dilutes a real, localised spike to a barely visible mean.
const FLUX_BAND_LO_HZ = 100
const FLUX_BAND_HI_HZ = 4000
const FLUX_HISTORY_LEN = 300       // ~13 s of steps (one per FFT window; 46 ms at 44.1 kHz, 43 ms at 48 kHz) — Mic tab graph only

export class Interaction {
  // ─── state ─────────────────────────────────────────────────────────────────

  constructor() {
    // Web Audio graph, built by enableMic().
    this._ctx = null
    this._stream = null
    this._micSource = null
    this._micSilence = null
    this._analyser = null
    this._timeBuf = null
    this._freqBuf = null
    this._prevFreq = null
    this._fluxBinLo = 0
    this._fluxBinHi = 0             // set once sampleRate is known, in enableMic()
    this._timer = null
    this._lastStepMs = 0
    this._sampleCalls = 0           // timer firings — the Mic tab's "is it running at all"
    this._pending = null            // the enableMic() in flight; a second call shares it
    this._epoch = 0                 // bumped by disableMic(): an enableMic() still awaiting its prompt gives up

    // Settings (sliders): interactionParams.js rows. The floor's state is the
    // RMS, which calibrateFloor() writes; every other row is held by the accessor.
    this._quietRms = QUIET_RMS_DEFAULT
    this.params = paramAccess({
      tables: [],
      rows: MIC_PARAMS,
      fields: {
        floorDb: {
          get: () => rmsToDbfs(this._quietRms),
          set: v => { this._quietRms = Math.max(MIN_QUIET_RMS, dbfsToRms(v)) },
        },
      },
    })

    // Leak reference.
    this._leakSource = null

    this._active = false
    this._resetSignals()
  }

  /** Signals, refreshed every step; zeroed whenever the mic starts over. */
  _resetSignals() {
    this._leakHist = []             // [{t, v}] sim output RMS, oldest first
    this._rms = 0                   // raw mic RMS — shows whether the analyser is fed at all
    this._peak = 0
    this._micDb = -Infinity
    this._predRms = 0
    this._excessDb = 0
    this._flux = 0
    this._fluxHistory = []          // oldest first — Mic tab's graph
    this._restlessness = 0          // smoothed [0,1]
    this._prevFreq?.fill(0)
  }

  /** @returns {number} attentionLevel ∈ [0,1] */
  getAttentionLevel() {
    if (!this._active) return NEUTRAL_ATTENTION
    return sanitiseAttention(restlessnessToAttention(this._restlessness, this.params.get('curve')))
  }

  /** Debug-panel readout. */
  getSignals() {
    return {
      rms: this._rms,
      peak: this._peak,
      micDb: this._micDb,
      predictedLeakRms: this._predRms,
      excessDb: this._excessDb,
      flux: this._flux,
      restlessness: this._restlessness,
      attention: this.getAttentionLevel(),
      active: this._active,
    }
  }

  /** Recent flux values, oldest first — the Mic tab's graph. Live reference; read-only. */
  getFluxHistory() {
    return this._fluxHistory
  }

  /** Wiring readout for the Mic tab's diag line (and the echo-cancellation
   *  setting the browser actually applied, for micProbe.js): when the reading
   *  is 0, which link of the chain is dead. */
  getDiagnostics() {
    const track = this._stream?.getAudioTracks?.()[0]
    return {
      sampleCalls: this._sampleCalls,
      ctxState: this._ctx?.state ?? '(no ctx)',
      hasAnalyser: !!this._analyser,
      trackLabel: track?.label ?? '(no track)',
      trackReadyState: track?.readyState ?? '—',
      trackMuted: track?.muted ?? '—',
      trackEnabled: track?.enabled ?? '—',
      appliedEchoCancellation: track?.getSettings?.().echoCancellation ?? '—',
    }
  }

  /**
   * Average ~1 s of the mic and the sim's output, and adopt what the sim's
   * leak does NOT explain as the room's quiet level. Works with the sim
   * playing — the leak is subtracted, not avoided.
   */
  async calibrateFloor() {
    if (!this._active || !this._analyser) return
    let sum = 0
    for (let i = 0; i < CALIBRATE_FRAMES; i++) {
      this._analyser.getByteTimeDomainData(this._timeBuf)
      const master = this._leakAt(performance.now() / 1000, this.params.get('leakDelayS'))
      sum += byteWaveformLevel(this._timeBuf).rms - this.params.get('leakGain') * master
      await new Promise(r => setTimeout(r, 16))
      if (!this._active) return
    }
    this._quietRms = Math.max(MIN_QUIET_RMS, sum / CALIBRATE_FRAMES)
  }

  // ─── inputs ────────────────────────────────────────────────────────────────

  /** Where the sim's own output level comes from — `() => audio.getOutputLevel()`. */
  setLeakSource(fn) { this._leakSource = fn }

  // ─── lifecycle ─────────────────────────────────────────────────────────────

  /**
   * @param {AudioContext} audioContext — the shared context (audio.js's), so
   *   analysis rides the same user gesture as the soundscape.
   * @param {{echoCancellation?: boolean}} [options] — off by default; the
   *   option exists so micProbe.js can A/B it.
   * @returns {Promise<boolean>} false on denial/unavailability — attention stays neutral.
   */
  enableMic(audioContext, options) {
    this._pending ??= this._enableMic(audioContext, options).finally(() => { this._pending = null })
    return this._pending
  }

  async _enableMic(audioContext, { echoCancellation = false } = {}) {
    this.disableMic()
    const epoch = this._epoch
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        // AGC and noise suppression stay off — they wreck the loudness axis.
        // Echo cancellation was measured unreliable at telling noise levels apart.
        audio: { autoGainControl: false, noiseSuppression: false, echoCancellation },
      })
      // Held at once, so any failure below (or a disableMic() during the
      // prompt) releases the track.
      this._stream = stream
      if (epoch !== this._epoch) { this._release(); return false }
      this._ctx = audioContext
      // A suspended context never processes audio — the analyser then reads
      // all-zero buffers forever, which is silent (no error) and looks
      // identical to "no signal reaching the mic". resume() is a no-op if
      // already running, so this is safe to call unconditionally.
      if (this._ctx.state === 'suspended') await this._ctx.resume()
      if (epoch !== this._epoch) return false
      this._analyser = this._ctx.createAnalyser()
      this._analyser.fftSize = FFT_SIZE
      this._analyser.smoothingTimeConstant = 0   // we run our own dt-scaled EMA
      // Kept on `this` — an unreferenced MediaStreamAudioSourceNode can be
      // garbage-collected in some browsers even while connected, silently
      // freezing the analyser at whatever it last read.
      this._micSource = this._ctx.createMediaStreamSource(stream)
      this._micSource.connect(this._analyser)
      // Web Audio's graph is pulled from the destination backward — a node
      // with no path to the destination isn't guaranteed to be processed at
      // all in every engine, so a dead-ended analyser can sit at all-zero
      // buffers forever even with a live, unmuted track feeding it. Route it
      // through a silent (gain 0) node into the destination instead.
      this._micSilence = this._ctx.createGain()
      this._micSilence.gain.value = 0
      this._analyser.connect(this._micSilence)
      this._micSilence.connect(this._ctx.destination)
      // Byte (not Float32) reads: WebKit has a long-standing bug where
      // getFloatTimeDomainData()/getFloatFrequencyData() silently return all
      // zeros on an otherwise correctly wired, actively-processing graph.
      // The Uint8 APIs don't share it and are precise enough here: flux only
      // needs relative change, not absolute dB.
      this._timeBuf = new Uint8Array(this._analyser.fftSize)
      this._freqBuf = new Uint8Array(this._analyser.frequencyBinCount)
      this._prevFreq = new Uint8Array(this._analyser.frequencyBinCount)
      const hzPerBin = this._ctx.sampleRate / this._analyser.fftSize
      this._fluxBinLo = Math.max(0, Math.round(FLUX_BAND_LO_HZ / hzPerBin))
      this._fluxBinHi = Math.min(this._freqBuf.length, Math.round(FLUX_BAND_HI_HZ / hzPerBin))
      this._active = true
      this._lastStepMs = performance.now()
      this._timer = setInterval(() => this._step(), Math.round((1000 * FFT_SIZE) / this._ctx.sampleRate))
      return true
    } catch (e) {
      console.warn('Mic unavailable, staying on manual/fallback attention:', e)
      this.disableMic()
      return false
    }
  }

  /** Stops the analysis, releases the mic track (the OS mic indicator goes off) and zeroes the signals. */
  disableMic() {
    this._epoch++
    this._release()
    this._resetSignals()
  }

  /** Stops the timer and tears down the audio chain and the mic track. */
  _release() {
    this._active = false
    clearInterval(this._timer)
    this._timer = null
    if (this._micSource) { this._micSource.disconnect(); this._micSource = null }
    if (this._micSilence) { this._micSilence.disconnect(); this._micSilence = null }
    if (this._analyser) { this._analyser.disconnect(); this._analyser = null }
    if (this._stream) { this._stream.getTracks().forEach(t => t.stop()); this._stream = null }
  }

  // ─── private: one analysis step, driven by the mic's own timer ─────────────

  _step() {
    this._sampleCalls++
    if (!this._active || !this._analyser) return
    const nowMs = performance.now()
    const dt = Math.min(MAX_STEP_DT_S, (nowMs - this._lastStepMs) / 1000)
    this._lastStepMs = nowMs

    this._stepLevel(nowMs / 1000)
    this._stepFlux()
    this._stepRestlessness(dt)
  }

  /** Mic level, and how far it sits above what the sim's own leak plus a quiet room predict. */
  _stepLevel(nowS) {
    this._analyser.getByteTimeDomainData(this._timeBuf)
    const { rms, peak } = byteWaveformLevel(this._timeBuf)
    this._rms = rms
    this._peak = peak
    this._micDb = rmsToDbfs(rms)

    const master = this._delayedMaster(nowS, this.params.get('leakDelayS'))
    this._predRms = predictedMicRms(master, this.params.get('leakGain'), this._quietRms)
    this._excessDb = excessDb(rms, this._predRms)
  }

  /** In-band spectral flux, with the share the leak explains removed. Needs _stepLevel first. */
  _stepFlux() {
    this._analyser.getByteFrequencyData(this._freqBuf)
    // Byte magnitudes (0–255) are already a monotonic loudness-per-bin proxy —
    // flux only needs relative frame-to-frame change, not calibrated dB.
    const band = this._freqBuf.subarray(this._fluxBinLo, this._fluxBinHi)
    const prevBand = this._prevFreq.subarray(this._fluxBinLo, this._fluxBinHi)
    // The sim's own modulation is most of raw flux; scaling by the unexplained
    // share removes that part of it.
    this._flux = (spectralFlux(band, prevBand) / 255) * unexplainedFraction(this._rms, this._predRms)
    this._prevFreq.set(this._freqBuf)
    this._fluxHistory.push(this._flux)
    if (this._fluxHistory.length > FLUX_HISTORY_LEN) this._fluxHistory.shift()
  }

  /** Ease restlessness toward the larger of the flux and level terms. */
  _stepRestlessness(dt) {
    // Level counts dB above (sim leak + quiet room), so the floor slider means
    // "the room's quiet level" without the installation's own sound.
    const levelRestlessness = fractionOfSpan(this._excessDb, this.params.get('spanDb'))
    const target = Math.max(this._flux * this.params.get('fluxGain'), levelRestlessness)
    this._restlessness = emaStep(this._restlessness, clamp01(target), dt, this.params.get('tau'))
  }

  /** Records the sim's current output level and returns the level `delaySeconds` ago (0 with no source wired). */
  _delayedMaster(nowS, delaySeconds) {
    if (!this._leakSource) return 0
    this._leakHist.push({ t: nowS, v: this._leakSource() })
    while (this._leakHist.length > 1 && this._leakHist[0].t < nowS - LEAK_HISTORY_S) this._leakHist.shift()
    return this._leakAt(nowS, delaySeconds)
  }

  /** The sim's output level `delaySeconds` before `nowS`, from the recorded history. */
  _leakAt(nowS, delaySeconds) {
    return valueAt(this._leakHist, nowS - delaySeconds)
  }
}
