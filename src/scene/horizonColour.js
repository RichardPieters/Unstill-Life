/**
 * horizonColour.js — the scene's horizon colour as one param row (`horizon.params`,
 * key `hex`, a 0xrrggbb integer), whose setter fans the colour out to everything
 * that tints with it:
 *
 *   sky            the gradient's horizon end
 *   three's fog    scene.fog.color
 *   fog colour     the scene set's uFogColor (terrain, water, the art pass)
 *   cloud copy     clouds' `weatherSky`, which blends each cloud toward the
 *                  sky. The cloud's own authored sky colour is left alone: a
 *                  palette write there would restyle the painting at startup,
 *                  so the weather drives that copy from its captured clear end.
 *
 * The palette writes it once at boot, the weather every walk step and the
 * panel's sky swatch on a pick (main.js's applyHorizon). Held by the wiring
 * layer because it reaches four owners. `forget()` clears the remembered colour:
 * a snapshot restore changes some of the four by other routes (the scene set's
 * fog colour, the weather's sky push), so the next write must fan out even when
 * it equals the colour last applied. The row is not a snapshot value: the
 * snapshot records the sky's own horizon (sceneSnapshot.js's `scene.horizonHex`).
 */
import { paramAccess } from '../shared/paramAccess.js'
import { PALETTE } from '../shared/palette.js'

export const HORIZON_COLOUR_PARAMS = [
  { id: 'horizon.hex', owner: 'horizon', key: 'hex', kind: 'hidden', encode: 'int',
    value: PALETTE.sky.horizon, persist: false, label: 'horizon colour' },
]

/**
 * @param {{ sky: object, fog: { color: { set(hex: number): void } },
 *           sceneUniforms: object, clouds: object }} owners
 * @returns {{ params: object, forget(): void }}
 */
export function createHorizonColour({ sky, fog, sceneUniforms, clouds }) {
  // Nothing is applied until the first write, so that write always fans out
  // even when it equals the row's default.
  let applied = null
  return {
    forget() { applied = null },
    params: paramAccess({
      tables: [],
      rows: HORIZON_COLOUR_PARAMS,
      fields: {
        hex: {
          get: () => applied,
          set: hex => {
            applied = hex
            sky.params.set('horizonHex', hex)
            fog.color.set(hex)
            sceneUniforms.params.set('fogColor', hex)
            clouds.params.set('weatherSky', hex)
          },
        },
      },
    }),
  }
}
