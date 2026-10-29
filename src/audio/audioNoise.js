/**
 * audioNoise.js — the raw material: looping noise beds and the reverb impulse.
 *
 * Everything the soundscape is built from starts as noise, so the quality of
 * these buffers sets the ceiling for the whole system. Both generators run
 * ONCE at start() and are then read by every voice; nothing here is called
 * per frame.
 *
 * Owned by audio.js (the terrain.js → terrainGeometry.js shape: a factory
 * module the facade calls at construction, holding no state of its own).
 */

import { rt60ToTau } from './audioMath.js'

const NOISE_SECONDS  = 28      // long enough that the LF layers don't "breathe"
const SEAM_FADE_S    = 0.4     // head/tail crossfade window
const HP_CUTOFF_HZ   = 30

/**
 * Pink noise (−3 dB/octave) via Paul Kellet's economy IIR over white noise.
 *
 * Pink rather than white because every natural source here — wind, surf, the
 * body of a break — has falling energy with frequency; starting from white and
 * filtering it per voice would burn a filter stage on each voice to reach the
 * same place.
 */
function fillPink(out, rng) {
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0
  for (let i = 0; i < out.length; i++) {
    const w = rng() * 2 - 1
    b0 = 0.99886 * b0 + w * 0.0555179
    b1 = 0.99332 * b1 + w * 0.0750759
    b2 = 0.96900 * b2 + w * 0.1538520
    b3 = 0.86650 * b3 + w * 0.3104856
    b4 = 0.55000 * b4 + w * 0.5329522
    b5 = -0.7616 * b5 - w * 0.0168980
    const pink = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362
    b6 = w * 0.115926
    out[i] = pink * 0.11
  }
}

/** One-pole high-pass, in place. Removes the DC and sub-audio wander the pink
 *  filter accumulates — without it the loop seam is a step, not a join. */
function highPass(buf, sampleRate, cutoffHz) {
  const rc = 1 / (2 * Math.PI * cutoffHz)
  const a = rc / (rc + 1 / sampleRate)
  let prevIn = buf[0], prevOut = 0
  for (let i = 0; i < buf.length; i++) {
    const x = buf[i]
    prevOut = a * (prevOut + x - prevIn)
    prevIn = x
    buf[i] = prevOut
  }
}

/**
 * Make the buffer genuinely loop-continuous by crossfading its tail into its
 * head, then trimming the faded region off the end.
 *
 * Web Audio does no interpolation at a loop point: whatever discontinuity sits
 * between the last and first sample is a step, and a step is a click — once
 * per loop, per source, forever. With several sources running that is an
 * audible tick every second or so, and it is the single most common way a
 * noise-bed soundscape gives itself away.
 */
function sealLoop(buf, sampleRate) {
  const fade = Math.min(Math.floor(SEAM_FADE_S * sampleRate), Math.floor(buf.length / 4))
  const usable = buf.length - fade
  for (let i = 0; i < fade; i++) {
    const t = i / fade
    // Equal-power blend of the tail into the head, so the crossfaded region
    // keeps the same RMS as the rest of the buffer.
    const a = Math.cos(t * Math.PI / 2)
    const b = Math.sin(t * Math.PI / 2)
    buf[i] = buf[i] * b + buf[usable + i] * a
  }
  return usable
}

/**
 * Build N INDEPENDENT looping pink-noise buffers.
 *
 * Independent, not one buffer read at different playbackRates: detuning the
 * same waveform gives correlated copies that produce comb notches and slow
 * phasing when summed, and whose read positions periodically realign. Separate
 * buffers are the only way two beds are genuinely uncorrelated.
 *
 * @param {AudioContext} ctx
 * @param {number} count how many independent beds are needed
 * @param {() => number} rng
 */
export function createNoiseBuffers(ctx, count, rng) {
  const buffers = []
  for (let n = 0; n < count; n++) {
    const raw = new Float32Array(Math.floor(NOISE_SECONDS * ctx.sampleRate))
    fillPink(raw, rng)
    highPass(raw, ctx.sampleRate, HP_CUTOFF_HZ)
    const usable = sealLoop(raw, ctx.sampleRate)

    const buffer = ctx.createBuffer(1, usable, ctx.sampleRate)
    buffer.copyToChannel(raw.subarray(0, usable), 0)
    buffers.push(buffer)
  }
  return buffers
}

/**
 * Synthesize a stereo reverb impulse response — decaying noise, darkening as
 * it decays, with the two channels independent so the tail has width.
 *
 * RT60 is short by hall standards on purpose: this reverb is a DISTANCE cue,
 * not a room. It exists so a far bird sits behind the near ones and so the
 * world can be pushed away when the painting arrives — a long tail would read
 * as a cathedral and would smear the surf.
 */
export function createImpulseResponse(ctx, rng, rt60 = 1.4) {
  const length = Math.max(1, Math.floor(rt60 * ctx.sampleRate))
  const ir = ctx.createBuffer(2, length, ctx.sampleRate)
  const tau = rt60ToTau(rt60)

  for (let ch = 0; ch < 2; ch++) {
    const data = ir.getChannelData(ch)
    // One-pole state per channel: the tail loses its top end as it decays,
    // the way air and surfaces actually absorb.
    let lp = 0
    for (let i = 0; i < length; i++) {
      const t = i / ctx.sampleRate
      const env = Math.exp(-t / tau)
      const white = rng() * 2 - 1
      // Darken progressively: the smoothing coefficient rises with time.
      const k = 0.25 + 0.7 * (1 - env)
      lp += (white - lp) * (1 - k)
      data[i] = lp * env
    }
  }
  return ir
}
