import { clamp01 } from '../shared/mathUtils.js'

/**
 * interactionMath.js — pure helpers for the microphone attention path
 * (interaction.js): mic level, spectral flux, the speaker-leak model, and the
 * restlessness → attention mapping. No DOM / AudioContext / wall-clock →
 * unit-tested.
 */

/** Attention that neither settles the scene nor wakes it: the reading with
 *  no mic, and the stand-in for a non-finite one. */
export const NEUTRAL_ATTENTION = 0.5

// ─── Level ─────────────────────────────────────────────────────────────────

/**
 * RMS and peak amplitude, [0,1], of one byte time-domain read
 * (AnalyserNode.getByteTimeDomainData: 0–255, silence at 128).
 */
export function byteWaveformLevel(bytes) {
  let sumSq = 0
  let peak = 0
  for (let i = 0; i < bytes.length; i++) {
    const s = (bytes[i] - 128) / 128
    sumSq += s * s
    if (Math.abs(s) > peak) peak = Math.abs(s)
  }
  return { rms: Math.sqrt(sumSq / bytes.length), peak }
}

/** RMS amplitude [0,1] → dBFS. Floored so rms=0 (a disconnected/silent track) stays finite. */
export function rmsToDbfs(rms) {
  return 20 * Math.log10(Math.max(rms, 1e-8))
}

/** Inverse of rmsToDbfs. */
export function dbfsToRms(db) {
  return Math.pow(10, db / 20)
}

/** A dB excess as a fraction of spanDb, clamped to [0,1]. */
export function fractionOfSpan(db, spanDb) {
  return clamp01(db / spanDb)
}

// ─── Flux ──────────────────────────────────────────────────────────────────

/**
 * Frame-to-frame spectral flux: mean positive change per bin, ignoring bins
 * that fell. Measuring change rather than level keeps the piece's own
 * momentum-driven filter sweep (audio.js) from looping back through the mic.
 * A steady sound contributes almost nothing; a voice, a step or a
 * clap does — so restlessness reads change in the room, not its loudness.
 */
export function spectralFlux(mags, prevMags) {
  let sum = 0
  for (let i = 0; i < mags.length; i++) {
    const d = mags[i] - (prevMags[i] ?? 0)
    if (d > 0) sum += d
  }
  return sum / mags.length
}

// ─── Self-noise (the installation's own speakers leaking into the mic) ─────
//
// Measured with micProbe.js: with only the sim playing, mic RMS follows the
// sim's output RMS as  mic ≈ k·master + quiet  (r² ≈ 0.96, k ≈ 1.8,
// quiet ≈ 0.0047 on the development machine). Everything below is derived from
// that one relation, so the mic reports only what the room adds on top of it.

/** Mic RMS expected from the sim's own output (`master`, RMS) plus the quiet room. */
export function predictedMicRms(master, leakGain, quietRms) {
  return leakGain * master + quietRms
}

/** How far the mic sits above the prediction, in dB. 0 = nothing but the sim and a quiet room. */
export function excessDb(micRms, predictedRms) {
  return rmsToDbfs(micRms) - rmsToDbfs(predictedRms)
}

/**
 * Share of the mic signal the prediction cannot explain, [0,1]: 0 when the
 * mic is all leak, → 1 when something far louder than the leak is present.
 * Used to scale flux — the sim's own modulation is the bulk of raw flux
 * (0.04 vs 0.001 in a silent room), and this removes that share of it.
 */
export function unexplainedFraction(micRms, predictedRms) {
  return clamp01(1 - predictedRms / Math.max(micRms, 1e-8))
}

/**
 * Value a sample-and-hold history had at time `t`: the latest entry at or
 * before it (the oldest if `t` predates them all). `history` is oldest-first
 * [{t, v}]. Models the output→air→mic delay when the reference is read now.
 */
export function valueAt(history, t) {
  if (!history.length) return 0
  let v = history[0].v
  for (let i = 0; i < history.length; i++) {
    if (history[i].t > t) break
    v = history[i].v
  }
  return v
}

// ─── Restlessness → attention ──────────────────────────────────────────────

/** Exact solution of dx/dt = (target-x)/tau over one step — frame-rate independent. */
export function emaStep(current, target, dt, tau) {
  const approach = tau > 0 ? 1 - Math.exp(-dt / tau) : 1
  return current + (target - current) * approach
}

/** Shape restlessness → attention. curve=1 linear; >1 spends more range near attention→1. */
export function restlessnessToAttention(restlessness, curve) {
  return 1 - Math.pow(clamp01(restlessness), curve)
}

/** Any non-finite input falls back to NEUTRAL_ATTENTION rather than poisoning dynamics.js. */
export function sanitiseAttention(v) {
  return Number.isFinite(v) ? clamp01(v) : NEUTRAL_ATTENTION
}
