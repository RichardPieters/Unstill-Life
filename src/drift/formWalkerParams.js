/**
 * formWalkerParams.js — the form walker's settings as param rows
 * (shared/paramSchema.js), held by `formWalker.params`. The walk itself (its
 * hidden coordinates and targets) is not a param: formWalker.js snapshots it.
 * Each value is a field of the walker, whose setter refuses a non-finite
 * number rather than clamping it.
 */

export const FORM_WALKER_PARAMS = [
  // The drift tri-state box (tog-scene-drift) drives this together with the
  // weather's walking flag, so the row has no control of its own.
  { id: 'formWalker.enabled', owner: 'formWalker', key: 'enabled', kind: 'hidden', encode: 'bool',
    value: true, label: 'form drift on' },
  // How far a target may sit from the current latent.
  { id: 'ctrl-walk-spread', owner: 'formWalker', key: 'calmSpread', kind: 'slider', encode: 'float',
    value: 0.25, min: 0, max: 1, step: 0.01, digits: 2, label: 'drift range' },
  // Latent units per second per unit of noiseSpeed. At noiseSpeed 1.25
  // (momentum 0.5) a full 0.25 hop takes 10 s.
  { id: 'ctrl-walk-rate', owner: 'formWalker', key: 'followRate', kind: 'slider', encode: 'float',
    value: 0.02, min: 0, max: 0.2, step: 0.001, digits: 3, label: 'drift speed' },
]
