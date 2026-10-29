precision highp float;

// noise.glsl injected by water.js

// The ripple clock (waterDriver.js): advanced by sim dt × wave speed × a
// momentum pace; separate from the terrain's noiseTime.
uniform float uTime;
uniform float uRippleAmp;    // vertical ripple amplitude (world units)
uniform float uRippleScale;  // spatial frequency of ripples
uniform float uWaveNoiseMix; // 0 = pure sine swell, 1 = pure 3D-noise detail

varying vec3 vWorldPos;
varying vec3 vNormal;

// Three directional sinusoids — this IS the traveling wave: fixed
// direction/wavelength/phase speed per term, so a crest can be tracked
// moving a specific way. Kept as the dominant term (see wave() below) so
// that character survives; pure noise alone reads as an amorphous blob with
// no trackable motion. Writes its exact slope d(height)/d(xz) into `slope`.
float swell(vec2 p, out vec2 slope) {
  float a = p.x * uRippleScale + uTime;
  float b = p.y * uRippleScale * 1.3 + uTime * 0.8;
  float c = (p.x + p.y) * uRippleScale * 0.7 + uTime * 1.3;
  slope = 0.5 * uRippleScale * vec2(cos(a) + 0.7 * cos(c), 1.3 * cos(b) + 0.7 * cos(c));
  return (sin(a) + sin(b) + sin(c)) * 0.5;
}

// 3D simplex noise layered ON TOP of the swell, not replacing it — same
// vec3(xz, time) convention as the terrain's fBM. Higher frequency, and
// uWaveNoiseMix controls how much of it shows: it roughens the swell's
// surface (cross-chop) without touching its direction or speed.
//
// Returns the height and its exact slope d(height)/d(xz): the sines' by hand,
// the noise's from snoise_grad. The surface normal is built from the slope, not
// from extra samples of the height.
float wave(vec2 p, out vec2 slope) {
  vec2 baseSlope;
  float base = swell(p, baseSlope);

  vec3 noiseGrad;
  float detail = snoise_grad(vec3(p * uRippleScale * 1.5, uTime * 0.6), noiseGrad);
  vec2 detailSlope = noiseGrad.xy * (uRippleScale * 1.5);

  slope = mix(baseSlope, detailSlope, uWaveNoiseMix);
  return mix(base, detail, uWaveNoiseMix);
}

void main() {
  vec3 pos = position;          // plane already rotated into XZ (y = 0 local)

  vec2 slope;
  pos.y += wave(pos.xz, slope) * uRippleAmp;
  // Normal of the height field y = h(x, z): the cross product of its two tangents
  // (1, h_x, 0) and (0, h_z, 1), which is (−h_x, 1, −h_z). Its length is not 1,
  // so it is normalised; the height carries the amplitude, so the slopes do too.
  vec3 n = normalize(vec3(-slope.x * uRippleAmp, 1.0, -slope.y * uRippleAmp));

  // modelMatrix: plane space → world. It carries the mesh's Y, the sea level.
  // w = 0 for the normal drops the translation, since a direction does not move.
  vNormal   = normalize((modelMatrix * vec4(n, 0.0)).xyz);
  vWorldPos = (modelMatrix * vec4(pos, 1.0)).xyz;
  // modelViewMatrix: plane space → camera space; projectionMatrix: camera space
  // → clip space (the screen position, before the divide by w).
  gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
}
