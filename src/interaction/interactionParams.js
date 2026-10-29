/**
 * interactionParams.js — the param rows (shared/paramSchema.js) of
 * interaction.js, held by `interaction.params`.
 *
 * None is scene state: the room is not part of a painting, so every row is
 * `persist: false` (interaction has no snapshot). The sliders clamp to their
 * own range, which keeps every divisor and exponent the arithmetic uses
 * positive and finite.
 *
 * Enabling the mic is async (a permission prompt), so it stays an owner
 * method; only the tunables are rows.
 */
import { rmsToDbfs } from './interactionMath.js'

/** Mic RMS in an empty room with the sim silent (the intercept of the measured
 *  leak fit). The floor row's default is this in dBFS. */
export const QUIET_RMS_DEFAULT = 0.0047
/** Seconds of the sim's output level kept for the leak delay; caps it. */
export const LEAK_HISTORY_S = 1

const mic = r => ({ owner: 'interaction', kind: 'slider', encode: 'float', persist: false, clamp: true, ...r })

export const MIC_PARAMS = [
  // The room's quiet level (the leak-free part of the expected mic level). Its
  // state is the RMS, which calibrateFloor() measures; the default sits off the
  // slider's 1 dB grid.
  mic({ id: 'ctrl-mic-floor', key: 'floorDb', label: 'floor (dBFS)',
    value: rmsToDbfs(QUIET_RMS_DEFAULT), min: -80, max: -20, step: 1, digits: 0 }),
  // dB above the expected level that reads as fully restless. Divides.
  mic({ id: 'ctrl-mic-span', key: 'spanDb', label: 'span (dB)',
    value: 25, min: 5, max: 40, step: 1, digits: 0 }),
  // Restlessness smoothing time constant, seconds (0 = snap).
  mic({ id: 'ctrl-mic-tau', key: 'tau', label: 'tau (s)',
    value: 2, min: 0, max: 20, step: 0.5, digits: 1 }),
  // Exponent of restlessness → attention; > 1 keeps attention high across everyday noise.
  mic({ id: 'ctrl-mic-curve', key: 'curve', label: 'curve',
    value: 1.6, min: 0.3, max: 3, step: 0.1, digits: 1 }),
  // Artistic, no correct value.
  mic({ id: 'ctrl-mic-fluxgain', key: 'fluxGain', label: 'flux sensitivity',
    value: 200, min: 1, max: 500, step: 1, digits: 0 }),
  // Mic RMS per unit of the sim's output RMS; measured on the dev machine's
  // speakers and mic, so room- and hardware-specific.
  mic({ id: 'ctrl-mic-leakgain', key: 'leakGain', label: 'speaker leak gain',
    value: 1.8, min: 0, max: 4, step: 0.05, digits: 2 }),
  // Output → speaker → air → mic. The probe could only bound it to one render
  // frame, so the default is a physical estimate (output latency ~21 ms plus
  // input latency), not a measured value. Stored in seconds, shown in ms.
  mic({ id: 'ctrl-mic-leakdelay', key: 'leakDelayS', label: 'speaker delay (ms)',
    value: 0.05, min: 0, max: 0.3, step: 0.005, digits: 0, displayScale: 1000 }),
]
