// cloudShade.glsl — the shading TAIL only: turns (brightness, alpha) into a
// final posterized colour.
//
// Kept apart from cloudCommon.glsl, which holds the march-only optics (slab
// intersection, Beer's law, HG phase, the Sint/powder experiments). Injected
// by cloudsVolume.frag.

// Hard floor bands: floor(x*N)/N — visible bands, a true replacement rather
// than a modulation.
// Shading tier/contrast count. <1 = off.
uniform float uCloudColorSteps;
// Opacity tier count: N flat levels spread evenly from 0 to 1. <2 = off.
uniform float uCloudAlphaTiers;

// Weather (atmosphere.js). uCloudWeatherSky is the scene's current horizon
// colour; uCloudWeatherGrey is how far cloud colour is pulled toward it as the
// sky goes overcast. See the use site in cloudPosterize for why this rides on
// top of the sun-height gradients rather than inside them.
uniform vec3  uCloudWeatherSky;
uniform float uCloudWeatherGrey;

// Two independent sun-height gradients, a shadow and a highlight palette.
// Shading isn't just "the highlight colour, dimmer": the shadow side is its own
// cooler/darker hue, not a scalar darkening of the highlight hue — that hue
// SHIFT (not just value change) is what a single gradient×brightness multiply
// can never produce.
vec3 cloudHighlightColor(float sunHeight) {
  vec3 night  = vec3(0.35, 0.36, 0.42);
  vec3 dawn   = vec3(0.95, 0.75, 0.55);
  vec3 day    = vec3(1.00, 1.00, 0.98);
  vec3 c = mix(night, dawn, smoothstep(-0.15, 0.05, sunHeight));
  c = mix(c, day, smoothstep(0.05, 0.4, sunHeight));
  return c;
}
vec3 cloudShadowColor(float sunHeight) {
  vec3 night  = vec3(0.02, 0.03, 0.06);
  vec3 dawn   = vec3(0.35, 0.22, 0.28);
  vec3 day    = vec3(0.45, 0.50, 0.58);
  vec3 c = mix(night, dawn, smoothstep(-0.15, 0.05, sunHeight));
  c = mix(c, day, smoothstep(0.05, 0.4, sunHeight));
  return c;
}

/**
 * Brightness + alpha BEFORE posterize — the thin-cloud floor and the local
 * brightness gamma, nothing else.
 */
vec2 cloudShadeContinuous(float lightEnergy, float transmittance) {
  // Thin-cloud brightness floor: a flat 0.5*transmittance added to brightness
  // unconditionally — transmittance is high (near 1) exactly where the cloud is
  // thin/translucent, tapering to 0 as it goes opaque, so this guarantees a
  // minimum brightness for any visible-but-thin cloud regardless of how
  // absorption/ambient happen to be tuned, on top of the marcher's
  // ambient-scales-with-absorption term.
  float brightness = clamp(lightEnergy + 0.5 * transmittance, 0.0, 1.0);

  // Local gamma on the brightness scalar only — NOT the final composited
  // colour, which would mismatch the scene's ungammaed brightness curve at
  // partial-alpha edges (a dull grey-blue fringe). It shapes the tonal curve of
  // one intermediate scalar before it selects a palette mix. No double-encoding
  // risk: this project's custom ShaderMaterials never include
  // <colorspace_fragment>, so nothing else in the pipeline applies gamma.
  brightness = pow(brightness, 1.0 / 2.2);

  float alpha = 1.0 - transmittance;
  return vec2(brightness, alpha);
}

/**
 * Posterize + the shadow/highlight colour mix + the weather grey pull — the
 * ONLY nonlinear (quantizing) step in the whole shading tail. Takes the
 * continuous brightness/alpha from cloudShadeContinuous.
 */
vec4 cloudPosterize(float brightness, float alpha, float sunHeight) {
  // Hard bands: N flat levels spread evenly over 0..1 (0, 1/(N-1), ..., 1), so the
  // densest band is fully opaque and nothing behind a thick cloud shows through.
  // Alpha bands over its whole range, faint wisps included, which can read as grey
  // sheets over terrain.
  //
  // Colour steps use floor(x*N)/N with a min(): floor(x*N) is N, a bucket of its
  // own, only at x == 1.0 exactly, and N-1 for the whole interval below. The march
  // never produces alpha 1, but the RGBA8 target stores anything at or above
  // 254.5/255 as 255, which reads back as exactly 1.0 (measured in one dense
  // frame: 10.0% of cloud pixels at 255, 83% at 253-254). One part in 255 of input
  // would then become a full 1/N of output, pale flecks in a flat deck. The min()
  // folds that point into the top level.
  if (uCloudColorSteps >= 1.0) {
    brightness = min(floor(brightness * uCloudColorSteps), uCloudColorSteps - 1.0)
               / uCloudColorSteps;
  }
  if (uCloudAlphaTiers >= 2.0) {
    alpha = min(floor(alpha * uCloudAlphaTiers), uCloudAlphaTiers - 1.0)
          / (uCloudAlphaTiers - 1.0);
  }

  vec3 color = mix(cloudShadowColor(sunHeight), cloudHighlightColor(sunHeight), brightness);
  // Weather: the two gradients above know only the sun height, so under a solid
  // overcast lid the cloud would still be a bright clear-day colour against a
  // grey sky. uCloudWeatherGrey pulls toward the sky colour (the underside of a
  // lid is the sky), weighted toward bright pixels, where the day highlight
  // reads as glare; the dim side needs no such pull. Applied after the mix so
  // the gradients stay the single source of clear-weather colour. 0 = untouched.
  float greyAmt = uCloudWeatherGrey * mix(0.5, 1.0, brightness);
  color = mix(color, uCloudWeatherSky, greyAmt);
  return vec4(color, alpha);
}

/**
 * The shading tail: turns the two scalars a march produces (accumulated
 * in-scattered light, and the surviving view-ray transmittance) into the final
 * premix colour + alpha.
 */
vec4 cloudShade(float lightEnergy, float transmittance, float sunHeight) {
  vec2 c = cloudShadeContinuous(lightEnergy, transmittance);
  return cloudPosterize(c.x, c.y, sunHeight);
}
