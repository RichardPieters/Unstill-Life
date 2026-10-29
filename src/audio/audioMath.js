/**
 * audioMath.js — the pure core of the soundscape.
 *
 * No AudioContext, no DOM, no wall clock, no global RNG: every function here
 * takes explicit scalars and, where it needs randomness, a `rng` argument
 * (`() => number` in [0,1)). audio.js and its voice modules own the Web Audio
 * graph and the state; this file owns the arithmetic, so the parts that are
 * actually checkable are checkable without a browser. See
 * tests/unit/audioMath.test.js.
 *
 * Several of these encode a correction that is easy to get wrong the obvious
 * way; the reason is recorded at each one rather than in a commit message,
 * because the obvious way LOOKS right and will be "fixed" back otherwise.
 *
 * Inputs go through shared/mathUtils' clamps, which turn NaN and undefined
 * into the lower bound. Every value here ends up on an AudioParam, where a
 * non-finite write throws and, from the render loop, aborts the frame: a
 * silent voice is a bug, a frozen scene a catastrophe.
 */

import { clamp, clamp01 } from '../shared/mathUtils.js'

// ─── small helpers ───────────────────────────────────────────────────────────

/** Linear interpolate a→b by t. */
export function lerp(a, b, t) { return a + (b - a) * t }

/**
 * mulberry32 — small deterministic PRNG, returned as `() => number` in [0,1).
 * Tommy Ettinger's Mulberry32, released into the public domain.
 *
 * Seeded rather than Math.random so a reported "it did something odd" run can
 * be reproduced, and so the noise buffers are identical between reloads while
 * the live scheduling still differs by wall-clock arrival.
 */
export function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Standard normal deviate from two uniforms (Box–Muller).
 * Guards u1 = 0, where log(0) = -Infinity would poison the walk forever.
 */
export function gaussian(rng) {
  const u1 = Math.max(rng(), 1e-12)
  const u2 = rng()
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
}

// ─── frequency / gain mappings ───────────────────────────────────────────────

/**
 * Interpolate a filter cutoff LOGARITHMICALLY: f = f0·(f1/f0)^x.
 *
 * Linear interpolation is the trap. Over 700 Hz → 18 kHz (4.68 octaves) the
 * linear midpoint is 9350 Hz — 3.74 octaves above the bottom and only 0.95
 * below the top — so the upper half of the control travel moves the cutoff
 * less than one octave and does almost nothing audible. The log form has
 * d(ln f)/dx constant, which is what "perceptually uniform" means here.
 * Requires f0 > 0.
 */
export function logLerp(f0, f1, x) {
  return f0 * Math.pow(f1 / f0, x)
}

/**
 * Equal-power crossfade weights for x ∈ [0,1] → { a, b }.
 *
 * cos²+sin² = 1, so for UNCORRELATED signals total power is constant at every
 * x. A linear fade (1-x, x) dips 3.01 dB at the midpoint, which is audible as
 * a hole in the middle of every transition. (Linear would be correct only for
 * fully correlated paths, where amplitudes rather than powers add.)
 */
export function equalPower(x) {
  const t = clamp01(x) * Math.PI / 2
  return { a: Math.cos(t), b: Math.sin(t) }
}

/**
 * Reverberation decay constant for a target RT60, in seconds.
 *
 * The impulse response's envelope is exp(-t/τ) on the AMPLITUDE, and 60 dB
 * down in amplitude is a factor of 1000, so τ = T/ln(1000). (Reading it as a
 * power decay and writing ln(10⁶) gives the same answer by a different route —
 * power falls as exp(-2t/τ) and hits 10⁻⁶ at the same t — but only if you also
 * change the exponent, which is the step that gets dropped.)
 */
export function rt60ToTau(rt60) {
  return Math.max(rt60, 0.05) / Math.log(1000)
}

/**
 * Scene fraction [0,1] → linear gain, so that "half the screen" actually
 * sounds half as loud.
 *
 * Perceived loudness goes roughly as gain^0.6 (10 dB ≈ a doubling), so for
 * loudness to track the fraction we need gain^0.6 = x, i.e. gain = x^(5/3) —
 * exactly −10 dB per halving of x. A square-root map does the OPPOSITE of what
 * it looks like it does here: it makes loudness go as x^0.3, compressing the
 * range further. Below `floor` the bed is switched fully off rather than left
 * at a denormal trickle.
 */
export function fractionToGain(x, gMax = 1, floor = 0.02) {
  const t = clamp01(x)
  return t < floor ? 0 : gMax * Math.pow(t, 5 / 3)
}

// ─── time-varying processes ──────────────────────────────────────────────────

/**
 * One step of an Ornstein–Uhlenbeck walk: a random walk pulled back toward
 * `mean`, which is what natural gusting actually looks like.
 *
 * Used instead of a sum of slow sine LFOs. A handful of sub-Hz sines reads as
 * a periodic wobble within minutes — the ear locks onto the fastest term — and
 * no choice of "coprime" rates fixes that, because the problem is the
 * regularity, not the repeat period.
 *
 * @param theta pull-back rate (1/s): bigger = tighter around the mean
 * @param sigma volatility; the walk's steady-state sd is sigma/√(2·theta)
 */
export function ouStep(x, mean, theta, sigma, dt, rng) {
  return x + theta * (mean - x) * dt + sigma * Math.sqrt(Math.max(dt, 0)) * gaussian(rng)
}

/** sd of a sum of three unit sines at incommensurate rates: √(3/2). Holds
 *  regardless of what the three phases represent, as long as no two of them
 *  move at the same rate (their cross terms then average to zero over any
 *  reasonably long window) — true of three random walks and equally true of
 *  three fixed-ratio sines, which is what lets swellEnvelope serve both. */
const SWELL_SIGMA = Math.sqrt(1.5)

/**
 * Swell envelope [0,1] from three phases, in radians.
 *
 * Normalised by the sum's STANDARD DEVIATION (with headroom k) and clamped —
 * NOT by its maximum of 3. Dividing by the max is the intuitive move and it
 * flattens the swell into a wobble: each sine is arcsine-distributed, the sum
 * has sd 1.2247, so (s/3+1)/2 has sd 0.204 and spends 77% of its time in the
 * middle half of the range, reaching the outer 20% under 5% of the time. The
 * lull and the peak — the whole point of a swell — essentially never arrive.
 * At k = 2 the envelope rails a few percent of the time and genuinely breathes.
 *
 * Agnostic about WHERE the phases come from: only their relative rates matter
 * to this normalisation. SurfVoice feeds it shoreSwellPhases, the angles
 * water.frag's swell() computes from the shared ripple clock.
 */
export function swellEnvelope(phases, k = 2) {
  let s = 0
  for (const p of phases) s += Math.sin(p)
  return clamp01(0.5 + s / (2 * k * SWELL_SIGMA))
}

/**
 * The three angles water.frag's swell(p, time) evaluates AT THE WATER
 * PLANE'S REFERENCE POINT (p = 0,0), where its spatial terms vanish and only
 * the shared clock carries the phase — sin(t), sin(0.8t), sin(1.3t), the
 * exact relative rates baked into that shader function.
 *
 * MUST be kept numerically identical to swell()'s three terms or the sound and
 * the foam drift apart. Two unrelated oscillators cannot be tuned into
 * agreement — any rate mismatch, however small, integrates without bound — so
 * the surf does not run one of its own: this is the same arithmetic the
 * fragment shader runs, evaluated on the CPU.
 *
 * Reference-point only: JS has no way to ask where the true shoreline sits —
 * that depends on the terrain height field, which exists solely as a GPU
 * render target — so this shares the swell's TIMING and TEMPO with the
 * visible foam, not its exact position on a particular stretch of coast. The
 * shader's small noise-detail term (uWaveNoiseMix, shipped at 0.2) is also not
 * reproduced, so the two can still disagree slightly on the rare frames where
 * that term swings hard.
 *
 * @param rippleTime the SAME clock water.frag reads as uTime (waterDriver's
 *                    _rippleTime, exposed as water.getRippleTime())
 */
export function shoreSwellPhases(rippleTime) {
  return [rippleTime, rippleTime * 0.8, rippleTime * 1.3]
}

/**
 * Should an event fire this frame, for a Poisson process of rate λ /s?
 *
 * Per-frame Bernoulli rather than drawing the next interval as −ln(U)/λ. The
 * interval draw is exact only for CONSTANT λ; redrawing it at each event
 * freezes the rate for the whole interval, so a λ that rises mid-interval is
 * ignored until the (long, because λ was low) interval expires. The bias is
 * one-sided — birds arrive seconds late when the scene fills, and on time when
 * it empties. Bernoulli tracks a moving λ with error O((λ·dt)²), negligible
 * while λ·dt stays under ~0.1.
 */
export function poissonFires(rate, dt, rng) {
  if (!(rate > 0) || !(dt > 0)) return false
  return rng() < rate * dt
}

/**
 * Schmitt trigger: true only on a rising crossing of `hi`, and only once until
 * the signal has fallen back below `lo`.
 *
 * Surf breaks are detected off a per-frame sampled envelope, and a bare
 * `env > threshold` test re-fires every frame it stays up, while a bare
 * crossing test double-fires on any ripple near the threshold. Returns the new
 * armed state alongside the decision so the caller stays pure.
 */
export function schmitt(value, armed, hi, lo) {
  if (armed && value >= hi) return { fired: true, armed: false }
  if (!armed && value <= lo) return { fired: false, armed: true }
  return { fired: false, armed }
}

// ─── forest cover ────────────────────────────────────────────────────────────

/**
 * How much of the frame is forest, [0,1] — the one scene fraction the sound
 * reads (bird call rate and canopy rustle).
 *
 * Heights are treated as spread evenly over [0,1] of the terrain's vertical
 * range, a proxy rather than a measurement (a true census would need a GPU
 * readback every frame). It only has to be monotone in the right direction:
 * raising the sea or lowering the treeline or snowline shrinks the forest band.
 * The levels of the other voices come from the macro-form dials and the scene's
 * paces, which are outside this fraction entirely.
 *
 * @param seaLevel   world units, signed, current waterline
 * @param heightMax  world units, the terrain's half-range
 * @param treeBase   [0,1] normalised height where the forest stops
 * @param snowBase   [0,1] normalised height where snow starts
 */
export function forestCover({ seaLevel, heightMax, treeBase, snowBase }) {
  const sea = clamp01(0.5 + seaLevel / (2 * Math.max(heightMax, 1e-6)))
  return Math.max(0, Math.min(clamp01(treeBase), clamp01(snowBase)) - sea)
}

// ─── voice-level maps ────────────────────────────────────────────────────────

/**
 * Wind gust → the pair of values it drives, which must move TOGETHER.
 *
 * Real wind gets louder and brighter at once, because higher air speed carries
 * more high-frequency turbulent energy. Driving level and brightness from two
 * independent processes is what makes synthetic wind read as "a volume knob on
 * a hiss", so both come from this one call on the one walk.
 *
 * @param gust [0,1] the walk's current value
 * @param pace [0,1] how fast the landscape is reshaping — scales how hard
 *             gusts hit (the WIND's clock; the swell has its own)
 */
export function windGustShape(gust, pace) {
  const g = clamp01(gust)
  const m = clamp01(pace)
  const drive = g * (0.35 + 0.65 * m)
  return {
    // Deep on purpose, and PERCEPTUALLY deep rather than linearly so. A
    // shallow floor leaves the bed audibly present at all times, which is
    // heard as a constant hiss with a wobble on it rather than as gusts
    // arriving and passing; the lull has to get genuinely quiet for the gust
    // to read as an event. Simulated, a linear map gives a modulation depth
    // of only 0.45 because the walk clips against both ends of [0,1] — passing
    // it through the same fraction→gain curve the rest of the mix uses (−10 dB
    // per halving) deepens the lull without widening the walk into the clip.
    level:  fractionToGain(0.12 + 0.88 * drive),
    // The tilt reaches 4.2 kHz: measured, a 3.2 kHz ceiling on top of pink
    // noise left 2% of the wind's energy above 2 kHz — no air at all.
    // Brightness rising with the gust is the cue that this is turbulence and
    // not a volume fader.
    tiltHz: logLerp(650, 4200, drive),
  }
}

/**
 * The wind's two independent axes, from the landscape and the sky.
 *
 * AXIS SEPARATION, and it is the whole point of this function. Overcast is
 * FORCE — how hard the air moves — and the terrain's pace is UNSTEADINESS,
 * how often that force changes. They are sourced separately and applied
 * separately (here, and to the gust walk's theta/sigma respectively), because
 * summed into one "energy" they cancel: a racing landscape under a clear sky
 * and a still one under a black sky would sound identical.
 *
 * WHY THE WEATHER MOVES THE WALK'S CENTRE RATHER THAN A SECOND FADER. "Grey
 * sky blows harder" is a request about loudness, and loudness is already spoken
 * for by the gust walk. A second gain stage on the same axis fights it — the
 * weather lifts the level while the gust's own lull pulls it back down, and
 * neither reads. Moving `mean`, the value the walk is pulled toward, relocates
 * the wind's home instead: the gusting keeps its full swing, around a higher
 * centre. One writer, one axis.
 *
 * @param mountains [0,1] how much high exposed ground there is — what there is
 *                  for the wind to sound across. Also scales how hard the
 *                  weather bites: a grey sky over flat ground is not a gale.
 * @param snowline  [0,1] where snow begins, as a normalised slider position.
 *                  HIGH means snow starts high up, i.e. a WARM frame with
 *                  little of it; the cold, bare, thin-air end is LOW.
 * @param overcast  [0,1] SHAPED overcast — how grey the sky visibly is.
 * @returns { exposure, mean, edge }
 *   `exposure` the standing level this voice is allotted, `mean` the gust
 *   walk's centre, `edge` [0,1] how hard the top end should sit. `edge` is a
 *   FRACTION, not decibels, so the caller can blend it with the gust's own
 *   brightness on one shelf rather than summing two dB figures into a shelf
 *   gain neither of them was tuned for.
 */
export function windDrive({ mountains, snowline, overcast }) {
  const m = clamp01(mountains)
  const cold = 1 - clamp01(snowline)
  const w = clamp01(overcast)

  // A high floor, deliberately. This voice's job is to always be there, and a
  // level keyed on terrain alone would silence it whenever the dials happen to
  // leave little exposed ground.
  const exposure = fractionToGain(clamp01(0.5 + 0.5 * m))
  const mean = lerp(0.26, 0.86, clamp01(w * (0.45 + 0.55 * m)))
  // Cold bare ground and a grey sky both harden the top end. Weather carries
  // most of it; the snowline is a colour, not a lever.
  const edge = clamp01(0.3 * cold + 0.7 * w)
  return { exposure, mean, edge }
}

/**
 * Wind THROUGH LEAVES — the canopy layer's level, flutter rate and band.
 *
 * What a listener identifies as wind is almost never the air itself, which is
 * nearly silent, but air ON SURFACES. Leaves are the loudest of those surfaces
 * and the most recognisable: a dense field of small impulses, broadband from
 * roughly 1 to 8 kHz, whose envelope flutters at tens of hertz. The flutter is
 * the identifying cue — it is why a recording of leaves is instantly a tree and
 * a recording of a fan is instantly a fan.
 *
 * THE FLUTTER RATE RIDES THE GUST. A leaf is a little flag: harder wind flips
 * it faster. With the rate fixed and only the depth moving, this layer sounds
 * like filtered hiss with a tremolo on it.
 *
 * @param forest [0,1] how much canopy is in frame. A floor remains at zero —
 *               grass, heath and rock edges rustle too, just far less.
 * @param gust   [0,1] the wind's current strength, already smoothed by the
 *               caller's leaf follower (leaves keep moving after the gust has
 *               passed, so the level this multiplies is a lagged one).
 * @param opts.flutterMax the flutter rate at full gust, Hz — a slider, since
 *                        species and leaf size genuinely differ here
 * @param opts.tone       [0,1] dry and thin at 0, full and bodied at 1; 0.5
 *                        leaves the band exactly where the canopy puts it
 * @returns { level, flutterHz, bandHz }
 */
export function canopyRustle(forest, gust, { flutterMax = 30, tone = 0.5 } = {}) {
  const f = clamp01(forest)
  const g = clamp01(gust)
  const fmax = Number.isFinite(flutterMax) ? clamp(flutterMax, 4, 80) : 30
  // Exponent below 1: an ordinary wooded frame sits near forest 0.28, and a
  // linear map left the canopy barely present at exactly the coverage the
  // scene spends most of its time at.
  const canopy = lerp(0.12, 1, Math.pow(f, 0.6))
  return {
    level: canopy * lerp(0.03, 0.62, g),
    flutterHz: lerp(Math.min(7, fmax), fmax, g),
    // More leaf mass means more low-mid body under the hiss — a full canopy is
    // a broader sound than dry grass, which is all top.
    // Tone rides on top of the canopy's own band, and is unity at 0.5 so the
    // shipped sound is exactly the canopy map with the knob centred.
    bandHz: clamp(logLerp(1600, 900, f) * logLerp(1.6, 0.625, clamp01(tone)), 300, 6000),
  }
}

/**
 * The water's two axes: how much sea there is, and how broken it is.
 *
 * `chop` is deliberately NOT a level. A grey day does not make the sea louder,
 * it makes it BREAK more — more foam, more events, less long smooth swell —
 * and routing weather into the surf's gain would be the same axis collision
 * windDrive exists to avoid.
 *
 * @param ocean    [0,1] the ocean dial — how much sea the frame holds
 * @param overcast [0,1] SHAPED overcast
 * @returns { presence, chop }
 */
export function surfDrive({ ocean, overcast }) {
  const o = clamp01(ocean)
  return {
    // Lifted ABOVE the wind's mask once any sea is on screen — unlifted, a
    // thin strip of ocean sits far enough under the wind to be simply masked.
    // The lifted curve is multiplied by `o`: the lift alone would leave a
    // standing roar and audible breaks at `ocean: 0`, with no water on screen
    // to explain them, where this gives exactly 0.
    presence: o * fractionToGain(clamp01(0.3 + 0.7 * o)),
    chop: clamp01(overcast),
  }
}

/**
 * Bird call rate (calls/second) from how much forest is in frame.
 *
 * Suppressed by overcast — birds genuinely do quieten under heavy weather, and
 * it gives the sky a second audible consequence beyond timbre. `activity`
 * carries the scene's own energy so an emptying landscape thins out first
 * here, which is the design's stated order of disappearance.
 */
export function birdRate(forest, overcast, activity, maxRate = 1.1) {
  const f = clamp01(forest)
  // A GENTLE direct weather term. Most of the sky's effect arrives as the cast
  // falling silent (BirdVoice's `hush`), which is what an emptying wood
  // actually sounds like: fewer voices answering, not the same voices answering
  // more slowly. Both at full strength would double-count the weather and
  // leave a grey day with essentially no birds at all.
  const weather = 1 - 0.25 * clamp01(overcast)
  // Exponent BELOW 1, not above it. Measured on the live scene, forest sits
  // around 0.2 for long stretches; at the obvious f^1.5 that yielded under
  // three calls a minute, and thirty seconds of listening produced none at
  // all. Calls are the only thing in the soundscape a listener can count, so
  // when they are this rare the piece has no audible content except two beds
  // of filtered noise. A gentle exponent keeps a bare frame quiet while
  // letting ordinary cover sound genuinely inhabited.
  return maxRate * Math.pow(f, 0.7) * weather * clamp01(activity)
}

/**
 * Distance [0,1] → the three cues that must move together for it to read.
 *
 * Level, spectrum and reverb share one control because that is what distance
 * does in air: far sources are quieter, duller (HF absorption) and more
 * reverberant. Moving any one alone reads as a filter sweep, not as distance.
 */
export function distanceCues(d, f0 = null) {
  const t = clamp01(d)
  // The cutoff is relative to the SOURCE when one is named. The fixed 9 kHz→
  // 1.4 kHz sweep suits material sitting below 1.4 kHz, where it only trims
  // air absorption; applied to a bird whose fundamental is around 2.6 kHz it
  // would drop the lowpass BELOW the fundamental at ordinary distances,
  // stripping the harmonic and the onset — the only two things keeping the
  // call from being a bare sine — long before it resembles distance.
  const cutoff = f0 == null ? logLerp(9000, 1400, t) : clamp(f0 * logLerp(4.5, 1.1, t), 800, 18000)
  return {
    gain:   lerp(1, 0.16, t),
    cutoff,
    // Outdoors there is almost no reverberant field: distance is level, air
    // absorption and a few discrete reflections, not a tail. A send that
    // reaches 0.55 puts a far bird well past critical distance — i.e. in a
    // stairwell — which a listener registers as fake without being able to
    // name why.
    send:   lerp(0.03, 0.22, t),
  }
}

/**
 * Grain density (grains/second) while the paint is being laid.
 *
 * Ramps with the marks arriving and is capped, because the cost of the grain
 * layer is main-thread node churn rather than DSP — the audio thread is idle
 * at these rates, but allocating and connecting nodes competes with the render
 * loop, and this runs while an expensive post-process is painting.
 */
export function grainRate(paintProgress, maxRate = 50) {
  return lerp(4, maxRate, clamp01(paintProgress))
}
