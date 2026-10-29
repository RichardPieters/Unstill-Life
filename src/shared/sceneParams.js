/**
 * sceneParams.js — the scene-wide values as param rows (shared/paramSchema.js),
 * owner 'scene': the fog, the light level and the cloud shadows every consumer
 * of sceneUniforms.js shares. `sceneUniforms.params` holds them; the panel, the
 * weather and the cloud-density dial all write through it.
 *
 * Two rows have no uniform of their own and are held by the accessor: the
 * cloud-shadow master (`cloudShadowAmt`, the slider's value) and the density
 * dial's scale (`cloudShadowScale`). The shader reads their product
 * (uCloudShadowAmt, derived in sceneUniforms.js), kept apart so the slider keeps
 * saying what the user set while the dial scales it.
 */
import { FOG_NEAR_START, FOG_FAR_START } from './sceneConfig.js'
import { PALETTE, hexString } from './palette.js'

const slider = r => ({ owner: 'scene', kind: 'slider', encode: 'float', ...r })
const hidden = r => ({ owner: 'scene', kind: 'hidden', encode: 'float', ...r })

export const SCENE_PARAMS = [
  // The sky horizon's colour; the weather blends it with the sky.
  { id: 'scene.fogColor', owner: 'scene', key: 'fogColor', kind: 'hidden', encode: 'srgb',
    uniform: 'uFogColor', value: hexString(PALETTE.sky.horizon), label: 'fog colour' },
  // Where the aerial ramp starts and ends; the weather moves the start.
  hidden({ id: 'scene.fogNear', key: 'fogNear', uniform: 'uFogNear', value: FOG_NEAR_START, drivenBy: 'weather', label: 'fog start' }),
  hidden({ id: 'scene.fogFar', key: 'fogFar', uniform: 'uFogFar', value: FOG_FAR_START, label: 'fog end' }),
  // Shape of the near -> far ramp: >1 stays clear for longer, then fades
  // quickly near the far end; <1 fades early and eases into the remainder
  // (1 = a plain linear clamp).
  slider({ id: 'ctrl-fog-curve', key: 'fogCurve', uniform: 'uFogCurve', label: 'fog curve',
    value: 0.6, min: 0.1, max: 4, step: 0.05, digits: 1, drivenBy: 'weather' }),
  // Caps how fully fog takes over at the far end and beyond: 1 is a full melt
  // into the sky, lower keeps a sliver of the world visible at the horizon.
  // The defaults ease in early and never fully white out.
  slider({ id: 'ctrl-fog-max', key: 'fogMaxAlpha', uniform: 'uFogMaxAlpha', label: 'fog max',
    value: 0.9, min: 0, max: 1, step: 0.05, digits: 2, drivenBy: 'weather' }),
  // How much light falls on the ground, as a plain multiplier on the shaded
  // surface colour. 1 = the sunlit day everything else is tuned for; the
  // weather drives it down under overcast. Applied after shading and before
  // aerial perspective, so it darkens the land without touching the sky.
  slider({ id: 'ctrl-light-level', key: 'lightLevel', uniform: 'uLightLevel', label: 'light level',
    value: 1.11, min: 0, max: 1.5, step: 0.01, digits: 2, drivenBy: 'weather' }),
  // The master of the shadow strength (held; see the header).
  slider({ id: 'ctrl-cloudshadow-amt', key: 'cloudShadowAmt', label: 'shadow strength',
    value: 0.6, min: 0, max: 1, step: 0.01, digits: 2 }),
  // The cloud-density dial's scale on the master. Captured, so a restore with
  // the walker off keeps the snapshot's shadows instead of the live scale.
  hidden({ id: 'scene.cloudShadowScale', key: 'cloudShadowScale', value: 1,
    drivenBy: 'form', label: 'shadow strength scale' }),
  // The shadows' OWN absorption, not the cloud's: the cloud's sets on-screen
  // opacity too, so sharing it would couple "how dark are the shadows" to "how
  // solid are the clouds". The density dial writes it.
  slider({ id: 'ctrl-cloudshadow-abs', key: 'cloudShadowAbs', uniform: 'uCloudShadowAbs', label: 'shadow depth',
    value: 0.6, min: 0, max: 2, step: 0.01, digits: 2, drivenBy: 'form' }),
  slider({ id: 'ctrl-cloudshadow-floor', key: 'cloudShadowFloor', uniform: 'uCloudShadowFloor', label: 'darkest shadow',
    value: 0.4, min: 0, max: 1, step: 0.01, digits: 2 }),
  slider({ id: 'ctrl-cloudshadow-tiers', key: 'cloudShadowTiers', uniform: 'uCloudShadowTiers', label: 'shadow tiers',
    value: 4, min: 1, max: 8, step: 1, digits: 0 }),
]
