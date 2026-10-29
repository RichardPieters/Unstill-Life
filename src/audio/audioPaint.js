/**
 * audioPaint.js — the sound of the picture being made, and of it coming apart.
 *
 * This is the one layer that is NOT a landscape sound. It plays into the dry
 * paint bus (audioGraph.js), never through the world's distance stage, so it
 * arrives close and hard at the same moment the landscape it depicts is pushed
 * away. That contrast is the whole point of the layer; routing it into the
 * world bus would delete it.
 *
 * Driven by the art pass's own reveal phases, handed down from audio.js:
 *   priming  → a dry brushed sweep as the canvas tones
 *   marks    → grains, clustering into strokes, thickening with the paint
 *   relief   → a low body as the paint gains depth under the lamp
 *   dissolve → sparse cracks and flaking as the strokes leave
 */

import { clamp, clamp01 } from '../shared/mathUtils.js'
import { scheduleEnvelope, autoDispose } from './audioGraph.js'
import { lerp, logLerp, grainRate } from './audioMath.js'

const LOOKAHEAD_S = 0.15    // schedule this far ahead of the audio clock

/**
 * How long one burst of marks lasts, AS A FRACTION OF THE WHOLE REVEAL.
 *
 * In absolute seconds a half-second reveal and a forty-second one — both legal
 * settings — would get the identical cluster cadence: at the short end the
 * whole gesture is over inside one burst, at the long end the same burst
 * repeats eighty times and becomes a texture with no phrasing. As a fraction,
 * the brushwork phrases with the animation at every duration; the clamp keeps
 * a burst between 0.12 and 1.6 s.
 */
const STROKE_MIN_FRAC = 0.02
const STROKE_MAX_FRAC = 0.075
const STROKE_CLAMP_S = [0.12, 1.6]

/**
 * How many cracks the whole picture's worth of strokes leaving is worth.
 *
 * Expressed per PICTURE rather than per second: the cracks follow the share of
 * strokes that have actually left (`phase.removed`), so a burst of strokes going
 * is a burst of cracks, and an exit of any length sounds the same in total. A
 * fixed per-second rate would make a long exit a wall of crackling and a short
 * one a couple of isolated ticks.
 */
const CRACKS_PER_EXIT = 70
// Cracks owed grow as the share removed to this power, not in proportion to it.
// A proportional rate gives one crack per ~100 strokes, so the first handful of
// strokes to go would be silent; below 1 the opening strokes each count for
// more, and the total over the whole exit is the same.
const CRACK_CURVE = 0.5
// A burst is spread over frames rather than fired at once, and a backlog is
// dropped: the sound follows the picture, it does not queue behind it.
const MAX_CRACKS_PER_UPDATE = 4
const MAX_CRACK_BACKLOG = 8

/**
 * Grains are scheduled against ctx.currentTime with a lookahead window, NOT
 * once per animation frame.
 *
 * Two reasons. At fifty grains a second a per-frame Bernoulli test would need
 * λ·dt ≈ 0.83, far outside the range where that approximation is a Poisson
 * process at all. And a frame-driven scheduler stops with requestAnimationFrame
 * when the tab is backgrounded, then dumps everything it owes in one burst on
 * refocus.
 */
export class PaintVoice {
  constructor(ctx, dest, buffer, rng) {
    this._ctx = ctx
    this._dest = dest
    this._buffer = buffer
    this._rng = rng

    this._nextGrain = 0
    this._crackDebt = 0      // cracks owed for strokes that have left
    this._removedSeen = 0    // the removed share the debt has been charged up to
    this._stroke = null      // { until, centre, drift } — the current brush stroke
    this._revealEnd = 0      // audio-clock time the running reveal ends; no mark is laid past it

    // The relief body: always connected, silent unless the paint has depth.
    this._bodySrc = ctx.createBufferSource()
    this._bodySrc.buffer = buffer
    this._bodySrc.loop = true
    this._bodyLp = ctx.createBiquadFilter()
    this._bodyLp.type = 'lowpass'
    this._bodyLp.frequency.value = 420
    // Rumble cut, for the same reason the wind has one. Measured without it,
    // this body was 82% of everything the reveal produced, all of it under
    // 250 Hz and dead centre — a low mono hum with the brushwork about 1% of
    // the energy underneath, masked by its own accompaniment.
    this._bodyHp = ctx.createBiquadFilter()
    this._bodyHp.type = 'highpass'
    this._bodyHp.frequency.value = 110
    this._bodyHp.Q.value = 0.7
    this._bodyGain = ctx.createGain()
    this._bodyGain.gain.value = 0
    this._bodySrc.connect(this._bodyHp)
    this._bodyHp.connect(this._bodyLp)
    this._bodyLp.connect(this._bodyGain)
    this._bodyGain.connect(dest)
    this._bodySrc.start(ctx.currentTime, rng() * buffer.duration)

    // ── The weave ─────────────────────────────────────────────────────────
    // Canvas tooth passing under the bristles: a rasp in the 40–220 Hz band.
    // This is the difference between a brush and a puff of noise, and it is
    // the one thing a bandpassed grain can never have.
    //
    // SHARED and always running, connected to each drag's own gain param for
    // the length of that drag. One modulator for the whole layer rather than
    // three more nodes per event: the documented cost here is main-thread node
    // churn, not DSP, and this runs while an expensive post-process paints.
    this._weaveSrc = ctx.createBufferSource()
    this._weaveSrc.buffer = buffer
    this._weaveSrc.loop = true
    this._weaveBp = ctx.createBiquadFilter()
    this._weaveBp.type = 'bandpass'
    this._weaveBp.frequency.value = 110
    this._weaveBp.Q.value = 0.8
    this._weaveSrc.connect(this._weaveBp)
    this._weaveSrc.start(ctx.currentTime, rng() * buffer.duration)
  }

  /**
   * @param phase {{ priming, marks, relief, dissolve, duration, blocking }}
   *   The first four are each [0,1]: `marks` is how much of the picture has
   *   been laid, `dissolve` how far the exit has run. Both zero means nothing
   *   is happening and this layer is silent.
   *
   *   `duration` is how long the running gesture lasts in seconds, so the
   *   phrasing can scale with it. `blocking` says the reveal is inside its
   *   BLOCKING-IN BEAT — the opening fraction in which only marks lying
   *   against an edge are drawn.
   *
   *   That beat is the one genuine discontinuity in the animation that is
   *   visible from here. Everything finer is out of reach: the marks are a
   *   per-pixel hashed field evaluated on the GPU, there is no per-stroke event
   *   on this side of the wire at all, and the reveal's own progress is exactly
   *   linear in time — so differentiating it recovers a constant, not a rate.
   */
  update(dt, phase, level = 1) {
    const ctx = this._ctx
    const now = ctx.currentTime

    // Well back. It is the room the brushwork happens in, not the event.
    this._bodyGain.gain.setTargetAtTime(clamp01(phase.relief) * 0.035 * level, now, 0.15)

    if (phase.marks > 0 && phase.marks < 1 && phase.dissolve <= 0) {
      this._scheduleGrains(phase.marks, level, phase)
    } else {
      this._nextGrain = Math.max(this._nextGrain, ctx.currentTime)
      this._stroke = null
    }

    if (phase.dissolve > 0 && phase.dissolve < 1) {
      this._scheduleCracks(phase, level)
    } else {
      this._crackDebt = 0
      this._removedSeen = 0
    }
  }

  /**
   * The priming sweep: one long band of noise whose centre travels, heard once
   * as the canvas is toned. Called when the reveal starts.
   */
  primeSweep(duration, level = 1) {
    const ctx = this._ctx
    const rng = this._rng
    const now = ctx.currentTime + 0.02
    const dur = Math.max(duration, 0.3)

    const src = ctx.createBufferSource()
    src.buffer = this._buffer
    src.loop = true

    const bp = ctx.createBiquadFilter()
    bp.type = 'bandpass'
    bp.Q.value = 0.9
    bp.frequency.setValueAtTime(900, now)
    bp.frequency.exponentialRampToValueAtTime(2600, now + dur)

    const env = ctx.createGain()
    const pan = ctx.createStereoPanner()
    pan.pan.setValueAtTime(-0.35, now)
    pan.pan.linearRampToValueAtTime(0.35, now + dur)

    src.connect(bp); bp.connect(env); env.connect(pan); pan.connect(this._dest)

    // A long, flat-topped envelope: a drag, not a hit.
    const peak = 0.09 * level
    env.gain.setValueAtTime(0, now)
    env.gain.linearRampToValueAtTime(peak, now + dur * 0.25)
    env.gain.setValueAtTime(peak, now + dur * 0.7)
    env.gain.linearRampToValueAtTime(0, now + dur)

    src.start(now, rng() * this._buffer.duration)
    src.stop(now + dur + 0.05)
    autoDispose(src, [bp, env, pan])
  }

  /** One brush stroke's worth of grains, on demand (debug audition). */
  strokeNow(level = 1) {
    this._stroke = null
    this._nextGrain = this._ctx.currentTime
    const until = this._ctx.currentTime + 0.6
    while (this._nextGrain < until) {
      this._grain(this._nextGrain, 0.7, level)
      this._nextGrain += 1 / lerp(12, 30, this._rng())
    }
  }

  /** A single crack, on demand (debug audition). */
  crackNow(level = 1) { this._crack(this._ctx.currentTime + 0.02, 1, level) }

  // ── private ────────────────────────────────────────────────────────────────

  _scheduleGrains(progress, level, phase = {}) {
    const ctx = this._ctx
    const rng = this._rng
    const horizon = ctx.currentTime + LOOKAHEAD_S
    if (this._nextGrain < ctx.currentTime) this._nextGrain = ctx.currentTime
    const dur = Number.isFinite(phase.duration) && phase.duration > 0 ? phase.duration : 12
    this._revealEnd = ctx.currentTime + Math.max(0, (1 - clamp01(progress)) * dur)

    // Blocking in is DRAWING, not filling: a few decisive marks placed against
    // the edges, with air between them. Sparser and harder is the whole
    // difference, and it is audible precisely because what follows is dense.
    const blocking = !!phase.blocking
    const rate = grainRate(progress) * (blocking ? 0.35 : 1)
    while (this._nextGrain < horizon) {
      // Stop at the gesture's own end, not the lookahead's. The scheduler runs
      // 150 ms ahead of the audio clock and a mark is a 60-250 ms drag, so
      // otherwise the last marks would be laid after the picture had visibly
      // finished — the brush still working over a painting already done.
      if (this._nextGrain > this._revealEnd) break
      // Grains cluster into STROKES that share a slowly drifting centre
      // frequency. Randomising every grain's filter independently averages to
      // flat noise, which reads as rain; a shared centre within a burst is
      // what makes the ear hear one object moving across a surface.
      if (!this._stroke || this._nextGrain > this._stroke.until) {
        this._stroke = {
          until: this._nextGrain + clamp(lerp(STROKE_MIN_FRAC, STROKE_MAX_FRAC, rng()) * dur,
            STROKE_CLAMP_S[0], STROKE_CLAMP_S[1]),
          // Blocking in sits darker — a drawing tool on a toned ground rather
          // than loaded colour on colour.
          centre: blocking ? logLerp(500, 1700, rng()) : logLerp(800, 3400, rng()),
          drift: lerp(-0.25, 0.25, rng()),
        }
      }
      this._grain(this._nextGrain, progress, level, blocking ? 1.5 : 1)
      // Within a stroke the grains are dense; between strokes there is a gap,
      // so the texture has articulation rather than a uniform hiss.
      const gap = this._nextGrain + 1 / rate > this._stroke.until
        ? lerp(0.05, 0.22, rng())
        : 1 / rate * lerp(0.6, 1.5, rng())
      this._nextGrain += gap
    }
  }

  /**
   * One brush mark: a DRAG, not a tick.
   *
   * A 5–15 ms burst through a Q 4–11 bandpass is a click or a pluck — the
   * sound of something being struck once — and a picture built out of
   * thousands of them reads as rain on a roof. A brush on canvas is a
   * 60–250 ms event: the bristles take time
   * to cross the weave, so it has a SOFT attack, a body while the hand moves,
   * and a decay as the pressure lifts.
   *
   * Three things make it a brush rather than a filtered puff:
   *   - length, so there is a during and not only an onset
   *   - a BROAD filter (Q 0.7–1.5). A high Q is a resonance, i.e. a pitch, and
   *     a pitched brush stroke is the surest possible tell that this is a
   *     synthesizer.
   *   - the weave rasp, amplitude-modulating the drag from the shared 40–220 Hz
   *     modulator. Canvas tooth under bristles is the identifying cue, and no
   *     amount of filtering a smooth noise burst will produce it.
   */
  _grain(time, progress, level, weight = 1) {
    const ctx = this._ctx
    const rng = this._rng
    const stroke = this._stroke
    const centre = stroke
      ? clamp(stroke.centre * Math.pow(2, stroke.drift * rng()), 600, 4200)
      : logLerp(800, 3000, rng())

    const src = ctx.createBufferSource()
    src.buffer = this._buffer
    src.playbackRate.value = lerp(0.85, 1.3, rng())

    const bp = ctx.createBiquadFilter()
    bp.type = 'bandpass'
    bp.frequency.value = centre
    bp.Q.value = lerp(0.7, 1.5, rng())   // broad: a brush, never a pitch

    const hp = ctx.createBiquadFilter()
    hp.type = 'highpass'
    hp.frequency.value = 300

    const env = ctx.createGain()
    const pan = ctx.createStereoPanner()
    pan.pan.value = (rng() * 2 - 1) * 0.85   // wide: close sources spread

    src.connect(bp); bp.connect(hp); hp.connect(env); env.connect(pan)
    pan.connect(this._dest)

    // Peaks this high because the brushwork, not the relief body (which sits
    // well back), carries this layer's level: cutting the body back at a lower
    // grain peak measured the whole reveal 8.7 dB quieter.
    const peak = lerp(0.1, 0.24, rng()) * lerp(0.6, 1, progress) * level * weight
    const attack = lerp(0.008, 0.025, rng())
    const decay = lerp(0.05, 0.2, rng())
    const end = scheduleEnvelope(env.gain, time, peak, attack, decay)

    // The rasp rides ON the drag's own envelope, so it is present only while
    // the bristles are actually moving. Depth is a fraction of the peak, which
    // keeps it a texture rather than a tremolo.
    const weave = ctx.createGain()
    weave.gain.value = peak * lerp(0.3, 0.7, rng())
    this._weaveBp.connect(weave)
    weave.connect(env.gain)

    src.start(time, rng() * this._buffer.duration)
    src.stop(end + 0.02)
    // autoDispose owns onended and unwires `weave` with the rest, which also
    // disconnects it from env.gain — setting our own onended here would simply
    // be overwritten by it.
    autoDispose(src, [bp, hp, env, pan, weave])
  }

  /**
   * Cracks for the strokes that left since the last call: the share removed
   * (the art pass counts it, burst for burst, however the drift rule decides
   * who goes) times CRACKS_PER_EXIT is the number owed, played within the next
   * lookahead window. Nothing is owed before the first stroke leaves.
   */
  _scheduleCracks(phase, level) {
    const ctx = this._ctx
    const rng = this._rng
    const removed = clamp01(phase.removed ?? 0)
    const owed = share => CRACKS_PER_EXIT * share ** CRACK_CURVE
    this._crackDebt = Math.min(MAX_CRACK_BACKLOG,
      this._crackDebt + Math.max(0, owed(removed) - owed(this._removedSeen)))
    this._removedSeen = Math.max(this._removedSeen, removed)

    const n = Math.min(Math.floor(this._crackDebt), MAX_CRACKS_PER_UPDATE)
    this._crackDebt -= n
    for (let i = 0; i < n; i++) {
      this._crack(ctx.currentTime + rng() * LOOKAHEAD_S, phase.dissolve, level)
    }
  }

  /**
   * A crack: the SNAP of the paint film parting, a brief TEARING scrape as it
   * peels from the ground, then the panel's own faint resonance underneath.
   *
   * One high-Q burst is the recipe for a plucked string, not for something
   * breaking. Material failure has two parts and the ear uses both: a wideband
   * impulse with no pitch at all, and immediately under it the short resonance
   * of whatever the material is stretched over. Only the second part has a
   * pitch, and it must be well below the first in level or the whole thing
   * reads as a note.
   *
   * That resonance is NOT one coherent filter. A single narrow resonant
   * filter (Q 8–18) excited by an impulse IS the textbook struck-tube model
   * and sounds like a pipe; add a downward pitch glide and soft attack and it
   * is the standard synthesized water drop. Dry material failure neither
   * rings nor bends: it happens at several points nearly at once, so the body
   * is a cluster of 2–3 tiny, irregularly-timed micro-fractures, each its own
   * short, FIXED-pitch burst. A PEEL layer — a broad mid-band scrape riding
   * the shared weave rasp — supplies the tearing: paint lifting off a ground
   * is a scrape first, not only a snap.
   *
   * The decay is matched to the ~240 ms a stroke actually takes to fade off
   * the canvas at the shipped exit settings, so a crack lasts about as long as
   * the thing it is the sound of. The onset is faster than anything on screen
   * — that is deliberate and is the one invented part: a fade has no attack to
   * synchronise with, and a soft-onset crack is not a crack.
   */
  _crack(time, progress, level) {
    const ctx = this._ctx
    const rng = this._rng
    // Loud. This is the only violent thing the paint layer does; at an rms of
    // 0.0002 — 32 dB under the brushwork — the picture came apart in silence.
    const peak = lerp(0.18, 0.4, rng()) * lerp(0.7, 1, progress) * level
    const pan = ctx.createStereoPanner()
    pan.pan.value = (rng() * 2 - 1) * 0.8
    pan.connect(this._dest)
    // Every source of this crack, with its end time and the nodes it owns; the
    // panner goes with whichever ends last.
    const parts = []
    const own = (src, end, nodes) => parts.push({ src, end, nodes })

    // ── The snap: wideband, no pitch, gone in milliseconds ────────────────
    const snap = ctx.createBufferSource()
    snap.buffer = this._buffer
    snap.playbackRate.value = lerp(0.9, 1.4, rng())
    const snapHp = ctx.createBiquadFilter()
    snapHp.type = 'highpass'
    snapHp.frequency.value = lerp(900, 1800, rng())
    snapHp.Q.value = 0.7
    // CAPPED. An open highpass on pink noise runs to Nyquist: measured
    // uncapped, 12% of the crack's energy sat in the 16 kHz octave and the
    // centroid at 7.8 kHz, which is a "tss" — an air leak, not a material
    // parting. Paint cracking is bright, not ultrasonic.
    const snapLp = ctx.createBiquadFilter()
    snapLp.type = 'lowpass'
    snapLp.frequency.value = lerp(5200, 7600, rng())
    snapLp.Q.value = 0.7
    const snapEnv = ctx.createGain()
    snap.connect(snapHp); snapHp.connect(snapLp); snapLp.connect(snapEnv); snapEnv.connect(pan)
    const snapEnd = scheduleEnvelope(snapEnv.gain, time, peak, 0.0006, lerp(0.004, 0.011, rng()))
    snap.start(time, rng() * this._buffer.duration)
    snap.stop(snapEnd + 0.02)
    own(snap, snapEnd, [snapHp, snapLp, snapEnv])

    // ── The body: a CLUSTER of 2-3 tiny, irregularly-timed micro-fractures,
    // each at its own FIXED (never sweeping) frequency — see the doc above for
    // why neither a single resonance nor a glide.
    const microCount = rng() < 0.5 ? 2 : 3
    let microAt = time
    for (let i = 0; i < microCount; i++) {
      if (i > 0) microAt += lerp(0.008, 0.03, rng())
      const at = microAt
      const src = ctx.createBufferSource()
      src.buffer = this._buffer
      src.playbackRate.value = lerp(0.7, 1.3, rng())
      const bp = ctx.createBiquadFilter()
      bp.type = 'bandpass'
      bp.frequency.value = logLerp(220, 950, rng())    // fixed — no glide
      bp.Q.value = lerp(1.5, 3.5, rng())                // broad: colour, not a note
      const env = ctx.createGain()
      src.connect(bp); bp.connect(env); env.connect(pan)
      const g = peak * lerp(0.25, 0.5, rng()) / microCount
      const end = scheduleEnvelope(env.gain, at, g, 0.001, lerp(0.02, 0.06, rng()))
      src.start(at, rng() * this._buffer.duration)
      src.stop(end + 0.02)
      own(src, end, [bp, env])
    }

    // ── The peel: a broad, ragged mid-band scrape riding the shared weave
    // rasp (the same modulator the brush grains use) — paint TEARING off its
    // ground, which the impact-plus-resonance pair above cannot supply on its
    // own. Q stays low on purpose: a scrape, never a tone.
    const peel = ctx.createBufferSource()
    peel.buffer = this._buffer
    peel.playbackRate.value = lerp(0.8, 1.3, rng())
    const peelBp = ctx.createBiquadFilter()
    peelBp.type = 'bandpass'
    peelBp.frequency.value = logLerp(1200, 3200, rng())
    peelBp.Q.value = lerp(0.6, 1.2, rng())
    const peelEnv = ctx.createGain()
    peel.connect(peelBp); peelBp.connect(peelEnv); peelEnv.connect(pan)
    const peelPeak = peak * lerp(0.35, 0.6, rng())
    const peelEnd = scheduleEnvelope(peelEnv.gain, time, peelPeak,
      lerp(0.01, 0.03, rng()), lerp(0.08, 0.2, rng()))
    const peelRasp = ctx.createGain()
    peelRasp.gain.value = peelPeak * lerp(0.4, 0.8, rng())
    this._weaveBp.connect(peelRasp); peelRasp.connect(peelEnv.gain)
    peel.start(time, rng() * this._buffer.duration)
    peel.stop(peelEnd + 0.03)
    own(peel, peelEnd, [peelBp, peelEnv, peelRasp])

    // ── Debris: sometimes a flake actually falls ──────────────────────────
    // Sparse on purpose. Every crack shedding something is a rattle; one in
    // three is what makes the others sound like they happened to a surface.
    if (rng() < 0.34) {
      const bit = ctx.createBufferSource()
      bit.buffer = this._buffer
      bit.playbackRate.value = lerp(1.1, 1.8, rng())
      const bitBp = ctx.createBiquadFilter()
      bitBp.type = 'bandpass'
      bitBp.frequency.value = logLerp(2200, 5000, rng())
      bitBp.Q.value = lerp(3, 8, rng())
      const bitEnv = ctx.createGain()
      bit.connect(bitBp); bitBp.connect(bitEnv); bitEnv.connect(pan)
      const at = time + lerp(0.03, 0.14, rng())
      const bitEnd = scheduleEnvelope(bitEnv.gain, at, peak * lerp(0.1, 0.25, rng()),
        0.0008, lerp(0.006, 0.02, rng()))
      bit.start(at, rng() * this._buffer.duration)
      bit.stop(bitEnd + 0.02)
      own(bit, bitEnd, [bitBp, bitEnv])
    }

    parts.reduce((a, b) => (b.end > a.end ? b : a)).nodes.push(pan)
    for (const { src, nodes } of parts) autoDispose(src, nodes)
  }

}
