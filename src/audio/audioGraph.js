/**
 * audioGraph.js — the fixed node graph everything else plays into.
 *
 * Built once by audio.js at start(); nothing here is created per frame. The
 * voices (audioVoices.js) and the paint layer (audioPaint.js) receive the
 * destinations they belong to and never see the rest of the graph.
 *
 * THE TWO PATHS, and why they are separate. The three natural voices share one
 * acoustic — one bus, one distance stage, one reverb send — so they recede
 * together as a single world when the painting arrives. The paint layer joins
 * AFTER that stage and never passes through it, which is what lets the picture
 * arrive close and dry at the instant the landscape it depicts is pushed into
 * the distance. Wire the paint into the world bus and that contrast is gone.
 *
 * GAIN-STAGE DISCIPLINE. Two gains sit in series on the world path and they
 * are deliberately NOT merged:
 *
 *   worldBus   the room-mode drain (audio.js _applyDistance)
 *   worldDry   the distance crossfade's dry half (same place)
 *
 * One writer (one quantity) per parameter: a per-frame `setTargetAtTime` and any other write
 * on the same AudioParam fight, and the per-frame one wins.
 */

/** Time constant for per-frame control writes (setTargetAtTime). Below ~50 ms
 *  a per-frame setTargetAtTime stops smoothing and starts stepping. */
export const CONTROL_TAU = 0.08

const ER_TAP_A_S = 0.011   // early reflections: a small, hard room for the paint
const ER_TAP_B_S = 0.019

/**
 * @param {AudioContext} ctx
 * @param {AudioBuffer}  impulse  stereo reverb IR (audioNoise.createImpulseResponse)
 */
export function createAudioGraph(ctx, impulse) {
  // ── Master — starts silent; setMuted(false) ramps it up ────────────────────
  const master = ctx.createGain()
  master.gain.value = 0
  master.connect(ctx.destination)

  // ── World path ─────────────────────────────────────────────────────────────
  const worldDry = ctx.createGain()
  worldDry.gain.value = 1
  worldDry.connect(master)

  // The distance stage. Wide open at rest: a lowpass at 18 kHz is audibly
  // transparent, so the same node can sit in the path permanently rather than
  // being spliced in when the painting starts (a reconnect mid-signal clicks).
  const worldLP = ctx.createBiquadFilter()
  worldLP.type = 'lowpass'
  worldLP.frequency.value = 18000
  worldLP.Q.value = 0.707
  worldLP.connect(worldDry)

  const worldBus = ctx.createGain()
  worldBus.gain.value = 1
  worldBus.connect(worldLP)

  // ── Reverb ─────────────────────────────────────────────────────────────────
  const convolver = ctx.createConvolver()
  convolver.buffer = impulse
  convolver.normalize = true

  const reverbReturn = ctx.createGain()
  reverbReturn.gain.value = 1
  convolver.connect(reverbReturn)
  // The return re-enters the world path AT THE DISTANCE STAGE. Straight into
  // the master it would bypass worldLP and worldDry, so as the painting comes
  // up every reverb tail would stay full-bandwidth and full-level — an anti-cue
  // against the one gesture this graph exists to make. Not at worldBus either:
  // worldBus feeds worldSend feeds the convolver, a feedback loop.
  reverbReturn.connect(worldLP)

  // The world's own send. Near-silent normally — wind and surf are already
  // diffuse and convolving them adds nothing — and opened by the distance
  // control, which is the mechanism behind "the world steps back".
  const worldSend = ctx.createGain()
  worldSend.gain.value = 0.03
  worldBus.connect(worldSend)
  worldSend.connect(convolver)

  // ── Per-voice solo stages ──────────────────────────────────────────────────
  // One gain per voice between the voice and the world bus, so a debug solo
  // can silence its siblings without touching any parameter the running
  // simulation also writes.
  //
  // Each voice also gets its own SEND gain, muted by the same solo. The
  // one-shots (breaks, bird calls) feed the convolver, which sits outside
  // voiceGains; without a soloed send, soloing the wind would silence the dry
  // birds and breaks while their wet copies played on.
  const voiceGains = {}
  const voiceSends = {}
  for (const name of ['wind', 'trees', 'surf', 'birds']) {
    const g = ctx.createGain()
    g.gain.value = 1
    g.connect(worldBus)
    voiceGains[name] = g

    const s = ctx.createGain()
    s.gain.value = 1
    s.connect(convolver)
    voiceSends[name] = s
  }

  // ── Paint path — dry, close, never through the distance stage ──────────────
  const paintBus = ctx.createGain()
  paintBus.gain.value = 1
  paintBus.connect(master)

  // A pair of early reflections. Fully dry reads as headphone-y rather than
  // close; two short taps give the paint a small hard room, which is what
  // actually separates "near" from "no space at all".
  for (const [time, level] of [[ER_TAP_A_S, 0.16], [ER_TAP_B_S, 0.1]]) {
    const delay = ctx.createDelay(0.1)
    delay.delayTime.value = time
    const tap = ctx.createGain()
    tap.gain.value = level
    paintBus.connect(delay)
    delay.connect(tap)
    tap.connect(master)
  }

  return {
    master, worldDry, worldLP, worldBus, worldSend,
    convolver, reverbReturn, voiceGains, voiceSends, paintBus,
  }
}

/**
 * Attack/decay envelope for a one-shot voice, written safely.
 *
 * Three rules are encoded here because each one is a bug that is silent until
 * it isn't:
 *
 *  1. A GainNode's gain defaults to 1 and HOLDS it until the first scheduled
 *     event. Without an explicit setValueAtTime(0) at exactly the start time,
 *     the voice plays at full level for the gap between start() and the first
 *     ramp — a click on every single one-shot.
 *  2. exponentialRampToValueAtTime(0) throws: the target must be non-zero.
 *     Ramping to a small epsilon and then setting 0 gives the exponential
 *     shape ears expect AND lands at true silence.
 *  3. stop() must come AFTER the envelope has reached zero, never at the same
 *     instant, or the source is cut mid-decay.
 *
 * @returns {number} the time at which the voice is fully silent
 */
export function scheduleEnvelope(param, startTime, peak, attack, decay) {
  const eps = 1e-4
  const attackEnd = startTime + attack
  const end = attackEnd + decay
  param.setValueAtTime(0, startTime)
  param.linearRampToValueAtTime(peak, attackEnd)
  param.exponentialRampToValueAtTime(Math.max(peak * 0.001, eps), end)
  param.setValueAtTime(0, end)
  return end
}

/**
 * Tear down a one-shot's whole chain once its source has finished.
 *
 * The source node itself is collectable when it ends, but every node
 * DOWNSTREAM of it stays reachable from the destination and is never collected
 * — so a voice that only drops its source reference leaks its gain, filter and
 * panner forever. At tens of voices a second over a gallery evening that is
 * the one failure mode here that compounds rather than merely sounding poor.
 */
export function autoDispose(source, nodes) {
  source.onended = () => {
    source.onended = null
    try { source.disconnect() } catch { /* already gone */ }
    for (const n of nodes) {
      try { n.disconnect() } catch { /* already gone */ }
    }
  }
}
