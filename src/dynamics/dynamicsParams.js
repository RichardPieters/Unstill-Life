/**
 * dynamicsParams.js — the param rows of dynamics.js (how attention becomes
 * motion and when the scene settles) and animSpeed.js (how fast water and
 * clouds move). No uniforms: each value is a field of its owner, whose setter
 * refuses a value the arithmetic cannot use (NaN, a non-positive settle
 * interval) rather than clamping it into range. The slider ranges are what
 * the panel offers; code may write outside them.
 */

const slider = r => ({ kind: 'slider', encode: 'float', ...r })

export const DYNAMICS_PARAMS = [
  // Seconds for momentum to close ~63% of the gap to its target (95% at 3×).
  // 0 snaps.
  slider({ id: 'ctrl-momentum-inertia', owner: 'dynamics', key: 'momentumTau', label: 'attention inertia',
    value: 8, min: 0, max: 60, step: 0.5, digits: 1 }),
  // Restlessness changes at 1 / settleInterval per second (× (1 − momentum)
  // while decaying), so at max attention (momentum 0) a full decay takes
  // exactly settleInterval seconds.
  slider({ id: 'ctrl-settle-interval', owner: 'dynamics', key: 'settleIntervalAtMaxAttention',
    label: 'decay pace @ max attention', value: 15, min: 3, max: 300, step: 1, digits: 1 }),
  // Above it the scene settles, below it a frozen scene resumes.
  slider({ id: 'ctrl-unfreeze-attention', owner: 'dynamics', key: 'unfreezeAttention',
    label: 'resume below attention', value: 0.9, min: 0, max: 1, step: 0.01, digits: 2 }),
]

export const ANIM_SPEED_PARAMS = [
  // Water and cloud pace at full restlessness.
  slider({ id: 'ctrl-anim-speed', owner: 'animSpeed', key: 'targetSpeed', label: 'wave/cloud speed',
    value: 0.6, min: 0, max: 3, step: 0.05, digits: 2 }),
  // How much faster waves and clouds run at full overcast (1 = twice the
  // clear-sky pace, 0 = no coupling). The sky carries the weather; the sea
  // only leans into it.
  slider({ id: 'ctrl-wave-weather-gain', owner: 'animSpeed', key: 'waveWeatherGain',
    label: 'grey sky hurries waves', value: 0.25, min: 0, max: 3, step: 0.05, digits: 2 }),
  slider({ id: 'ctrl-cloud-weather-gain', owner: 'animSpeed', key: 'cloudWeatherGain',
    label: 'grey sky hurries clouds', value: 0.65, min: 0, max: 3, step: 0.05, digits: 2 }),
]
