
// ─── Sound: the soundscape's controls, plus the audition surface ─────────
// Nothing in audio.js has an analytically correct value — it is a synthesis
// of wind, water and birds tuned by ear — so every constant is a live
// param row here. The solo radios and
// the trigger buttons exist so each element can be heard ALONE: a layered
// generative soundscape is otherwise impossible to debug, because any one
// sound is only ever audible underneath the other five.
//
export function initSound(ctx) {
  const { debugEl, audio, dynamics } = ctx
  let soundOn = false
  const soundToggle = document.getElementById('tog-sound')
  const ensureStarted = () => {
    if (!audio.isStarted()) {
      try { audio.start() } catch (e) { console.warn('AudioContext failed:', e) }
    }
  }
  soundToggle.addEventListener('change', () => {
    soundOn = soundToggle.checked
    ensureStarted()
    audio.setMuted(!soundOn)
  })

  // Solo. The empty value is the full mix, so the group has a real "off".
  for (const radio of document.querySelectorAll('input[name="snd-solo"]')) {
    radio.addEventListener('change', () => {
      if (radio.checked) audio.setSolo(radio.value || null)
    })
  }

  // Audition buttons. Each starts the context if it is not running and
  // unmutes on the spot — pressing "Bird" and hearing nothing because sound
  // was still off is exactly the debugging dead end this is meant to remove.
  const triggers = [
    ['snd-play-bird',    'bird'],
    ['snd-play-birdfar', 'birdFar'],
    ['snd-play-break',   'break'],
    ['snd-play-gust',    'gust'],
    ['snd-play-sweep',   'sweep'],
    ['snd-play-stroke',  'stroke'],
    ['snd-play-crack',   'crack'],
  ]
  const testTone = document.getElementById('snd-test-tone')
  if (testTone) {
    testTone.addEventListener('click', () => {
      ensureStarted()
      audio.testTone()
    })
  }

  for (const [id, what] of triggers) {
    const el = document.getElementById(id)
    if (!el) continue
    el.addEventListener('click', () => {
      ensureStarted()
      if (!soundOn) {
        soundOn = true
        soundToggle.checked = true
        audio.setMuted(false)
      }
      audio.trigger(what)
    })
  }

  // Live readouts, only while the panel is actually visible.
  dynamics.addEventListener('tick', () => {
    if (!debugEl.classList.contains('visible')) return
    const set = (id, text) => {
      const el = document.getElementById(id)
      if (el) el.textContent = text
    }
    // Engine state and output level first: when nothing is audible these
    // two say whether the graph is producing signal at all, which is the
    // difference between a bug in here and the browser refusing to play.
    set('snd-val-ctx', audio.getContextState() ?? 'not started')
    set('snd-val-level', audio.getOutputLevel().toFixed(4))
    set('snd-val-swell', audio.getSwell().toFixed(2))
    set('snd-val-birdrate', (audio.getBirdRate() * 60).toFixed(1))
    // The canopy's live gain, not its slider.
    set('snd-val-trees', audio.getTreeLevel().toFixed(4))
    set('snd-val-painting', audio.getPainting().toFixed(2))

    // ── Signal flow ──────────────────────────────────────────────────────
    // A bar per value: the question is whether anything moves and whether a
    // voice's output follows what the scene asks, which a column of aligned
    // bars shows at a glance.
    const sig = audio.getSignals()
    if (sig) {
      const bar = (v, max = 1) => {
        const n = Math.max(0, Math.min(10, Math.round((v / max) * 10)))
        return '█'.repeat(n) + '·'.repeat(10 - n)
      }
      const row = (label, v, max = 1, extra = '') =>
        `${label.padEnd(13)}${bar(v, max)} ${v.toFixed(3).padStart(7)}${extra}`
      const lines = ['— the scene asks —']
      for (const [k, v] of Object.entries(sig.scene)) lines.push(row(k, v))
      lines.push('— voice: drive → gain —')
      for (const [k, v] of Object.entries(sig.voices)) {
        const cast = v.of ? `  ${v.awake}/${v.of} singing` : ''
        const unit = k === 'birds' ? '/min' : ''
        const muted = v.bus < 0.01 ? ' MUTED' : ''
        lines.push(`${k.padEnd(13)}${bar(v.drive, k === 'birds' ? 60 : 1)} ` +
          `${v.drive.toFixed(2).padStart(6)}${unit} → gain ${v.gain.toFixed(4)}${muted}${cast}`)
      }
      lines.push('— paint —')
      lines.push(row('painting', sig.paint.painting))
      lines.push(row('marks', sig.paint.marks, 1, sig.paint.blocking ? '  blocking in' : ''))
      lines.push(row('dissolve', sig.paint.dissolve))
      lines.push(`solo         ${sig.solo ?? 'full mix'}    out ${sig.out.toFixed(4)}`)
      set('snd-flow', lines.join('\n'))
    }

    const ev = audio.getEvents()
    set('snd-events', ev.length
      ? ev.map(e => `${e.age.toFixed(1).padStart(6)}s ago  ${e.kind.padEnd(14)}${e.detail}`).join('\n')
      : 'no events yet — press a trigger, or wait for the scene to fire one')
  })
}
