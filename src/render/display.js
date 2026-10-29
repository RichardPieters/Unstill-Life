/**
 * display.js — the `display` owner: the render resolution, as one param row held
 * by `display.params`. pixelRatio.js has the pure ratio arithmetic.
 *
 * The owner sets the renderer's own ratio. The consumers that copy it or size
 * from it (the composer, every per-pixel render target) follow through
 * `params.onChange('pixelRatioCap')`, wired by main.js, since they are built
 * after the renderer.
 */
import { paramAccess } from '../shared/paramAccess.js'
import { cappedPixelRatio } from './pixelRatio.js'

export const DISPLAY_PARAMS = [
  // The ceiling on drawn pixels per CSS pixel; cost grows with its square. 2 is
  // a Retina screen at its full sharpness, anything lower looked too soft.
  { id: 'ctrl-pixel-ratio', owner: 'display', key: 'pixelRatioCap', kind: 'slider', encode: 'float',
    value: 2, min: 0.5, max: 2, step: 0.25, digits: 2, persist: false, label: 'render resolution' },
]

/**
 * @param {{ setPixelRatio(ratio: number): void }} renderer
 * @param {() => number} [deviceRatio]  injectable for tests
 * @returns {{ params: object, ratio(): number }}  `ratio()` is the ratio rendered at now
 */
export function createDisplay(renderer, deviceRatio = () => window.devicePixelRatio) {
  let cap = DISPLAY_PARAMS[0].value
  const ratio = () => cappedPixelRatio(deviceRatio(), cap)
  renderer.setPixelRatio(ratio())
  const params = paramAccess({
    tables: [],
    rows: DISPLAY_PARAMS,
    fields: {
      pixelRatioCap: {
        get: () => cap,
        set: v => { cap = v; renderer.setPixelRatio(ratio()) },
      },
    },
  })
  return { params, ratio }
}
