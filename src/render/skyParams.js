/**
 * skyParams.js — the sky's param rows (shared/paramSchema.js), held by
 * `sky.params`. No uniforms: the gradient is painted into a canvas, so sky.js
 * redraws it from `params.onChange`.
 *
 * Both ends are weather-driven (the horizon through main.js's applyHorizon,
 * the zenith through weatherDriver.js), so they are `persist: false`: the
 * weather's clear state is the one authority for them in a snapshot. They are
 * 0xrrggbb integers (encode 'int'), the form every colour driver writes, and
 * start at the palette's `sky.horizon` and `sky.zenith`.
 */
import { PALETTE } from '../shared/palette.js'

// Floor of the `reach` clamp: the blend never collapses to nothing.
export const REACH_MIN = 0.05

export const SKY_PARAMS = [
  { id: 'sky.horizonHex', owner: 'sky', key: 'horizonHex', kind: 'hidden', encode: 'int',
    value: PALETTE.sky.horizon, persist: false, label: 'horizon colour' },
  { id: 'sky.zenithHex', owner: 'sky', key: 'zenithHex', kind: 'hidden', encode: 'int',
    value: PALETTE.sky.zenith, drivenBy: 'weather', persist: false, label: 'zenith colour' },
  { id: 'ctrl-sky-reach', owner: 'sky', key: 'reach', kind: 'slider', encode: 'float',
    value: 0.3, min: 0.1, max: 1, step: 0.01, digits: 2, clamp: [REACH_MIN, 1], label: 'gradient reach' },
]
