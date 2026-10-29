/**
 * audio.js — the soundscape: the landscape heard instead of seen.
 *
 * VOICES    Wind, trees, surf and birds, whose balance follows what is on
 *           screen, plus a dry paint layer that scores the painting arriving
 *           and leaving. No melody, key, pulse or loops: everything is
 *           generated, so no two minutes of a run repeat.
 *
 * SHAPE     This file is the orchestrator: it owns the AudioContext, the scene
 *           state, the painting transition and the debug surface. The node
 *           graph is audioGraph.js, the noise beds and reverb audioNoise.js,
 *           the voices audioVoices.js, the paint audioPaint.js, and the
 *           arithmetic audioMath.js (unit-tested without a browser).
 *
 * DRIVE     main.js pushes setSceneState() and setPaintState() every rendered
 *           frame. Not tick-subscribed: dynamics sends no 'tick' while frozen,
 *           and the frozen stretch is when the painting plays and this module
 *           has the most to do.
 *
 * DISTANCE  While a painting is up the world recedes: level, lowpass and
 *           reverb move together (`distanceDepth`, `distanceCutoff`), and haze
 *           adds to it. The paint layer bypasses that stage and stays close.
 *
 * START     start() runs on a user gesture and may fail, leaving audio off.
 *           The master starts silent; setMuted(false) ramps it in.
 *
 * DEBUG     Solo, one-shot triggers, a test tone, an output meter, signal-flow
 *           readouts and an event log, all for the Sound tab.
 */

import { clamp01 } from '../shared/mathUtils.js'
import { paramAccess } from '../shared/paramAccess.js'
import { AUDIO_PARAMS } from './audioParams.js'
import { createNoiseBuffers, createImpulseResponse } from './audioNoise.js'
import { CONTROL_TAU, createAudioGraph, scheduleEnvelope, autoDispose } from './audioGraph.js'
import { WindVoice, TreeVoice, SurfVoice, BirdVoice } from './audioVoices.js'
import { PaintVoice } from './audioPaint.js'
import { lerp, logLerp, equalPower, mulberry32 } from './audioMath.js'

const MAX_DT = 0.1          // a backgrounded tab returns with a huge dt

export class Audio {
  // ─── state ─────────────────────────────────────────────────────────────────

  constructor() {
    this._ctx = null
    this._started = false
    this._resuming = false  // a resume() is in flight
    this._muted = true
    this.params = paramAccess({ tables: [], rows: AUDIO_PARAMS })
    this._wireParams()

    this._solo = null       // 'wind' | 'trees' | 'surf' | 'birds' | 'paint' | null
    this._painting = 0      // [0,1] how fully a painting is up
    this._primeFired = false

    // What setSceneState last reported: the macro-form dials, the forest
    // share, the weather, the paces and the swell clock.
    this._scene = {
      ocean: 0.5, mountains: 0.5, snowline: 0.5, forest: 0.3,
      overcast: 0, haze: 0, motion: 1, terrainPace: 0.5, restlessness: 1, rippleTime: 0,
    }
    this._paint = { priming: 0, marks: 0, relief: 0, dissolve: 0, removed: 0, duration: 12, blocking: false }

    this._rng = mulberry32(0x5EAB17D)

    // A rolling log of the one-shots, newest last. The continuous layers can be
    // read off a meter; the one-shots cannot, and "did that button do anything"
    // and "does the scene fire these on its own" need this to answer.
    this._events = []
  }

  // ─── settings (Sound-tab sliders and toggles) ──────────────────────────────

  /** Snapshot (sceneModules.js): the rows by key, a flat { key: value } map. */
  exportState() { return this.params.export() }

  /** Replayed through `params.set`, so a restore also reaches an already-built
   *  voice (see _wireParams), exactly like dragging the slider. */
  importState(state) {
    return { unknown: this.params.import(state || {}).unknown.map(k => 'audio.' + k) }
  }

  // ─── per-frame inputs (main.js, from the render loop) ─────────────────────

  /**
   * @param s {{ ocean, mountains, snowline, forest, overcast, haze, motion,
   *             terrainPace, restlessness, rippleTime, dt }}
   *   ocean, mountains, snowline  the macro-form dials, normalised and mutually
   *                independent, so a high sea AND high
   *                mountains is an audible state (shares of one frame would only
   *                redistribute a fixed total).
   *   forest       the share of the frame that is forest (audioMath.forestCover);
   *                it sets the bird call rate and the canopy's rustle.
   *   overcast     the SHAPED scalar, the curve every visible overcast effect
   *                uses. The raw walk sits a third into the weather while the
   *                sky on screen is still clear.
   *   motion       animSpeed's water-and-cloud pace
   *   terrainPace  how fast the land reshapes; the wind's gustiness
   *   restlessness thins the birds as the scene settles
   *   rippleTime   water.frag's own clock, so the surf breaks with the visible swell
   *   dt           sim-scaled seconds, so the sound shares the landscape's clock
   *
   *   The two paces are kept apart, never averaged into one "speed": the land
   *   can be tearing along while the sea is glassy, and summed they would cancel.
   */
  setSceneState(s) {
    if (!this._started || !this._g) return
    Object.assign(this._scene, s)
    const dt = Math.min(Math.max(s.dt ?? 1 / 60, 0), MAX_DT)

    this._resumeIfNeeded()

    // Overall energy comes from the two paces, which sit outside the forest share,
    // so total level genuinely varies instead of merely redistributing. The
    // louder of the two: a still sea under a racing sky is not a quiet scene,
    // and neither is the reverse.
    const energy = Math.max(clamp01(this._scene.motion), clamp01(this._scene.terrainPace))
    const presence = lerp(0.45, 1, energy)
    // Haze is a distance cue in the picture; it reads the same way in sound.
    const hazePull = clamp01(this._scene.haze) * 0.35

    this._wind.update(dt, {
      mountains: this._scene.mountains,
      snowline: this._scene.snowline,
      overcast: this._scene.overcast,
      // The wind answers the LAND, not the waves — it is the only voice whose
      // pace can report that the terrain itself is moving.
      pace: this._scene.terrainPace,
      presence: presence * this.params.get('windLevel'),
    })
    // The trees answer the WIND's gust rather than a walk of their own: two
    // independent walks would put the canopy out of step with the air that is
    // supposed to be moving it.
    this._trees.update(dt, {
      forest: this._scene.forest,
      gust: this._wind.getGust(),
      presence: presence * this.params.get('treeLevel'),
    })
    this._surf.update(dt, {
      ocean: this._scene.ocean,
      overcast: this._scene.overcast,
      motion: this._scene.motion,
      rippleTime: this._scene.rippleTime,
      presence: presence * this.params.get('surfLevel'),
      breakLevel: this.params.get('breakLevel'),
    })
    this._birds.update(dt, {
      forest: this._scene.forest,
      overcast: this._scene.overcast,
      // Birds thin out first as the scene settles — the design's stated order
      // in which the world empties.
      activity: clamp01(this._scene.restlessness) * this.params.get('birdRateScale'),
    })

    this._paintVoice.update(dt, this._paint,
      this.params.get('paintEnabled') && (this._solo == null || this._solo === 'paint')
        ? this.params.get('paintLevel') : 0)

    this._applyDistance(this._painting, hazePull)
  }

  /**
   * Where the art pass is in its entrance/exit, from artPass's progress
   * getters. Called every frame alongside setSceneState.
   *
   * @param p {{ priming, marks, exit, removed, revealing, exiting, enabled,
   *             primeDuration, revealDuration, exitDuration, edgeBeat, edgesFirst }}
   */
  setPaintState(p) {
    if (!this._started) return

    // The priming sweep is a one-shot, fired on the transition INTO a reveal
    // rather than every frame the reveal is running.
    if (p.revealing && !this._primeFired) {
      this._primeFired = true
      if (this.params.get('paintEnabled')) this._paintVoice.primeSweep(p.primeDuration ?? 1.2, this.params.get('paintLevel'))
    }
    if (!p.revealing && !p.enabled) this._primeFired = false

    // The paint is audible ONLY while it is being made or coming apart. At
    // rest the reveal readouts sit at 1 — "fully painted" — which read as a
    // level would drone the relief body for the entire run. A finished picture
    // simply hanging there has nothing to say.
    const making = p.revealing
    this._paint.priming = making ? clamp01(p.priming) : 0
    this._paint.marks = making ? clamp01(p.marks) : 0
    // Relief trails the marks, the way the paint visibly thickens only after
    // coverage completes.
    this._paint.relief = making ? clamp01((p.marks - 0.25) / 0.75) : 0
    this._paint.dissolve = p.exiting ? clamp01(p.exit) : 0
    // The share of strokes that have actually left, which follows the picture.
    this._paint.removed = p.exiting ? clamp01(p.removed ?? 0) : 0
    // How long the RUNNING gesture lasts, so the brushwork phrases with it at
    // any setting rather than at one tuned duration.
    this._paint.duration = p.exiting
      ? (p.exitDuration ?? 4)
      : (p.revealDuration ?? 12)
    // The blocking-in beat: the opening fraction of the reveal in which only
    // marks against an edge are drawn. The one discontinuity in the animation
    // that is visible from this side — everything finer happens per-pixel on
    // the GPU and never reaches JS.
    this._paint.blocking = making && !!p.edgesFirst && clamp01(p.marks) < clamp01(p.edgeBeat ?? 0)

    // How fully a picture is up, which is what the world's distance follows.
    if (p.exiting) this._painting = 1 - clamp01(p.exit)
    else if (p.revealing) this._painting = clamp01(0.3 * this._paint.priming + 0.7 * this._paint.marks)
    else this._painting = p.enabled ? 1 : 0
  }

  // ─── debug surface (Sound tab) ─────────────────────────────────────────────

  /** Hear one layer alone. null restores the full mix. */
  setSolo(name) {
    this._solo = name || null
    this._applySolo()
  }

  /** Fire one sound in isolation, so every element can be auditioned. */
  trigger(what) {
    if (!this._started) return
    switch (what) {
      case 'bird':      this._birds.call(0.15); break     // close, so it can be judged
      case 'birdFar':   this._birds.call(0.9);  break
      case 'break':     this._surf.breakNow(0.3 * this.params.get('breakLevel')); break
      case 'gust':      this._trees.gustNow(); break
      case 'stroke':    this._paintVoice.strokeNow(this.params.get('paintLevel')); break
      case 'crack':     this._paintVoice.crackNow(this.params.get('paintLevel')); break
      case 'sweep':     this._paintVoice.primeSweep(1.4, this.params.get('paintLevel')); break
      default: break
    }
  }

  /**
   * A plain beep wired straight to the destination, bypassing the ENTIRE
   * soundscape graph — no buses, no filters, no mute, no master gain.
   *
   * "Is it me or is it the browser?" made pressable. If the tone is audible
   * and the landscape is not, the fault is in this module. If the tone is
   * silent too, the context is blocked, routed elsewhere, or the output device
   * is not the one being listened to.
   */
  testTone() {
    if (!this._ctx) return
    this._resumeIfNeeded()
    const ctx = this._ctx
    const now = ctx.currentTime + 0.02
    const osc = ctx.createOscillator()
    osc.type = 'sine'
    osc.frequency.value = 440
    const env = ctx.createGain()
    osc.connect(env)
    env.connect(ctx.destination)          // deliberately NOT through master
    const end = scheduleEnvelope(env.gain, now, 0.25, 0.01, 0.5)
    osc.start(now)
    osc.stop(end + 0.05)
    autoDispose(osc, [env])
  }

  /** 'running' | 'suspended' | 'interrupted' | 'closed' | null — panel readout. */
  getContextState() { return this._ctx ? this._ctx.state : null }

  /** RMS of everything leaving the master: the panel's output meter, and the
   *  speaker-leak reference interaction.js subtracts from the mic. */
  getOutputLevel() {
    if (!this._analyser) return 0
    this._analyser.getFloatTimeDomainData(this._meterBuf)
    let sum = 0
    for (let i = 0; i < this._meterBuf.length; i++) sum += this._meterBuf[i] * this._meterBuf[i]
    return Math.sqrt(sum / this._meterBuf.length)
  }

  /** The event log, newest FIRST, with each entry's age in seconds. */
  getEvents() {
    const now = this._ctx ? this._ctx.currentTime : 0
    return this._events.slice().reverse().map(e => ({ ...e, age: now - e.t }))
  }

  /**
   * Everything the running scene is asking of the soundscape, and what each
   * voice is doing about it — grouped the way the signal flows (scene → voice
   * drive → produced gain), because a stage-by-stage view is what shows a chain
   * of plausible stages multiplying to nothing.
   */
  getSignals() {
    if (!this._started) return null
    const s = this._scene
    const g = this._g.voiceGains
    return {
      scene: {
        terrainPace: s.terrainPace, wavePace: s.motion, overcast: s.overcast,
        haze: s.haze, forest: s.forest, ocean: s.ocean, mountains: s.mountains,
        snowline: s.snowline, restlessness: s.restlessness,
      },
      voices: {
        // `gain` is the level the VOICE produces; `bus` is its solo stage,
        // which reads 1 whenever the voice is not soloed out and so says
        // nothing about audibility — kept beside it to tell a muted voice from
        // a silent one. Birds have no standing level (every call is a
        // one-shot), so their `gain` is the solo stage, which carries birdLevel.
        wind:  { drive: this._wind.getGust(),  gain: this._wind.getLevel(),  bus: g.wind.gain.value },
        trees: { drive: this._trees.getLeaf(), gain: this._trees.getLevel(), bus: g.trees.gain.value },
        surf:  { drive: this._surf.getSwell(), gain: this._surf.getLevel(),  bus: g.surf.gain.value },
        birds: { drive: this._birds.getRate() * 60, gain: g.birds.gain.value,
                 bus: g.birds.gain.value, ...this._birds.getAwake() },
      },
      paint: { painting: this._painting, marks: this._paint.marks,
               dissolve: this._paint.dissolve, removed: this._paint.removed, blocking: this._paint.blocking },
      solo: this._solo,
      out: this.getOutputLevel(),
    }
  }

  /** Live readouts for the panel. */
  getTreeLevel()  { return this._started ? this._trees.getLevel() : 0 }
  getSwell()      { return this._started ? this._surf.getSwell() : 0 }
  getBirdRate()   { return this._started ? this._birds.getRate() : 0 }
  getPainting()   { return this._painting }

  // ─── lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Call on a user gesture. Idempotent, and safe to fail — every visual spec
   * dismisses the start overlay, so this runs headless on every run.
   *
   * `_started` is set only after the graph is fully built. Set up front, a
   * throw partway through would leave the object half-initialised for good: a
   * later start() returns early on the flag while setMuted() no-ops on the
   * missing graph, so the piece stays mute for the session.
   */
  start() {
    if (this._started) return

    // Older Safari only has the prefixed constructor.
    const Ctor = window.AudioContext || window.webkitAudioContext
    if (!Ctor) { console.warn('[audio] no AudioContext in this browser'); return }

    try {
      this._build(new Ctor())
      this._started = true
    } catch (e) {
      console.warn('[audio] start failed, leaving audio off:', e)
      try { this._ctx?.close() } catch { /* nothing to close */ }
      this._ctx = null
      this._g = null
      this._started = false
    }
  }

  /** True once start() has built the graph. */
  isStarted() { return this._started }

  /** The shared AudioContext, or null before start(). The mic path
   *  (interaction.enableMic, micProbe) reuses it rather than opening a second. */
  getAudioContext() { return this._ctx }

  setMuted(muted) {
    this._muted = muted
    if (!this._g) return
    // Unmuting is nearly always reached from a click, and a gesture is the
    // only context in which Safari reliably lets a context start, so take it.
    this._resumeIfNeeded()
    const now = this._ctx.currentTime
    const target = muted ? 0 : this.params.get('masterGain')
    this._g.master.gain.setTargetAtTime(target, now, 0.08)
    // setTargetAtTime approaches asymptotically and never arrives, so a mute
    // that only ramps leaves a permanent trickle. Land it exactly.
    this._g.master.gain.setValueAtTime(target, now + 0.5)
  }

  // ─── private ──────────────────────────────────────────────────────────────

  /** What a changed setting does beyond holding the value. */
  _wireParams() {
    const on = (key, fn) => this.params.onChange(key, fn)
    on('masterGain', () => { if (!this._muted) this.setMuted(false) })
    on('birdLevel', () => this._applySolo())
    on('leafLevel', v => this._trees?.setLeafLevel(v))
    on('leafFlutter', v => this._trees?.setLeafFlutter(v))
    on('leafTail', v => this._trees?.setLeafTail(v))
    on('leafTone', v => this._trees?.setLeafTone(v))
    on('reverbLevel', v => {
      if (this._g) this._g.reverbReturn.gain.setTargetAtTime(v, this._ctx.currentTime, CONTROL_TAU)
    })
  }

  _build(ctx) {
    this._ctx = ctx
    const rng = this._rng

    // Three independent beds. Independent, not one buffer at different
    // playback rates: detuned copies of the same waveform stay correlated and
    // comb against each other when summed.
    const buffers = createNoiseBuffers(ctx, 3, rng)
    const impulse = createImpulseResponse(ctx, rng, 1.4)

    this._g = createAudioGraph(ctx, impulse)

    this._wind = new WindVoice(ctx, this._g.voiceGains.wind, buffers[0], rng)
    this._trees = new TreeVoice(ctx, this._g.voiceGains.trees, buffers[0], rng)
    this._surf = new SurfVoice(ctx, this._g.voiceGains.surf, buffers[1], rng, this._g.voiceSends.surf)
    this._birds = new BirdVoice(ctx, this._g.voiceGains.birds, buffers[2], rng, this._g.voiceSends.birds)
    this._paintVoice = new PaintVoice(ctx, this._g.paintBus, buffers[0], rng)

    this._trees.setLeafLevel(this.params.get('leafLevel'))
    this._trees.setLeafFlutter(this.params.get('leafFlutter'))
    this._trees.setLeafTail(this.params.get('leafTail'))
    this._trees.setLeafTone(this.params.get('leafTone'))
    this._g.reverbReturn.gain.value = this.params.get('reverbLevel')
    this._applySolo()

    // Tap the one-shots for the event log. Wrapping here rather than calling a
    // logger from inside each voice keeps the voices unaware of the panel, and
    // catches the debug triggers and the scene's own firings on the same path:
    // a button that works while the scene never fires looks identical to a
    // working system until both are visible.
    const tap = (obj, name, label, detail) => {
      if (!obj || typeof obj[name] !== 'function') return
      const orig = obj[name].bind(obj)
      obj[name] = (...args) => { this._logEvent(label, detail ? detail(...args) : ''); return orig(...args) }
    }
    tap(this._surf, 'breakNow', 'wave break', p => `peak ${(+p || 0).toFixed(2)}`)
    tap(this._birds, 'call', 'bird call', d => d == null ? 'scene' : `dist ${(+d).toFixed(2)}`)
    tap(this._trees, 'gustNow', 'gust in trees', () => 'manual')
    tap(this._paintVoice, 'crackNow', 'paint crack', () => 'manual')
    tap(this._paintVoice, 'strokeNow', 'brush stroke', () => 'manual')
    tap(this._paintVoice, 'primeSweep', 'canvas sweep', d => `${(+d || 0).toFixed(1)}s`)

    // An output meter on the master. Silence has two different causes — the
    // graph producing nothing, or its signal never reaching the speakers — and
    // without a meter they are indistinguishable from the outside.
    this._analyser = ctx.createAnalyser()
    this._analyser.fftSize = 1024
    this._meterBuf = new Float32Array(this._analyser.fftSize)
    this._g.master.connect(this._analyser)
  }

  /**
   * Resume the context from ANY non-running state.
   *
   * Not just 'suspended': Safari has a third state, 'interrupted', entered
   * when something else takes the device's audio focus (a call, another app,
   * the tab going to the background on iOS). A resume guarded on 'suspended'
   * alone never fires there, and the piece stays mute for the rest of the
   * session while every meter upstream of the destination still reads healthy.
   */
  _resumeIfNeeded() {
    if (!this._ctx || this._ctx.state === 'running' || this._resuming) return
    this._resuming = true
    this._ctx.resume()
      .catch(e => console.warn('[audio] resume refused:', e))
      .finally(() => { this._resuming = false })
  }

  /** Record one discrete event. Keeps the last 14, stamped with the audio
   *  clock, so a trigger and the scene's own firings are told apart at a glance. */
  _logEvent(kind, detail) {
    this._events.push({ kind, detail, t: this._ctx ? this._ctx.currentTime : 0 })
    if (this._events.length > 14) this._events.shift()
  }

  _applySolo() {
    if (!this._g) return
    const now = this._ctx.currentTime
    const want = name => this._solo == null || this._solo === name
    const levels = { wind: 1, trees: 1, surf: 1, birds: this.params.get('birdLevel') }
    for (const [name, node] of Object.entries(this._g.voiceGains)) {
      const level = want(name) ? levels[name] : 0
      node.gain.setTargetAtTime(level, now, 0.05)
      this._g.voiceSends[name].gain.setTargetAtTime(level, now, 0.05)
    }
    this._g.paintBus.gain.setTargetAtTime(want('paint') ? 1 : 0, now, 0.05)
  }

  /**
   * Push the world away, or bring it back.
   *
   * Level, spectrum and reverb move together because that is what distance
   * does; moving one alone reads as a filter sweep. The dry/wet pair is an
   * equal-power crossfade, so the total does not dip 3 dB through the middle
   * of every transition.
   */
  _applyDistance(painting, hazePull) {
    const now = this._ctx.currentTime
    const d = clamp01(clamp01(painting) * this.params.get('distanceDepth') + hazePull)

    this._g.worldLP.frequency.setTargetAtTime(
      logLerp(18000, Math.max(this.params.get('distanceCutoff'), 120), d), now, 0.12)

    const { a, b } = equalPower(d)
    this._g.worldDry.gain.setTargetAtTime(a, now, 0.12)
    this._g.worldSend.gain.setTargetAtTime(0.03 + b * 0.5, now, 0.12)

    // "The room": the world does not merely recede, it drains, leaving the
    // acoustics of the space the picture hangs in. A switch rather than the
    // default because near-silence in a gallery reads as a fault.
    const floor = this.params.get('roomMode') ? lerp(1, 0.05, clamp01(painting)) : 1
    this._g.worldBus.gain.setTargetAtTime(floor, now, 0.15)
  }
}
