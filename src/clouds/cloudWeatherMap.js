/**
 * cloudWeatherMap.js — the one-time bake of the weather-coverage texture the
 * cloud march reads as a coverage bias (cloudVolumeWeather.frag). A single
 * 512² half-float target, red channel only, repeat-wrapped; scrolled and scaled
 * at lookup time by cloudsVolume.js, never re-baked.
 */

import * as THREE from 'three'
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js'
import noiseGlsl from '../shared/shaders/noise.glsl?raw'
import weatherFragSrc from './shaders/cloudVolumeWeather.frag?raw'
import { inject } from '../shared/shaderCompose.js'

const VERT = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`

// Small: a single low-frequency pattern, tiled by uWeatherScale at lookup time,
// not a detail texture — 512 keeps the one-time bake cheap and leaves no visible
// texel grain at any sane tile size.
const RESOLUTION = 512

/**
 * Bake the weather-coverage texture once. Returns the render target (not just
 * its texture) so the caller can dispose it later if the volume is ever torn
 * down — same lifetime pattern as cloudsVolume.js's shape/light RTs.
 */
export function bakeWeatherMap(renderer) {
  const material = new THREE.ShaderMaterial({
    uniforms: {},
    vertexShader: VERT,
    fragmentShader: inject(weatherFragSrc, [
      ['// noise.glsl injected by cloudWeatherMap.js', noiseGlsl],
    ]),
  })
  const quad = new FullScreenQuad(material)
  const rt = new THREE.WebGLRenderTarget(RESOLUTION, RESOLUTION, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    wrapS: THREE.RepeatWrapping,
    wrapT: THREE.RepeatWrapping,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
  })
  const prevTarget = renderer.getRenderTarget()
  renderer.setRenderTarget(rt)
  quad.render(renderer)
  renderer.setRenderTarget(prevTarget)
  quad.dispose()
  material.dispose()
  return rt
}
