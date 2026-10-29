/**
 * godrayParams.js — the light shafts' param rows (shared/paramSchema.js): every
 * value godrays.js can be set to, read back through `godrays.params`.
 * godrays.js seeds its uniforms from them and builds its accessor from them; the
 * panel binds the controls through panel/panelRows.js.
 *
 * DEFAULTS  `value` is the one default of each value.
 *
 * TWO PASSES  the march rows (`invalidates: 'march'`) change what the march
 *   target holds, so a change forces a march even while the world holds still.
 *   The composite rows are read by the per-frame composite pass and mark
 *   nothing — except `intensityScale`, which is a composite uniform that has
 *   always forced a march too.
 *
 * BACKING  a row that names a `uniform` writes it. A row without one is a field
 *   of godrays.js: the user's switch, the gate's onset (recomputes the gate) and
 *   the march-target scale (reallocates the target).
 */

// Hard cap in the shader's loop — the JS side must not promise more.
const MAX_STEPS = 96

import { PALETTE, hexString } from '../shared/palette.js'

const row = r => ({ owner: 'godrays', kind: 'slider', encode: 'float', ...r })
const hidden = r => row({ kind: 'hidden', id: `godrays.${r.key}`, ...r })
const march = r => row({ invalidates: 'march', ...r })
const hiddenMarch = r => march({ kind: 'hidden', id: `godrays.${r.key}`, ...r })

export const GODRAY_PARAMS = [
  // The user's switch, kept apart from the pass's own `enabled`, which the
  // weather gate owns: both have to be on for anything to run.
  row({ id: 'tog-godrays', label: 'light shafts', key: 'enabled', kind: 'toggle', encode: 'bool', value: true }),

  // ── March ─────────────────────────────────────────────────────────────────
  march({ id: 'ctrl-ray-steps', key: 'steps', uniform: 'uRaySteps', encode: 'int', clamp: [1, MAX_STEPS],
    label: 'samples', value: 16, min: 8, max: MAX_STEPS, step: 4, digits: 0 }),
  // The aerial ramp has already saturated by here.
  march({ id: 'ctrl-ray-maxdist', key: 'maxDist', uniform: 'uRayMaxDist',
    label: 'reach', value: 650, min: 100, max: 2000, step: 25, digits: 0 }),
  // Its own, like the ground shadow's — NOT the cloud's.
  march({ id: 'ctrl-ray-absorption', key: 'absorption', uniform: 'uRayAbsorption',
    label: 'shaft depth', value: 0.59, min: 0, max: 2, step: 0.01, digits: 2 }),
  // Extinction per world unit, and LOW on purpose. Too high concentrates all the
  // scattering into the first hundred units, where the sub-cloud air column has
  // no room — the camera sits 8 units under the deck — and the beams never get
  // far enough from the viewer to be seen as beams. At 0.0013 a ray is still
  // carrying most of its transmittance at 700 units, which is where the shafts
  // actually cross the frame.
  march({ id: 'ctrl-ray-density', key: 'density', uniform: 'uRayDensity',
    label: 'air density', value: 0.0013, min: 0, max: 0.01, step: 0.0001, digits: 5 }),
  march({ id: 'ctrl-ray-aniso', key: 'aniso', uniform: 'uRayAniso',
    label: 'sun bias', value: 0.44, min: 0, max: 0.95, step: 0.01, digits: 2 }),
  // 0..1, breaks the march's banding into noise. No panel control.
  hiddenMarch({ key: 'jitter', uniform: 'uJitter', value: 1 }),
  // The baked field is low-frequency; without a cut it blobs.
  march({ id: 'ctrl-ray-hardness', key: 'hardness', uniform: 'uRayHardness',
    label: 'beam hardness', value: 0.44, min: 0, max: 1, step: 0.01, digits: 2 }),
  // Snapped onto the ground shadow's ladder before use (see cutLevel in the
  // frag). At the shipped uCloudShadowTiers of 4 the ladder's steps sit at 1/3
  // and 2/3, and 0.69 snaps to 2/3 — the ground's FIRST step down out of full
  // sun, so a beam's edge and the shadow edge beneath it are one boundary
  // rather than two that nearly agree.
  march({ id: 'ctrl-ray-threshold', key: 'threshold', uniform: 'uRayThreshold',
    label: 'beam threshold', value: 0.5, min: 0.2, max: 1, step: 0.01, digits: 2 }),
  march({ id: 'ctrl-ray-cutsnap', key: 'cutSnap', uniform: 'uRayCutSnap',
    label: 'match ground shade', value: 1, min: 0, max: 1, step: 0.01, digits: 2 }),
  // World units of deck a shaft dissolves over.
  march({ id: 'ctrl-ray-deckfade', key: 'deckFade', uniform: 'uRayDeckFade',
    label: 'cloud blend', value: 14, min: 0, max: 70, step: 1, digits: 0 }),
  // Per world unit of descent; shafts fade toward the ground.
  march({ id: 'ctrl-ray-drop', key: 'drop', uniform: 'uRayDrop',
    label: 'beam falloff', value: 0.003, min: 0, max: 0.03, step: 0.0005, digits: 4 }),
  // World units at the lens that carry no shaft — see the frag.
  march({ id: 'ctrl-ray-nearfade', key: 'nearFade', uniform: 'uRayNearFade',
    label: 'near cutoff', value: 400, min: 0, max: 500, step: 5, digits: 0 }),

  // ── Composite ─────────────────────────────────────────────────────────────
  // Measured: the march's top 3% sits near L = 0.03, and the composite
  // posterizes into `tiers` steps, so at 0.95 even the brightest beams fell
  // under the first step (1/9) and rounded to nothing. 4 lifts them over it by
  // eye without washing the sky.
  row({ id: 'ctrl-ray-intensity', key: 'intensity', uniform: 'uRayIntensity',
    label: 'brightness', value: 2, min: 0, max: 8, step: 0.05, digits: 2 }),
  // The sky's long paths and the land's short ones have to share one ladder; too
  // few and the land falls under the first step and shows nothing at all.
  row({ id: 'ctrl-ray-tiers', key: 'tiers', uniform: 'uRayTiers', encode: 'int',
    label: 'beam tiers', value: 9, min: 1, max: 12, step: 1, digits: 0 }),
  row({ id: 'ctrl-ray-soften', key: 'soften', uniform: 'uRaySoften',
    label: 'softness', value: 1.9, min: 0, max: 4, step: 0.1, digits: 1 }),
  row({ id: 'ctrl-ray-color', key: 'rayColor', uniform: 'uRayColor', kind: 'colour', encode: 'srgb',
    label: 'shaft colour', value: hexString(PALETTE.light.shaft) }),
  // 1 = untouched. Driven by the cloud-density dial (cloudDialsMath.js) and
  // multiplied alongside `intensity`, never in place of it, so the intensity
  // slider stays the authority on the base look. A composite uniform, but a
  // change forces a march (it always has).
  hiddenMarch({ key: 'intensityScale', uniform: 'uRayIntensityScale', value: 1, drivenBy: 'form',
    clamp: [0, Infinity] }),

  // ── Weather gate and target ───────────────────────────────────────────────
  // Shafts belong to a heavy, broken deck: below this overcast there are none at
  // all and the whole pass is skipped, and from there to full overcast they come
  // up to strength. Not a general brightness knob — it is what ties the effect
  // to the weather rather than to the clock. A field: a change recomputes the gate.
  row({ id: 'ctrl-ray-gateonset', key: 'gateOnset', clamp: true,
    label: 'shafts start at', value: 0.9, min: 0, max: 0.99, step: 0.01, digits: 2 }),
  // The march target's size as a fraction of the canvas (a field: a change
  // reallocates it). 0.5 stair-stepped the hard beam edges visibly.
  hidden({ key: 'renderScale', value: 0.65, min: 0.1, max: 1, clamp: true }),
]

/**
 * Every godrays uniform no row backs, with its snapshot class
 * (shared/uniformSerialize.js). The cloud-shadow frame and tier count are the
 * scene set's.
 */
export const UNIFORM_CLASSES = {
  // From the overcast and the gate onset (_applyGate), which the restore runs.
  uRayWeather:        'derived',
  // Per frame: the depth texture, the camera, the sea level main.js pushes,
  // the march target and its texel size.
  uDepthTexture:      'frame',
  uInverseProjection: 'frame',
  uInverseView:       'frame',
  uCameraPos:         'frame',
  uCameraNear:        'frame',
  uCameraFar:         'frame',
  uSeaLevel:          'frame',
  tDiffuse:           'frame',
  uRayTex:            'frame',
  uRayTexel:          'frame',
}
