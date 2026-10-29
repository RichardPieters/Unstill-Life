precision highp float;

/**
 * godraysComposite.frag — upsample the reduced-resolution march, quantise it
 * into flat tiers, and add it to the frame.
 *
 * THE ORDER MATTERS AND IT IS THIS WAY ROUND. Posterize is a hard floor(), so
 * once independent per-pixel march noise has pushed neighbours to opposite
 * sides of a tier edge, blurring the QUANTISED output can only blend two flat
 * values — it cannot undo the scatter. Smoothing the CONTINUOUS value first
 * means neighbours agree before they ever reach the threshold. This is the same
 * reasoning cloudShade.glsl writes down for the cloud composite, and the
 * reason the march runs jittered at reduced resolution in the first place.
 *
 * The tier ladder is the antialiased ceil the rest of the scene uses, with a
 * CLAMPED fwidth. Unclamped, a far pixel covers enough world that the ramp
 * spans a whole tier and the ladder degenerates into the smooth wash it exists
 * to prevent (the same failure the ground shadows avoid).
 */

uniform sampler2D tDiffuse;
uniform sampler2D uRayTex;
uniform vec2      uRayTexel;     // 1 / march-target size, for the upsample taps
uniform vec3      uRayColor;
uniform float     uRayIntensity;
uniform float     uRayTiers;     // flat tiers; <2 = smooth
uniform float     uRaySoften;    // extra blur radius in march-target texels
/**
 * The weather gate: 0 = no shafts at all, 1 = full strength.
 *
 * Crepuscular rays are a heavy-overcast sight. They need a deck thick enough
 * that the air under it is genuinely dark, and a break in it for the light to
 * come through — so they belong to the top of the overcast range, not to it
 * generally. The gate is one scalar for the whole frame, computed on the JS
 * side from the weather's own overcast (godrays.js setOvercast), which is also
 * where the march gets skipped outright once it reaches 0.
 *
 * Applied BEFORE the tier ladder, so a gate opening does not just dim the bands
 * — it walks the shafts up through them, one step at a time, the way the rest
 * of this picture changes.
 */
uniform float     uRayWeather;

/**
 * Cloud-density multiplier on shaft brightness (cloudDialsMath.js).
 *
 * SEPARATE from uRayIntensity rather than folded into it, so the intensity
 * slider keeps saying what it means: this scales whatever that slider is set
 * to, instead of overwriting it and leaving a control that silently does
 * nothing whenever the density dial moves.
 *
 * Denser deck, harder shafts. Physically the deck blocks more of the light,
 * but the beams that do get through read HARDER, because the sky they cross is
 * darker — so this rises with density rather than falling with it.
 */
uniform float     uRayIntensityScale;

varying vec2 vUv;

/** Small tent blur on the CONTINUOUS value, before any quantising. */
float rayAt(vec2 uv) {
  if (uRaySoften <= 0.0) return texture2D(uRayTex, uv).r;
  vec2 o = uRayTexel * uRaySoften;
  float c = texture2D(uRayTex, uv).r * 4.0;
  c += texture2D(uRayTex, uv + vec2( o.x, 0.0)).r * 2.0;
  c += texture2D(uRayTex, uv + vec2(-o.x, 0.0)).r * 2.0;
  c += texture2D(uRayTex, uv + vec2(0.0,  o.y)).r * 2.0;
  c += texture2D(uRayTex, uv + vec2(0.0, -o.y)).r * 2.0;
  c += texture2D(uRayTex, uv + o).r;
  c += texture2D(uRayTex, uv - o).r;
  c += texture2D(uRayTex, uv + vec2( o.x, -o.y)).r;
  c += texture2D(uRayTex, uv + vec2(-o.x,  o.y)).r;
  return c / 16.0;
}

/**
 * Quantise, FLOORING rather than ceiling.
 *
 * The cel ladder elsewhere in this scene rounds UP, which is right for `shade`
 * — a surface is never unlit, so the top of each band is the honest
 * representative. It is exactly wrong for an ADDITIVE term that is zero across
 * most of the frame: a ceil lifts every faint non-zero value to a whole tier, so
 * air carrying one part in a hundred of a beam gets a quarter of one, and the
 * entire picture washes out.
 *
 * So this holds at the floor of each band and only steps at the top, where the
 * antialiasing ramp is. Zero stays zero.
 */
float posterize(float v) {
  if (uRayTiers < 2.0) return v;
  float n = uRayTiers;
  float q = v * n;
  float f = floor(q);
  float w = clamp(fwidth(q), 1e-5, 0.5);
  return (f + smoothstep(1.0 - w, 1.0, q - f)) / n;
}

void main() {
  vec4 base = texture2D(tDiffuse, vUv);
  float ray = posterize(clamp(rayAt(vUv) * uRayIntensity * uRayWeather * uRayIntensityScale, 0.0, 1.0));

  // SCREEN, not a plain add.
  //
  // A straight `base + ray` brightens everything by the same amount, so the
  // parts of the picture that were already bright — the sky, the snow, the lit
  // slopes — are the first to blow out, and the whole frame washes pale before
  // the shafts are strong enough to read. Weighting by (1 - base) puts the light
  // where there is room for it: a shaft crossing dark ground lifts it a lot, the
  // same shaft crossing bright snow barely touches it, and nothing can be pushed
  // past white.
  //
  // It is also the honest model. A shaft is light scattered toward the eye out
  // of the air IN FRONT of whatever is behind it, so what it can add is bounded
  // by how much of that pixel is not already light coming from the surface.
  gl_FragColor = vec4(base.rgb + uRayColor * ray * (1.0 - base.rgb), base.a);
}
