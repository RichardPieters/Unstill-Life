// cloudVolumeWeather.frag — one-time bake of the weather-coverage texture: a
// small, fixed, low-frequency signed fBM (2 octaves) over [0,1]² UV space. The
// world size of a tile is uWeatherScale, applied when the march reads it. Never
// re-baked: the weather drifts by scrolling this texture (uWeatherOffset),
// independent of the wind, see weatherBias() in cloudsVolume.frag. snoise is
// not periodic, so the repeat edge is not guaranteed seamless.
//
// noise.glsl injected by cloudWeatherMap.js

varying vec2 vUv;

const float BASE_FREQ  = 3.0;
const float LACUNARITY = 2.3;
const float GAIN       = 0.5;

void main() {
  vec3 q = vec3(vUv * BASE_FREQ, 0.5);
  float v = snoise(q);
  v += GAIN * snoise(q * LACUNARITY);
  v *= 1.0 / (1.0 + GAIN);   // amplitude-normalised, stays in ~[-1, 1]
  gl_FragColor = vec4(v, 0.0, 0.0, 1.0);
}
