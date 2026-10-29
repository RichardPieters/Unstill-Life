/**
 * audioParams.js — the soundscape's param rows (shared/paramSchema.js): every
 * Sound-tab slider and toggle, held by `audio.params`. No uniforms: the values
 * live in the accessor, and audio.js reacts to a change (a built voice takes
 * the new value, the master re-ramps) through `params.onChange`.
 *
 * Nothing here has an analytically correct value: it is a synthesis of wind,
 * water and birds tuned by ear, so every constant is a row the panel exposes.
 * The solo choice is a mode (audio.setSolo), not a row: its values are names.
 */

const row = r => ({ owner: 'audio', kind: 'slider', encode: 'float', ...r })
const toggle = r => row({ kind: 'toggle', encode: 'bool', ...r })

export const AUDIO_PARAMS = [
  row({ id: 'ctrl-master-gain', key: 'masterGain', label: 'master volume',
    value: 0.52, min: 0, max: 1, step: 0.01, digits: 2 }),
  row({ id: 'ctrl-wind-level', key: 'windLevel', label: 'wind level',
    value: 0.7, min: 0, max: 2, step: 0.05, digits: 2 }),
  row({ id: 'ctrl-tree-level', key: 'treeLevel', label: 'tree level',
    value: 0.1, min: 0, max: 2, step: 0.05, digits: 2 }),
  row({ id: 'ctrl-surf-level', key: 'surfLevel', label: 'water level',
    value: 1.3, min: 0, max: 2, step: 0.05, digits: 2 }),
  // How loud a BREAK is relative to the water's body — independent of
  // surfLevel, which scales body, foam and breaks together. Measured, this
  // voice's crest factor was ~14.6–15.1 dB against ~16–19 dB on three real
  // surf recordings; this knob closes that gap without making everything louder.
  row({ id: 'ctrl-surf-break-level', key: 'breakLevel', label: 'break level (relative to water)',
    value: 0.2, min: 0, max: 2, step: 0.05, digits: 2 }),
  row({ id: 'ctrl-bird-level', key: 'birdLevel', label: 'bird level',
    value: 0.1, min: 0, max: 2, step: 0.05, digits: 2 }),
  row({ id: 'ctrl-paint-level', key: 'paintLevel', label: 'paint level',
    value: 1.5, min: 0, max: 2, step: 0.05, digits: 2 }),
  row({ id: 'ctrl-bird-rate', key: 'birdRateScale', label: 'how often birds call',
    value: 0.4, min: 0, max: 3, step: 0.05, digits: 2 }),
  row({ id: 'ctrl-leaf-level', key: 'leafLevel', label: 'leaves in the wind',
    value: 0.7, min: 0, max: 2, step: 0.05, digits: 2 }),
  // Hz at full gust.
  row({ id: 'ctrl-leaf-flutter', key: 'leafFlutter', label: 'how fast they flutter (Hz)',
    value: 13, min: 4, max: 80, step: 1, digits: 0 }),
  // Seconds of whisper after a gust drops.
  row({ id: 'ctrl-leaf-tail', key: 'leafTail', label: 'whisper after a gust (s)',
    value: 1.95, min: 0.1, max: 4, step: 0.05, digits: 2 }),
  // 0 dry and thin, 1 full and bodied.
  row({ id: 'ctrl-leaf-tone', key: 'leafTone', label: 'dry leaves ... full forest',
    value: 0.76, min: 0, max: 1, step: 0.02, digits: 2 }),
  row({ id: 'ctrl-reverb-level', key: 'reverbLevel', label: 'reverb',
    value: 0.8, min: 0, max: 2, step: 0.05, digits: 2 }),
  // How far the world is pushed away when a painting is up: 0 leaves it where
  // it is, 1 takes it to the far end of the distance curve.
  row({ id: 'ctrl-distance-depth', key: 'distanceDepth', label: 'how far the world steps back',
    value: 0.6, min: 0, max: 1, step: 0.05, digits: 2 }),
  // The cutoff the world reaches at full distance. The sweep from 18 kHz is
  // logarithmic, so this value is genuinely the far end rather than a number
  // that only matters in the last few percent.
  row({ id: 'ctrl-distance-cutoff', key: 'distanceCutoff', label: 'muffling at full distance',
    value: 760, min: 200, max: 6000, step: 20, digits: 0 }),
  // "The room": drains the world almost entirely while a painting is up.
  toggle({ id: 'tog-room-mode', key: 'roomMode', label: 'the room (drain the landscape away entirely)',
    value: false }),
  toggle({ id: 'tog-paint-sound', key: 'paintEnabled', label: 'paint sounds (sweep, grains, cracks)',
    value: true }),
]
