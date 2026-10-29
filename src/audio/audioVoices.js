/**
 * audioVoices.js — the natural voices: wind, trees, surf, birds.
 *
 * Each owns its own corner of the graph, is handed the destination it plays
 * into, and exposes `update(dt, scene)` plus its one-shots for the debug
 * audition (`gustNow`, `breakNow`, `call`). None of them reads the scene
 * directly — audio.js hands them the values — and none knows the others
 * exist; the trees get the wind's gust through audio.js.
 *
 * Pure arithmetic (the gust walk, the swell envelope, the rate maps, the
 * Schmitt trigger) lives in audioMath.js and is unit-tested there; what is
 * here is the Web Audio plumbing that arithmetic drives.
 */

import { clamp, clamp01 } from '../shared/mathUtils.js'
import { CONTROL_TAU, scheduleEnvelope, autoDispose } from './audioGraph.js'
import {
  lerp, logLerp, ouStep, swellEnvelope, shoreSwellPhases,
  poissonFires, schmitt, windGustShape, birdRate, distanceCues,
  windDrive, surfDrive, canopyRustle,
} from './audioMath.js'

/** Makeup for the flutter modulator. Pink noise lowpassed into the 0–14 Hz
 *  band retains a tiny fraction of its amplitude, so driving a gain param with
 *  it directly does nothing measurable; this scales it back to a usable depth.
 *  Tuned against the measured 2–20 Hz envelope energy, not guessed. */
const MOD_MAKEUP = 26

/** water.frag's own FOAM_LEAD_TIME, in seconds — MUST match. The shader
 *  evaluates its crest signal this far ahead of uTime so the foam mask, which
 *  otherwise reacts a beat late, is already built by the time the crest it
 *  answers is on screen. Reusing the same lead here is what puts the break
 *  trigger's crossing on the same simulated instant as the foam's own. */
const FOAM_LEAD_S = 0.3

/** Below this water presence the surf fires no one-shots at all. */
const SURF_AUDIBLE_PRESENCE = 0.004


/** Start a looping noise source at a random offset into the buffer. */
function startLoop(ctx, buffer, rng, offset = null) {
  const src = ctx.createBufferSource()
  src.buffer = buffer
  src.loop = true
  src.start(ctx.currentTime, offset == null ? rng() * buffer.duration : offset)
  return src
}

/**
 * A WIDE noise bed: two reads of the same buffer, half a buffer apart, hard
 * panned.
 *
 * Measured, a single-source bed has a stereo width of 0.00–0.02 — dead
 * centre. A mono noise bed does not read as weather; it reads as a speaker,
 * because every natural diffuse field arrives at the two ears decorrelated and
 * that decorrelation IS the sense of being outdoors.
 *
 * Two reads of one buffer are genuinely uncorrelated as long as the lag
 * between them is longer than the noise's own correlation time (microseconds
 * here) and stays constant — which it does, because both play at rate 1.0 and
 * a shared loop length keeps the lag fixed forever. Detuning (playbackRate)
 * would slide the lag continuously through zero, and at the crossing the two
 * copies comb; a fixed half-buffer offset never approaches zero at all.
 *
 * Returns the summed node plus everything that needs stopping and unwiring.
 */
function createStereoBed(ctx, buffer, rng) {
  const off = rng() * buffer.duration
  const a = startLoop(ctx, buffer, rng, off)
  const b = startLoop(ctx, buffer, rng, (off + buffer.duration * 0.5) % buffer.duration)

  const panL = ctx.createStereoPanner(); panL.pan.value = -0.85
  const panR = ctx.createStereoPanner(); panR.pan.value = 0.85

  // Two uncorrelated signals sum in POWER, so the sum is √2 louder than one.
  const sum = ctx.createGain()
  sum.gain.value = Math.SQRT1_2

  a.connect(panL); panL.connect(sum)
  b.connect(panR); panR.connect(sum)

  return { out: sum, sources: [a, b], nodes: [panL, panR, sum] }
}

// ─── Wind ────────────────────────────────────────────────────────────────────

/**
 * Wind: pink noise, one shallow resonance, and a tilt that moves WITH the
 * level.
 *
 * Deliberately not a bank of sharp resonant bandpasses — high Q peaks whistle,
 * which reads as a tube or a hairdryer rather than moving air. The character
 * comes instead from the gust process: an Ornstein–Uhlenbeck walk (a random
 * walk pulled toward a mean) driving loudness and brightness together, because
 * real gusts carry more high-frequency turbulent energy exactly when they are
 * louder. A sum of slow sine LFOs was the obvious alternative and it locks
 * into an audible periodic wobble within minutes.
 */
export class WindVoice {
  constructor(ctx, dest, buffer, rng) {
    this._ctx = ctx
    this._rng = rng
    this._gust = 0.4

    this._bed = createStereoBed(ctx, buffer, rng)

    // Rumble cut. Pink noise carries most of its power in the bottom two
    // octaves and none of it is wind — measured, a third of this voice's
    // energy sat below 250 Hz, which is what "a constant low frequency that is
    // very annoying" actually is. Wind has no sub: what a listener hears is
    // 300 Hz to 5 kHz, and the weight below that belongs to the surf.
    this._hp = ctx.createBiquadFilter()
    this._hp.type = 'highpass'
    this._hp.frequency.value = 130
    this._hp.Q.value = 0.7

    this._tilt = ctx.createBiquadFilter()
    this._tilt.type = 'lowpass'
    this._tilt.frequency.value = 2200
    this._tilt.Q.value = 0.5

    this._peak = ctx.createBiquadFilter()
    this._peak.type = 'peaking'
    this._peak.frequency.value = 480
    this._peak.Q.value = 1.1
    this._peak.gain.value = 3.5

    // Air. Pink is already −3 dB/oct and a lowpass on top of it darkens the
    // same octaves twice, which left 2% of the energy above 2 kHz — no hiss,
    // so no moving air, so no wind. This shelf puts the top back, and it
    // BREATHES with the gust: turbulent energy genuinely shifts upward as the
    // wind rises, so brightness and loudness moving together is the single
    // strongest cue that this is air rather than a fader.
    this._air = ctx.createBiquadFilter()
    this._air.type = 'highshelf'
    this._air.frequency.value = 3200
    this._air.gain.value = 2

    this._gain = ctx.createGain()
    this._gain.gain.value = 0

    this._bed.out.connect(this._hp)
    this._hp.connect(this._tilt)
    this._tilt.connect(this._peak)
    this._peak.connect(this._air)
    this._air.connect(this._gain)
    this._gain.connect(dest)

    // ── The howl ──────────────────────────────────────────────────────────
    // A parallel resonant band whose centre slides on its own slow walk.
    //
    // Without this the voice is pink noise under a moving lowpass, which is
    // hiss: a listener has no cue that says "wind" rather than "noise",
    // because the gust envelope alone reads as someone moving a volume fader.
    // The narrow sliding resonance IS the identifying cue — air tearing past
    // an edge. It sits well under the broad body so it colours rather than
    // whistles, and it never stops moving, which is what keeps it from
    // reading as a tuned tone.
    //
    // Q is LOW on purpose. At Q=7 this is a whistle that wanders — the
    // wind-machine cliché, and a tuned pitch is exactly what tells a listener
    // "synthesizer". A broad resonance colours the band without ever becoming
    // a note, which is what edges and ridges actually do to moving air.
    this._howlPos = 0.4
    this._howl = ctx.createBiquadFilter()
    this._howl.type = 'bandpass'
    this._howl.frequency.value = 700
    this._howl.Q.value = 2.2

    this._howlGain = ctx.createGain()
    this._howlGain.gain.value = 0

    this._bed.out.connect(this._howl)
    this._howl.connect(this._howlGain)
    this._howlGain.connect(dest)
  }

  /**
   * @param scene { mountains, snowline, overcast, pace, presence }
   *   `presence` is the overall level this voice is allotted. `mountains` and
   *   `snowline` are MACRO-FORM DIALS, mutually independent (see
   *   audio.setSceneState).
   *
   *   The two drives are separate on purpose (see windDrive): `overcast` is
   *   FORCE — it moves the gust walk's centre, so a grey sky genuinely blows
   *   harder — and `pace`, how fast the land is reshaping, is UNSTEADINESS: it
   *   sets how often gusts arrive and how far they swing, and how hard a gust
   *   hits (35–100%), but never where the walk is centred.
   */
  update(dt, scene) {
    const ctx = this._ctx
    const now = ctx.currentTime

    // Gust walk. The weather sets where it lives, the landscape's pace sets how
    // restless it is around there.
    //
    // Theta is the RECIPROCAL of the gust's correlation time, so it sets how
    // long a gust lasts. At 0.25–0.9 (1–4 s) the walk measured as a 0.47 Hz
    // ripple at a depth of only 0.36 — an oscillating fader, not weather. Real
    // gusting breathes over 4–12 s and swings much further, hence 0.07–0.18
    // (≈ 6–14 s). Sigma moves with √theta so the stationary spread of the
    // walk, sigma/√(2·theta), stays ≈ 0.43 across the whole pace range: pace
    // changes how fast the wind wanders, not how far.
    const pace = clamp01(scene.pace)
    const { exposure, mean, edge } = windDrive(scene)
    const theta = lerp(0.07, 0.18, pace)
    const sigma = lerp(0.16, 0.26, pace)
    this._gust = clamp(ouStep(this._gust, mean, theta, sigma, dt, this._rng), 0, 1.4)

    const { level, tiltHz } = windGustShape(this._gust, pace)

    const target = exposure * level * scene.presence

    // Overcast sharpens the mid as well as raising the force — weather has an
    // audible edge, not only a strength.
    this._peak.gain.setTargetAtTime(lerp(2.5, 7, clamp01(scene.overcast)), now, CONTROL_TAU)
    this._tilt.frequency.setTargetAtTime(tiltHz, now, CONTROL_TAU)
    // The top end opens with the gust — turbulence is genuinely brighter when
    // it is stronger, and this is the cue that separates air from a fader. The
    // weather and a cold bare frame lean on the same shelf. BLENDED into one
    // fraction, not summed as two dB figures: summed, a grey gale reaches +11 dB
    // of shelf, which is not weather but tape hiss.
    const bright = clamp01(0.6 * clamp01(this._gust) + 0.4 * edge)
    this._air.gain.setTargetAtTime(lerp(-2, 6, bright), now, CONTROL_TAU)
    this._gain.gain.setTargetAtTime(target, now, CONTROL_TAU)

    // The howl slides on its OWN walk, slower and independent of the gust, so
    // the pitch of the wind and its strength are not locked together — locked,
    // they read as one filter sweep rather than as moving air.
    this._howlPos = clamp(ouStep(this._howlPos, 0.45, 0.12, 0.5, dt, this._rng), 0, 1)
    this._howl.frequency.setTargetAtTime(logLerp(260, 1700, this._howlPos), now, 0.25)
    // Louder when the wind is up: a gust is when you actually hear it tear.
    this._howlGain.gain.setTargetAtTime(target * lerp(0.12, 0.5, clamp01(this._gust)), now, CONTROL_TAU)
  }

  /** The level this voice is actually producing — what the panel's signal-flow
   *  view reports. NOT the solo stage, which is 1 whenever the voice is not
   *  muted and so says nothing about whether anything is audible. */
  getLevel() { return this._gain.gain.value }

  /** The gust walk's current value. TreeVoice's input: the trees answer THIS
   *  wind rather than a gust of their own — two independent walks would put
   *  the canopy out of step with the air that is supposed to be moving it. */
  getGust() { return clamp01(this._gust) }

}

/**
 * TreeVoice — wind in the leaves, as its own voice.
 *
 * Its own voice so it can be soloed, and so its level hangs off its own
 * presence. Derived from the wind body's gain, which already carries the gust
 * curve, the gust would count twice and the canopy sit about 20 dB below its
 * own map — measured on the live scene, a gain of 0.0025–0.0155: inaudible.
 *
 * It answers the wind's gust rather than a walk of its own: two independent
 * walks would put the canopy out of step with the air supposedly moving it.
 * Everything else — its bed, its band, its flutter, its level — is its own.
 */
export class TreeVoice {
  constructor(ctx, dest, buffer, rng) {
    this._ctx = ctx
    this._rng = rng

    // The canopy's lagged copy of the gust. Leaves do not stop the instant the
    // air does: a tree goes on whispering for a second or two after the gust
    // has passed, and that tail is most of what makes the layer read as
    // foliage rather than as a tremolo on some hiss.
    this._leaf = 0.3

    this._bed = createStereoBed(ctx, buffer, rng)

    this._band = ctx.createBiquadFilter()
    this._band.type = 'highpass'
    this._band.frequency.value = 1100
    this._band.Q.value = 0.6

    // The ceiling. Capped, because an open highpass runs to Nyquist and is tape
    // hiss — but capped where two REAL RECORDINGS put it. A field recording of
    // windy woods and a close recording of rustling leaves both sit at a
    // centroid near 6.1 kHz and carry 20% and 62% of their energy in the
    // 4–8 kHz octave; capped at 4.8 kHz this voice had 18% there and a
    // centroid of 3.7 kHz. The crispness that identifies leaves lives in
    // exactly that octave.
    this._cap = ctx.createBiquadFilter()
    this._cap.type = 'lowpass'
    this._cap.frequency.value = 9000
    this._cap.Q.value = 0.6

    // A gentle lift across the top, because pink noise is −3 dB/oct and a
    // raised ceiling alone leaves the octave the cap just opened still sloping
    // away; opening the top without this reshaping gives hiss.
    this._air = ctx.createBiquadFilter()
    this._air.type = 'highshelf'
    this._air.frequency.value = 3200
    this._air.gain.value = 6

    this._gain = ctx.createGain()
    this._gain.gain.value = 0

    this._bed.out.connect(this._band)
    this._band.connect(this._cap)
    this._cap.connect(this._air)
    this._air.connect(this._gain)
    this._gain.connect(dest)

    // The flutter. AUDIO RATE, not per-frame: a 60 Hz control loop cannot
    // produce a 30 Hz flutter, and CONTROL_TAU would smooth off what little
    // survived. Noise lowpassed into the flutter band, driving the gain param
    // directly, costs nothing on the main thread — and it is the one cue that
    // separates a tree from a fan.
    this._mod = startLoop(ctx, buffer, rng)
    this._modBand = ctx.createBiquadFilter()
    this._modBand.type = 'lowpass'
    this._modBand.frequency.value = 14
    this._modBand.Q.value = 0.7
    this._modDepth = ctx.createGain()
    this._modDepth.gain.value = 0
    this._mod.connect(this._modBand)
    this._modBand.connect(this._modDepth)
    this._modDepth.connect(this._gain.gain)

    // The SWELL: a slow walk aimed at the 0.2–2 Hz band, driven from JS.
    //
    // Real foliage puts 40–48% of its modulation energy below 2 Hz (both
    // reference recordings) — the sound of a gust travelling through a canopy,
    // arriving in one part of it and passing to another. The voice's other two
    // timescales, the wind's gust walk (≈ 6–14 s, below 0.2 Hz) and the leaf
    // flutter (7–30 Hz), leave exactly that gap empty; without the swell the
    // voice measured 1% there and 62% at 10–30 Hz. Everything a listener reads
    // as a canopy BREATHING sits in the gap.
    //
    // Per-frame is the right rate for this: a 60 Hz control loop resolves 2 Hz
    // perfectly well, where the flutter genuinely needs an audio-rate
    // modulator. The two are different problems and get different mechanisms.
    this._swell = 0.6
    this._swellDepth = 0.85

    // Artistic values, every one a slider (audio.js sets them at build): leaf
    // size, species and how still the air goes after a gust all move them, and
    // none has a correct setting.
    this._level = 1
    this._flutter = 30      // Hz at full gust
    this._tail = 1.6        // seconds of whisper after a gust drops
    this._tone = 0.5        // 0 dry and thin, 1 full and bodied
  }

  /**
   * @param scene { forest, gust, presence }
   *   `gust` is the WIND's, handed over by audio.js. `presence` is the level
   *   this voice is allotted — directly, not via the wind body's gain (see the
   *   class doc).
   */
  update(dt, scene) {
    const now = this._ctx.currentTime
    const g = clamp01(scene.gust)
    // Attack stays a fixed fraction of the release, so dragging the tail longer
    // does not also make the trees slow to notice the wind arriving.
    const tau = g > this._leaf ? this._tail * 0.22 : this._tail
    this._leaf += (g - this._leaf) * (1 - Math.exp(-dt / Math.max(tau, 0.02)))

    // The swell walk: theta 1.1, a correlation time near 0.9 s, for the
    // 0.2–2 Hz band the references are dominated by.
    this._swell = clamp(ouStep(this._swell, 1, 1.1, 1.4, dt, this._rng), 0.1, 1.9)
    const swell = lerp(1 - this._swellDepth, 1 + this._swellDepth * 0.6,
      clamp01((this._swell - 0.1) / 1.8))

    const leaves = canopyRustle(scene.forest, this._leaf,
      { flutterMax: this._flutter, tone: this._tone })
    const level = clamp01(scene.presence) * leaves.level * this._level * swell

    this._gain.gain.setTargetAtTime(level, now, CONTROL_TAU)
    // Flutter depth at 0.28 of the full makeup: at full makeup it carried 62%
    // of this voice's modulation energy against the references' 11–28%, which
    // reads as a tremolo rather than as leaves. The swell above carries the
    // slow half.
    this._modDepth.gain.setTargetAtTime(level * MOD_MAKEUP * 0.28, now, CONTROL_TAU)
    this._band.frequency.setTargetAtTime(leaves.bandHz, now, CONTROL_TAU)
    this._modBand.frequency.setTargetAtTime(leaves.flutterHz, now, CONTROL_TAU)
  }

  /**
   * Audition: one gust through the trees, with no wind in front of it.
   *
   * Sets the canopy's own follower rather than scheduling anything, so what is
   * heard is the real layer with its real release — a swell that arrives and
   * then dies away over the tail the slider sets, not a separate demo sound
   * that could be right while the running layer is silent.
   */
  gustNow() { this._leaf = 1 }

  /** Live readout: what the canopy is actually asking for right now. */
  getLevel() { return this._gain.gain.value }
  getLeaf()  { return this._leaf }

  setLeafLevel(v) { if (Number.isFinite(v)) this._level = Math.max(0, v) }
  /** How fast the leaves flutter at full gust, in Hz. */
  setLeafFlutter(v) { if (Number.isFinite(v)) this._flutter = clamp(v, 4, 80) }
  /** How long the trees go on whispering after a gust drops, seconds. */
  setLeafTail(v) { if (Number.isFinite(v)) this._tail = Math.max(0.05, v) }
  /** Dry and thin at 0, full and bodied at 1. */
  setLeafTone(v) { if (Number.isFinite(v)) this._tone = clamp01(v) }

}

// ─── Surf ────────────────────────────────────────────────────────────────────

/**
 * Surf: a breathing body of resonant-filtered noise ("the diffuse waves"),
 * plus discrete swell-shaped one-shots LOCKED to the visible swell — quiet
 * ones as ambient wave-arrivals, loud ones as shore breaks.
 *
 * ARCHITECTURE, cited: the continuous roar and the one-shot "wave" shape are
 * both a direct rebuild of the ocean-wave model in
 *
 *   Tez, H.E., Selfridge, R., Reiss, J.D. (2022). "Ocean Wave Sound Synthesis
 *   and Perceptual Evaluation." AES Convention 152, Paper 10565. (The
 *   "Nemisindo"/"Waves" model — https://nemisindo.com/models/waves.html),
 *
 * itself building on the historical precedent the paper cites: Simonton,
 * J.S. Jr. (1972). "Build the Surf Synthesizer." Popular Electronics, 45-48.
 * A plain lowpass/highpass "body + foam" measures as flat-per-octave noise
 * under a moving cutoff — audibly a filtered hiss rather than water. The
 * paper's own controlled finding (§5) that a droplet/bubble layer added NO
 * measurable realism (p=1.000, n=52) is why no such layer is attempted here.
 *
 * THE CONTINUOUS ROAR (§3.1.2, "two waves"): each of the two bands
 * (`_wave1` the body, `_wave2` the foam) is pink noise through a lowpass THEN
 * a bandpass at Q=0.322 ("determined by trial and error" in the paper),
 * amplitude-modulated TWICE — a chop-paced LFO (the paper's 0.062-0.33 Hz
 * range) stacked with a second, slower, FIXED 0.05 Hz LFO. One modulation
 * alone reads as metronomic; the second is what makes the surge feel organic.
 * The level and spectral drives on top (env→gain, chop→gain, env→pitch) were
 * measured against a real recording.
 *
 * THE ONE-SHOTS (§3.1.3, "channel waves"): a single bandpass (Q=0.322 again)
 * whose centre ramps up then down-to-half over the shot's duration — one
 * wave arriving, cresting, and dying. The paper loops this on a fixed
 * 6-second wall clock; that is NOT reproduced here, on purpose (see below).
 *
 * SHARED CLOCK, not two oceans. Two independent oscillators cannot be tuned
 * INTO agreement — "close but never quite lines up" is what two unrelated
 * clocks always do — so the swell is water.frag's own: `shoreSwellPhases`
 * (audioMath.js) is the SAME three angles swell() evaluates, run on
 * waterDriver's ripple clock (`scene.rippleTime`). For the same reason the
 * one-shots fire off this shared envelope via two Schmitt triggers — a low,
 * loose one for quiet ambient "sound line" events and a high, strict one for
 * loud breaks — not off the paper's free-running loop, which would be a
 * second, unrelated wave clock. Sharing the envelope also lets a big swell's
 * quiet approach (ambient) and its crash (break) land as one correlated event.
 *
 * What this buys, and what it does not: TIMING and TEMPO match exactly — the
 * same crest, the same lead time, the same rate. POSITION does not: JS has no
 * way to ask where the true shoreline sits (that depends on the terrain height
 * field, GPU-only), so this is one shared crest for the whole visible sea. And
 * the shader's small noise-detail term (uWaveNoiseMix, shipped at 0.2) is not
 * reproduced, so the two can still disagree on the rare frames that term
 * swings hard.
 *
 * Normalised by standard deviation rather than by its maximum so the lull and
 * the peak actually arrive (see audioMath.swellEnvelope).
 */
export class SurfVoice {
  constructor(ctx, dest, buffer, rng, reverb) {
    this._ctx = ctx
    this._rng = rng
    this._buffer = buffer
    this._dest = dest
    this._reverb = reverb

    this._armed = true          // the loud-break Schmitt
    this._sinceBreak = 99
    this._armedAmbient = true   // the quiet-sound-line Schmitt
    this._sinceAmbient = 99
    this._env = 0.5

    this._bed = createStereoBed(ctx, buffer, rng)

    // ── Two diffuse waves, because water is two sounds ─────────────────────
    // Measured, a single lowpassed bed puts 86% of this voice's energy below
    // 500 Hz and 2% above 2 kHz: a distant motorway, not a shore. Water is
    // heard as a low BODY (the mass of the swell) plus a bright hiss that
    // surges and recedes, so splitting them lets the hiss breathe over a
    // steady body instead of the whole band pumping together.
    this._wave1 = this._makeDiffuseWave(650)
    this._wave2 = this._makeDiffuseWave(1700)

    this._gain = ctx.createGain()
    this._gain.gain.value = 0
    this._wave1.out.connect(this._gain)
    this._gain.connect(dest)

    this._foamGain = ctx.createGain()
    this._foamGain.gain.value = 0
    this._wave2.out.connect(this._foamGain)
    this._foamGain.connect(dest)
  }

  /**
   * One "two waves" diffuse-noise band (Tez/Selfridge/Reiss §3.1.2): pink
   * noise → lowpass → bandpass (Q=0.322) → double-LFO amplitude modulation.
   * Neither multiplier reaches zero — real surf recordings never truly hush.
   */
  _makeDiffuseWave(pitchHz) {
    const ctx = this._ctx
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = pitchHz
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'
    bp.frequency.value = pitchHz; bp.Q.value = 0.322

    const lfo1 = ctx.createOscillator(); lfo1.frequency.value = 0.15
    const lfo1Gain = ctx.createGain(); lfo1Gain.gain.value = 0.5
    const lfo1Offset = ctx.createConstantSource(); lfo1Offset.offset.value = 1.5
    const mod1 = ctx.createGain(); mod1.gain.value = 0
    lfo1.connect(lfo1Gain); lfo1Gain.connect(mod1.gain); lfo1Offset.connect(mod1.gain)

    // The first LFO is the paper's ×0.5+1.5, i.e. [1.0, 2.0]. The paper's
    // shape for this second one — (x+1)×0.25, i.e. [0, 0.5] — reaches exactly
    // 0 at its low point, a full silent mute once every ~20 s cycle
    // (1/0.05 Hz) with nothing to do with the swell. Here it is ×0.15+0.35,
    // i.e. [0.2, 0.5]: it breathes without ever cutting the roar, the
    // "zero-pass avoidance" principle §3.1.1 states for the wind.
    const lfo2 = ctx.createOscillator(); lfo2.frequency.value = 0.05
    const lfo2Gain = ctx.createGain(); lfo2Gain.gain.value = 0.15
    const lfo2Offset = ctx.createConstantSource(); lfo2Offset.offset.value = 0.35
    const mod2 = ctx.createGain(); mod2.gain.value = 0
    lfo2.connect(lfo2Gain); lfo2Gain.connect(mod2.gain); lfo2Offset.connect(mod2.gain)

    this._bed.out.connect(lp); lp.connect(bp); bp.connect(mod1); mod1.connect(mod2)
    lfo1.start(0); lfo1Offset.start(0); lfo2.start(0); lfo2Offset.start(0)
    return { lp, bp, lfo1, lfo1Gain, lfo1Offset, mod1, lfo2, lfo2Gain, lfo2Offset, mod2, out: mod2 }
  }

  /** Current swell height [0,1] — audio.js surfaces it as a debug readout. */
  getSwell() { return this._env }

  /** The level this voice is actually producing. See WindVoice.getLevel. */
  getLevel() { return this._gain.gain.value }

  /**
   * @param scene { ocean, overcast, motion, rippleTime, presence, breakLevel }
   *   `ocean` is the macro-form dial — how much sea the frame holds.
   *   `overcast` roughens rather than raises: a grey day breaks more, foams
   *   more and swells less, which is weather on its own axis instead of a
   *   second hand on the level. The swell's clock is `rippleTime` alone (see
   *   the class doc); neither `motion` nor chop speeds it, because water.frag's
   *   swell() has no such term and this voice must not run ahead of the field
   *   it shares. `breakLevel` is an INDEPENDENT axis from `presence` (which
   *   already carries the overall water-level slider): it scales only the
   *   break's own peak, not the continuous body/foam, so a break's prominence
   *   above its own water can be dialled without changing how loud the water is.
   */
  update(dt, scene) {
    const ctx = this._ctx
    const now = ctx.currentTime
    // animSpeed's wave/cloud pace, read only for the break-probability roll
    // below: like chop, an independent reason a set is more or less likely to
    // break, never a second clock.
    const motion = clamp01(scene.motion)
    // surfDrive gives the water a floor, the way the wind has one — unfloored
    // it sits far enough under the wind to be masked rather than quiet.
    const { presence: sea, chop } = surfDrive(scene)
    const presence = sea * scene.presence

    // The shared crest. `+FOAM_LEAD_S` is water.frag's OWN look-ahead on this
    // same field (FOAM_LEAD_TIME in the shader) — reusing it means the break
    // trigger crosses its threshold at the identical simulated instant the
    // shore foam mask crosses its own, rather than a beat early or late.
    const t = (Number.isFinite(scene.rippleTime) ? scene.rippleTime : 0) + FOAM_LEAD_S
    const env = swellEnvelope(shoreSwellPhases(t))
    this._env = env

    // The body sits BACK. It is the floor the breaks rise out of, and when it
    // is level with them nothing punctuates: measured at a crest factor of
    // 5.7, no events stood out of the bed and thirty seconds of it read as one
    // continuous wash.
    // Chop takes FROM the smooth body and gives to the foam and the breaks: a
    // rough sea is not a loud sea, it is a broken one. Scaling both up together
    // would just be a weather fader on the whole voice. The trough floor (0.4)
    // keeps a base roar under a lot of ocean rather than near-silence: the
    // swell narrows the RANGE instead of nearly emptying it.
    this._gain.gain.setTargetAtTime(
      presence * lerp(0.4, 0.65, env) * lerp(1, 0.85, chop), now, CONTROL_TAU)
    // The body brightens as the swell rises — a wave face is brighter at its
    // peak than in the trough.
    this._wave1.lp.frequency.setTargetAtTime(logLerp(420, 1300, env), now, CONTROL_TAU)
    this._wave1.bp.frequency.setTargetAtTime(logLerp(420, 1300, env), now, CONTROL_TAU)

    // Foam surges much harder than the body: squared, so the hiss is nearly
    // gone in the trough and unmistakable at the crest. This is the layer that
    // makes the swell audible AS water rather than as a slow filter sweep.
    const surge = env * env
    this._foamGain.gain.setTargetAtTime(
      // Measured, a 2.1x chop boost put 36% of a grey sea's energy above 2 kHz
      // and took the centroid to 3.4 kHz — spray on a microphone, not
      // weather. The breaks carry the roughness; the foam only leans in
      // (1.45x). The trough floor (0.1) is there for the body's reason: near
      // zero at the trough reads as the roar cutting out.
      presence * lerp(0.1, 0.42, surge) * lerp(1, 1.45, chop), now, CONTROL_TAU)
    this._wave2.lp.frequency.setTargetAtTime(logLerp(2400, 1100, env), now, CONTROL_TAU)
    this._wave2.bp.frequency.setTargetAtTime(logLerp(2400, 1100, env), now, CONTROL_TAU)

    // The double-LFO's FASTER rate rides chop — Tez/Selfridge/Reiss's own
    // 0.062-0.33 Hz range for this modulator — so a rougher sea's roar
    // breathes faster, not just louder. `_wave2` runs 15% faster than
    // `_wave1` so the two bands don't pulse in lockstep.
    const lfo1Hz = lerp(0.062, 0.33, chop)
    this._wave1.lfo1.frequency.setTargetAtTime(lfo1Hz, now, CONTROL_TAU)
    this._wave2.lfo1.frequency.setTargetAtTime(lfo1Hz * 1.15, now, CONTROL_TAU)

    // Loud breaks. A break is the only part of this voice a listener can
    // actually count, so it has to happen often enough to be heard AS water:
    // measured on the live scene, stricter thresholds gave three breaks in
    // thirty seconds, each a two-to-four second wash that blurred into the
    // bed. Hence a low crossing, a short refractory, and a break that sits
    // clearly above the body it comes out of.
    this._sinceBreak += dt
    // Chop lowers the bar a wave has to clear to break, so a grey sea breaks on
    // the smaller swells too.
    //
    // ONLY the crossing moves. The release stays put, and that is the whole
    // trick: lowering both together makes a grey sea break LESS (measured, 3 a
    // minute against a calm sea's 5), because re-arming requires the envelope
    // to fall BELOW the release, and a lower release is harder to reach, not
    // easier. Narrowing the window from the top is what turns more swells into
    // breaks; widening it from the bottom strands the trigger.
    const res = schmitt(env, this._armed, lerp(0.56, 0.38, chop), 0.34)
    this._armed = res.armed
    const audible = presence > SURF_AUDIBLE_PRESENCE
    if (res.fired && audible && this._sinceBreak > lerp(0.8, 0.45, chop)) {
      // Not every crossing breaks: skipping some is what produces sets and
      // quiet intervals rather than a metronome.
      if (this._rng() < lerp(0.6, 0.98, clamp01(Math.max(motion, chop)))) {
        this._sinceBreak = 0
        this.breakNow(presence * lerp(1.3, 2.6, this._rng()) * clamp(scene.breakLevel ?? 1, 0, 4))
      }
    }

    // Quiet "sound line" events — one per swell arrival, most of them never
    // reaching the break threshold above. A second, LOOSER Schmitt trigger on
    // the SAME shared envelope (see class doc for why this shares a clock
    // with the break rather than running its own loop): a low bar to cross
    // and a low release, so it re-arms readily and fires close to once per
    // rise. `breakLevel` deliberately does NOT scale this — it is an ambient
    // texture, not a break, and stays under the artist's water-level slider
    // only.
    this._sinceAmbient += dt
    const ares = schmitt(env, this._armedAmbient, lerp(0.22, 0.14, chop), 0.08)
    this._armedAmbient = ares.armed
    if (ares.fired && audible && this._sinceAmbient > lerp(0.5, 0.3, chop)) {
      this._sinceAmbient = 0
      this._ambientSwellNow(presence * lerp(0.15, 0.35, this._rng()))
    }
  }

  /**
   * One swell-shaped one-shot (Tez/Selfridge/Reiss §3.1.3, "the left and
   * right waves"): a single bandpass (Q=0.322) whose centre ramps UP to
   * `pitchHi` then DOWN to half of it — one wave approaching, cresting and
   * receding — panned to scatter events across the shore. Shared by the
   * quiet ambient events and the loud breaks below; only peak/pitch/duration
   * differ between them.
   */
  _swellShot(peak, { pitchLo, pitchHi, durLo, durHi, sendGain }) {
    const ctx = this._ctx
    const rng = this._rng
    const now = ctx.currentTime + 0.02
    const dur = lerp(durLo, durHi, rng())
    const pan = (rng() * 2 - 1) * 0.7

    const out = ctx.createStereoPanner()
    out.pan.value = pan
    out.connect(this._dest)
    let send = null
    if (this._reverb && sendGain > 0) {
      send = ctx.createGain()
      send.gain.value = sendGain
      out.connect(send)
      send.connect(this._reverb)
    }

    const src = ctx.createBufferSource()
    src.buffer = this._buffer
    src.loop = true
    src.playbackRate.value = lerp(0.92, 1.1, rng())

    const bp = ctx.createBiquadFilter()
    bp.type = 'bandpass'
    bp.Q.value = 0.322
    bp.frequency.setValueAtTime(pitchLo, now)
    bp.frequency.linearRampToValueAtTime(pitchHi, now + dur * 0.5)
    bp.frequency.linearRampToValueAtTime(pitchHi * 0.5, now + dur)

    const env = ctx.createGain()
    src.connect(bp); bp.connect(env); env.connect(out)
    const end = scheduleEnvelope(env.gain, now, peak, lerp(0.05, 0.15, rng()), dur)
    src.start(now, rng() * this._buffer.duration)
    src.stop(end + 0.05)
    autoDispose(src, send ? [bp, env, out, send] : [bp, env, out])
    return end
  }

  /** One breaking wave — the loud end of `_swellShot`, scaled by `breakLevel`
   *  at the call site (see `update()` and audio.js). */
  breakNow(peak = 0.25) {
    const pitchHi = lerp(1400, 4200, this._rng())
    return this._swellShot(peak,
      { pitchLo: 300, pitchHi, durLo: 1.6, durHi: 3.2, sendGain: 0.25 })
  }

  /** One quiet wave arriving — the ambient end of `_swellShot`. */
  _ambientSwellNow(peak) {
    const pitchHi = lerp(700, 1800, this._rng())
    return this._swellShot(peak,
      { pitchLo: 300, pitchHi, durLo: 0.8, durHi: 1.8, sendGain: 0.12 })
  }

}

// ─── Birds ───────────────────────────────────────────────────────────────────

/**
 * Call templates. Species identity lives in RHYTHM far more than in pitch, so
 * the templates differ mainly in syllable count and spacing; each instance
 * then jitters within the template rather than drawing every gap independently
 * (which sounds mechanical however random it is).
 *
 * `contour` names the pitch shape of one syllable; `gap` is the first
 * inter-syllable spacing in seconds, multiplied by `gapDecay` after each
 * syllable; `dur` is one syllable's length.
 */
const BIRD_TEMPLATES = [
  { name: 'two-note',   contour: 'fall',  syllables: 2, gap: 0.16, gapDecay: 1.0,  dur: 0.13 },
  { name: 'rising-ask', contour: 'rise',  syllables: 1, gap: 0,    gapDecay: 1.0,  dur: 0.21 },
  { name: 'chatter',    contour: 'arch',  syllables: 4, gap: 0.09, gapDecay: 0.86, dur: 0.07 },
  // A trill is REPEATED DISCRETE SYLLABLES at 10–30 a second — the amplitude
  // returns to zero between them. It is not vibrato: a 22–70 Hz LFO on the
  // oscillator's frequency at a modulation index of up to 11 is not a trill at
  // all but a full Chowning FM spectrum with twenty-odd sidebands — a DX7 bell.
  { name: 'trill',      contour: 'flat',  syllables: 11, gap: 0.028, gapDecay: 1.0, dur: 0.03 },
  { name: 'scold',      contour: 'v',     syllables: 3, gap: 0.13, gapDecay: 1.12, dur: 0.1 },
]

/** Sample a pitch contour into a curve setValueCurveAtTime can play.
 *  Chained exponential ramps were the alternative: they kink audibly at every
 *  breakpoint, which reads as a bent slide whistle rather than a bird. */
function contourCurve(kind, f0, span, n = 48) {
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1)
    let k
    switch (kind) {
      case 'rise': k = t; break
      case 'fall': k = 1 - t; break
      case 'arch': k = Math.sin(t * Math.PI); break
      case 'v':    k = 1 - Math.sin(t * Math.PI); break
      default:     k = 0.5
    }
    // Interpolate in the log domain so the sweep is musically even.
    out[i] = f0 * Math.pow(span, k)
  }
  return out
}

/**
 * The flock: schedules calls as a Poisson process whose rate comes from how
 * much forest is on screen, and synthesizes each one.
 *
 * Every syllable carries a short broadband onset transient and one tracking
 * harmonic. Those two details do most of the work — a bare sine with a pitch
 * ramp reads unmistakably as a synthesizer, and real syllables begin with a
 * breath/click and carry a second harmonic 15–25 dB down whose balance shifts
 * through the sweep.
 */
export class BirdVoice {
  constructor(ctx, dest, buffer, rng, reverb) {
    this._ctx = ctx
    this._rng = rng
    this._buffer = buffer
    this._dest = dest
    this._reverb = reverb
    this._since = 0
    this._rate = 0
    // A standing cast, redrawn slowly. See _individual().
    this._flock = Array.from({ length: 6 }, () => this._individual())
    // Who is currently answering — the whole cast until the weather closes in.
    // Initialised here rather than left to the first update() so the debug
    // audition buttons, which call() directly, always have someone to pick.
    this._awake = this._flock
  }

  /**
   * One bird: a pitch, a sweep width, a motif, a place to sit, and a throat.
   *
   * This is the difference between a flock and a bleep generator. Drawing f0,
   * template, pan and distance afresh on every call would mean no two calls
   * ever come from the same animal, so the listener never forms the object
   * "a bird"; they hear a random-note generator, which
   * no amount of per-call realism repairs. Real birds hold their pitch within a
   * few percent and repeat one motif for minutes on end.
   *
   * `formantHz` is a fixed throat resonance. It stays PUT while the
   * fundamental sweeps through it, which is what a trachea does and is a
   * strong cue that the sound has a body.
   */
  _individual() {
    const rng = this._rng
    const f0 = lerp(1400, 3800, rng())
    return {
      f0,
      span: lerp(1.15, 2.2, rng()),
      tpl: BIRD_TEMPLATES[Math.floor(rng() * BIRD_TEMPLATES.length)],
      pan: (rng() * 2 - 1) * 0.8,
      // Biased NEAR (median 0.27). Distance both attenuates and lowpasses, and
      // a far-biased draw (rng()^0.45) measured 28 dB under the wind: present
      // in the graph, inaudible in the room. Some birds must sit close enough
      // to hear as an animal rather than as a hint of one.
      dist: Math.pow(rng(), 1.9),
      formantHz: clamp(f0 * lerp(0.9, 1.7, rng()), 900, 6000),
      // The greyness at which this one stops answering. Every bird has its own,
      // so the wood empties VOICE BY VOICE as the sky closes in rather than
      // everybody slowing down together — which is what an emptying wood
      // actually sounds like, and the only version of it a listener can
      // notice, because you notice the one that has gone quiet.
      hush: lerp(0.35, 1.35, rng()),
      // How long this one stays before another takes its place.
      life: lerp(35, 110, rng()),
      age: 0,
    }
  }

  /** Calls per second the scene is currently asking for — a debug readout. */
  getRate() { return this._rate }

  /** How many of the cast are still answering, and how many there are. The
   *  weather empties the wood by silencing individuals, so this is the number
   *  that explains a quiet forest — the rate alone does not. */
  getAwake() { return { awake: this._awake.length, of: this._flock.length } }

  /** @param scene { forest, overcast, activity } */
  update(dt, scene) {
    this._since += dt
    // Who is still answering. The rate is scaled by the share of the cast that
    // is — without that the sky would thin the CAST while leaving the call rate
    // untouched, so the last bird standing would sing as often as six did and
    // a grey day would sound more repetitive, not emptier.
    const w = clamp01(scene.overcast)
    let awake = this._flock.filter(b => w < b.hush)
    // Never quite empty. Without this a full grey sky silences the whole cast
    // and the voice renders digital zero — not an emptying wood, a broken one.
    // The last bird holds on.
    if (!awake.length) {
      awake = [this._flock.reduce((a, b) => (b.hush > a.hush ? b : a))]
    }
    this._awake = awake
    const singing = awake.length / this._flock.length
    this._rate = birdRate(scene.forest, scene.overcast, scene.activity) * singing
    // Birds come and go. Without this the same few sing forever, which is its
    // own kind of loop; with it the cast turns over slowly enough that no
    // single change is audible as an event.
    for (let i = 0; i < this._flock.length; i++) {
      this._flock[i].age += dt
      if (this._flock[i].age > this._flock[i].life) this._flock[i] = this._individual()
    }

    // A refractory gap so two calls never collide into a chord, which is the
    // one way a flock immediately stops sounding like separate animals.
    if (this._since < 0.35) return
    if (poissonFires(this._rate, dt, this._rng)) {
      this._since = 0
      this.call()
    }
  }

  /**
   * One call from a member of the flock, at that bird's own distance — or at
   * `distance` [0,1], when given (the debug audition).
   */
  call(distance = null) {
    const ctx = this._ctx
    const rng = this._rng
    // Draw the SINGER, not the song. Everything that identifies an animal —
    // pitch, motif, throat, where it is sitting — belongs to a member of the
    // flock and persists across its calls; only the small jitters are per-call.
    // Only birds that are still answering can sing. A hand-triggered audition
    // falls back to the whole cast — the button means "let me hear one", and a
    // grey sky silently doing nothing would read as a broken control.
    const pool = this._awake.length ? this._awake : (distance == null ? null : this._flock)
    if (!pool) return
    const pick = () => pool[Math.floor(rng() * pool.length)]
    const who = distance == null ? pick() : { ...pick(), dist: clamp01(distance) }

    const d = who.dist
    const cues = distanceCues(d, who.f0)
    const tpl = who.tpl
    const f0 = who.f0
    const span = who.span
    const pan = who.pan

    // Shared per-call output stage: one distance filter, one panner, one send.
    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = cues.cutoff
    lp.Q.value = 0.7

    const callGain = ctx.createGain()
    callGain.gain.value = cues.gain

    const panner = ctx.createStereoPanner()
    panner.pan.value = pan

    lp.connect(callGain); callGain.connect(panner)
    panner.connect(this._dest)

    let send = null
    if (this._reverb) {
      send = ctx.createGain()
      send.gain.value = cues.send
      panner.connect(send)
      send.connect(this._reverb)
    }

    const t0 = ctx.currentTime + 0.03
    let t = t0
    let gap = tpl.gap
    let last = t

    for (let s = 0; s < tpl.syllables; s++) {
      last = this._syllable(t, tpl, f0 * lerp(0.98, 1.02, rng()), span, lp, who.formantHz)
      t += tpl.dur + gap
      gap *= tpl.gapDecay
    }

    // The whole call's output stage is torn down once the last syllable has
    // finished, on a silent source used purely as the lifetime clock.
    const timer = ctx.createBufferSource()
    timer.buffer = this._buffer
    const tail = [lp, callGain, panner]
    if (send) tail.push(send)
    autoDispose(timer, tail)
    timer.connect(ctx.createGain())      // to nowhere audible; it is a clock
    timer.start(t0)
    timer.stop(last + 0.4)
  }

  /** One syllable: onset transient + fundamental + tracking harmonic. */
  _syllable(time, tpl, f0, span, dest, formantHz = 2600) {
    const ctx = this._ctx
    const rng = this._rng
    const dur = tpl.dur * lerp(0.9, 1.1, rng())
    const curve = contourCurve(tpl.contour, f0, span)

    const env = ctx.createGain()

    // The throat. A FIXED resonance the sweeping fundamental passes through,
    // so the call's brightness changes as its pitch moves across the formant
    // rather than tracking it rigidly — a body, rather than a tone generator.
    const throat = ctx.createBiquadFilter()
    throat.type = 'peaking'
    throat.frequency.value = formantHz
    throat.Q.value = 1.6
    throat.gain.value = 7
    env.connect(throat)
    throat.connect(dest)

    const osc = ctx.createOscillator()
    osc.type = 'sine'
    osc.frequency.setValueCurveAtTime(curve, time, dur)

    // Slightly SHARP of an exact octave. Two phase-locked, exactly harmonic
    // oscillators produce a waveform that is perfectly static — the hallmark
    // of subtractive synthesis. A real syrinx phonates two semi-independent
    // voices, and the resulting slow beating is what makes it sound alive.
    const harm = ctx.createOscillator()
    harm.type = 'sine'
    const ratio = lerp(2.01, 2.06, rng())
    const harmCurve = new Float32Array(curve.length)
    for (let i = 0; i < curve.length; i++) harmCurve[i] = curve[i] * ratio
    harm.frequency.setValueCurveAtTime(harmCurve, time, dur)

    // The harmonic's level SWEEPS rather than sitting still. A syrinx is not a
    // loudspeaker: the overtone balance shifts continuously through a syllable,
    // and a fixed ratio between fundamental and harmonic is most of what makes
    // a synthesized call read as a tone generator with a pitch envelope on it.
    const harmGain = ctx.createGain()
    const h0 = lerp(0.05, 0.14, rng())
    const h1 = lerp(0.10, 0.30, rng())
    harmGain.gain.setValueAtTime(h0, time)
    harmGain.gain.linearRampToValueAtTime(h1, time + dur)
    harm.connect(harmGain); harmGain.connect(env)
    osc.connect(env)

    // Micro-vibrato on every syllable. Nothing alive holds
    // a pitch perfectly steady, and a dead-straight sweep is heard as a
    // machine within one note.
    const jitter = ctx.createOscillator()
    jitter.frequency.value = lerp(9, 17, rng())
    const jitterGain = ctx.createGain()
    jitterGain.gain.value = f0 * lerp(0.004, 0.013, rng())
    jitter.connect(jitterGain); jitterGain.connect(osc.frequency)
    jitter.start(time); jitter.stop(time + dur + 0.05)

    const peak = lerp(0.18, 0.34, rng())
    const end = scheduleEnvelope(env.gain, time, peak, 0.008, dur)
    osc.start(time); osc.stop(end + 0.02)
    harm.start(time); harm.stop(end + 0.02)
    autoDispose(osc, [harmGain, env, throat, jitterGain])
    harm.onended = () => { try { harm.disconnect() } catch { /* gone */ } }

    // Onset transient: ~7 ms of bandpassed noise. Cheap, and it is most of
    // what separates a bird from a bleep — but only if it is heard. It has to
    // arrive BEFORE the tone (6 ms early: forward masking is weak, so a burst
    // a few milliseconds ahead is audible where the same burst at the same
    // instant is not), sit OUTSIDE the tone's critical band (1.7x the starting
    // pitch, not a quarter-octave off), and be loud (1.4x the syllable peak:
    // the noise buffer runs about 16 dB below an oscillator's full scale).
    // Simultaneous, in-band and 15 dB down is completely masked.
    const trLead = 0.006
    const tr = ctx.createBufferSource()
    tr.buffer = this._buffer
    const trBp = ctx.createBiquadFilter()
    trBp.type = 'bandpass'
    trBp.frequency.value = clamp(curve[0] * 1.7, 200, 12000)
    trBp.Q.value = 0.5
    const trEnv = ctx.createGain()
    tr.connect(trBp); trBp.connect(trEnv); trEnv.connect(dest)
    const trEnd = scheduleEnvelope(trEnv.gain, time - trLead, peak * 1.4, 0.001, 0.006)
    tr.start(time - trLead, rng() * this._buffer.duration)
    tr.stop(trEnd + 0.02)
    autoDispose(tr, [trBp, trEnv])

    return end
  }
}
