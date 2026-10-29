/**
 * simState.js — the `sim` owner: the two values that drive the simulation
 * from the control bar and live nowhere else, as param rows
 * (shared/paramSchema.js) held by `sim.params`.
 *
 *   manualAttention  the attention a viewer is simulated to give; what
 *                    dynamics.update() is fed in Manual mode (the mic replaces
 *                    it in Mic mode)
 *   paused           the loop skips simulation work while true
 *
 * None is scene state: a snapshot restore leaves the viewer's attention
 * alone, so every row is `persist: false`. Pause is restored by the
 * snapshot path explicitly (debugPanel's setPaused), as an action.
 */
import { paramAccess } from '../shared/paramAccess.js'

export const SIM_PARAMS = [
  { id: 'attention', owner: 'sim', key: 'manualAttention', kind: 'slider', encode: 'float',
    value: 1, min: 0, max: 1, step: 0.01, digits: 2, persist: false, label: 'Attention' },
  // The Pause button is an action; this is the state it flips.
  { id: 'sim.paused', owner: 'sim', key: 'paused', kind: 'hidden', encode: 'bool',
    value: false, persist: false, label: 'paused' },
]

/** A fresh sim owner: `{ params }`. */
export function createSimState() {
  return { params: paramAccess({ tables: [], rows: SIM_PARAMS }) }
}
