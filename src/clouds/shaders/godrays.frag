precision highp float;

// cloudCommon.glsl injected by godrays.js

/**
 * godrays.frag — volumetric crepuscular rays, marched through the SAME baked
 * sun-shadow field the clouds light themselves with.
 *
 * WHY A MARCH AND NOT THE USUAL SCREEN-SPACE TRICK. The standard godray is
 * GPU Gems 3's radial blur from the light's screen position. It needs the
 * OCCLUDERS rasterized in frame, and here they are not: the shipped camera
 * looks roughly 90 degrees away from the sun (against a 36 degree horizontal
 * half-FOV), so the sun and the clouds that shadow the visible air are outside
 * the frame, and no screen-space variant can recover an occluder that was never
 * drawn.
 *
 * The same geometry is why this is worth doing: a sun to the side of the view
 * throws long beams ACROSS the frame rather than a radial burst around a
 * visible disc, which is the more legible of the two.
 *
 * WHAT THIS ACCUMULATES. In-scattered sunlight along the view ray:
 *
 *   L = sum over steps of  sunTransmittance(p) * stepWeight
 *
 * then scaled by the medium's density and the phase function. The shadow term
 * is one trilinear fetch of the cloud volume's baked optical depth — no fBM, no
 * second shadow map, nothing new baked. See terrain.frag's cloudSunlight for
 * the projection and why the height coordinate is 0.
 */

uniform sampler2D uDepthTexture;
uniform sampler2D uCloudGround; // optical depth of the whole column at each cloud-space cell (.g)

uniform mat4  uInverseProjection;
uniform mat4  uInverseView;
uniform vec3  uCameraPos;
uniform float uSeaLevel;        // world Y of the (flat) water plane — see the water clip below
// uCameraNear/uCameraFar and viewZFromDepth come from cloudCommon.glsl, along
// with beersLaw and henyeyGreenstein — re-declaring them here is a compile
// error, not a shadowing.

uniform vec3  uSunDir;          // normalised, same vector terrain.frag shades with
uniform float uCloudLevel;      // shell floor, world Y
uniform float uCloudHeight;     // shell thickness
uniform float uCloudExtent;     // world size of one wrap of the volume
uniform vec2  uCloudWind;       // cloud-space scroll, so beams drift with the cloud

uniform float uRaySteps;        // samples along the view ray
uniform float uRayMaxDist;      // stop here even if nothing was hit
uniform float uRayAbsorption;   // optical depth -> shadow, this pass's own
uniform float uRayDensity;      // how much medium is in the air
uniform float uRayAniso;        // Henyey-Greenstein g
uniform float uUsableRadius;    // beyond this the volume repeats — fade out
uniform float uJitter;          // 0..1, breaks the march's banding into noise
uniform float uRayHardness;     // 0 = the raw soft field, 1 = a hard lit/shadow cut
uniform float uRayThreshold;    // WHERE the cut sits in the field's own range
uniform float uRayDeckFade;     // world units over which a shaft dissolves INTO the deck
uniform float uRayDrop;         // how fast a shaft dims on its way DOWN from the deck

uniform float uShadowTiers;     // the GROUND shadow's tier count — see cutLevel()
uniform float uRayCutSnap;      // 0 = the raw threshold, 1 = snapped to a ground tier edge

uniform float uRayNearFade;     // world units in front of the camera that carry no shaft

varying vec2 vUv;

// Interleaved gradient noise (Jorge Jimenez, "Next Generation Post Processing in
// Call of Duty: Advanced Warfare", SIGGRAPH 2014) — the same cheap per-pixel hash the cloud march
// jitters with. A march this coarse lays down concentric banding without it.
float igNoise(vec2 p) {
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}

/** Cloud-base coordinate a sub-deck point sees the sun through. */
vec2 sunFootprint(vec3 p) {
  float rise = max(uCloudLevel - p.y, 0.0);
  vec3  q = p + uSunDir * (rise / max(uSunDir.y, 1e-3));
  return (q.xz + uCloudWind) / uCloudExtent;
}

/**
 * WHERE the lit/shadow cut sits, snapped onto the GROUND shadow's own ladder.
 *
 * terrain.frag and water.frag quantise their shadow with posterizeShadow: with
 * uCloudShadowTiers = n+1 the visible steps are at transmittance k/n. Those are
 * the only places the ground's shade actually changes — everywhere between two
 * steps it is flat. A beam cut at some unrelated transmittance therefore lands
 * in the MIDDLE of a flat ground band, and the shaft and the pool of light it
 * falls into are two separate events that happen to be near each other.
 *
 * Snapping the cut to the nearest of those steps makes them one boundary: the
 * air goes dark exactly where the ground it is standing over does. The ray and
 * the ground read the same baked field through the same Beer's law, so with the
 * two absorptions equal the edges coincide in world space, not merely in value
 * (shipped 0.59 here against 0.60 on the ground, so nearly so). The two
 * absorptions are separate rows and the density dial moves only the ground's:
 * once it has, the edges are near each other but no longer one boundary.
 *
 * uRayCutSnap blends back to the raw threshold, for tuning the beams apart from
 * the shade on purpose.
 */
float cutLevel() {
  if (uShadowTiers < 2.0) return uRayThreshold;
  float n = uShadowTiers - 1.0;
  // floor(x+0.5) rather than round(): the same value, and no dependence on
  // which GLSL level this ends up compiled at.
  float snapped = clamp(floor(uRayThreshold * n + 0.5) / n, 1.0 / n, 1.0);
  return mix(uRayThreshold, snapped, clamp(uRayCutSnap, 0.0, 1.0));
}

/**
 * How much sun reaches a point BELOW the cloud base. 1 = open sun.
 *
 * Only below: the march never goes meaningfully higher (see the far clamp in
 * main and deckFade), so this has one regime rather than three. Project the point up the sun ray onto the
 * cloud base and read the bottom layer, which stores the whole column's optical
 * depth toward the sun.
 *
 * WHY THIS IS WHAT MAKES THE BEAMS STRAIGHT. The projection is
 *
 *   q.xz = p.xz + (uCloudLevel - p.y) * uSunDir.xz / uSunDir.y
 *
 * so the shadow everywhere under the deck is one 2D field read at a sheared
 * offset. A lit/shadow boundary in that plane therefore extrudes downward into
 * a PLANE in 3D — and a plane, seen in perspective, projects to a straight line.
 * Straight beams are a consequence of the geometry, not something that has to be
 * drawn. What they need is for the field to have boundaries at all, which is
 * what uRayHardness is for: the baked field is low-frequency and trilinear, and
 * extruding something that smooth gives blobs.
 */
float sunlightAt(vec3 p) {
  // .g, the optical depth of the whole column above this ground point, the same
  // value the ground shadow reads.
  float t = beersLaw(texture(uCloudGround, sunFootprint(p)).g, uRayAbsorption);
  float cut = cutLevel();
  // Sharpen toward a cut. The half-width shrinks as hardness rises, so 0 leaves
  // the field as it is and 1 is very nearly binary.
  //
  // uRayThreshold is WHERE the cut sits, and it is not 0.5 for a measured
  // reason: this field is mostly lit. Sampled at the ground over the land band,
  // its median transmittance is 0.99 and only the bottom 5% falls below 0.51 —
  // so a cut at the middle of [0,1] calls essentially everything lit and the
  // march returns a uniform glow with no beams in it at all. The cut has to sit
  // up where the field actually varies.
  float w = mix(0.5, 0.02, clamp(uRayHardness, 0.0, 1.0));
  return smoothstep(cut - w, cut + w, t);
}

/**
 * How much a sample still counts as sub-cloud air. 1 below the deck, 0 once it
 * is properly inside it.
 *
 * Crepuscular rays exist in the air BELOW a cloud deck; the deck itself is
 * opaque and the cloud pass draws it. But cutting the march off at the base
 * plane makes every shaft end on that plane at once, which reads as light
 * switching on at a fixed altitude instead of streaming out of a cloud. Fading
 * over the first few tens of units of deck lets a shaft dissolve into the thing
 * casting it, which is what the eye expects.
 *
 * It also means a ray that punches through the deck contributes nothing above
 * it, so there is no bright "full sun" region beyond the cloud and no hard
 * boundary across the sky where rays happen to exit.
 */
float deckFade(vec3 p) {
  float into = 1.0 - smoothstep(uCloudLevel, uCloudLevel + max(uRayDeckFade, 1e-3), p.y);
  // ...and dim on the way DOWN. In every photograph of crepuscular rays the
  // shaft is brightest where it leaves the cloud and dissipates toward the
  // ground: the beam spreads, and the haze between it and the viewer scatters it
  // out. Without this the shaft is equally bright along its whole length, which
  // is what makes it read as a flat overlay laid on the picture rather than as
  // light coming out of a cloud.
  float below = max(uCloudLevel - p.y, 0.0);
  return into * exp(-below * uRayDrop);
}

void main() {
  vec4 clip    = vec4(vUv * 2.0 - 1.0, -1.0, 1.0);
  vec4 viewPos = uInverseProjection * clip;
  vec3 rayView = normalize(viewPos.xyz / viewPos.w);
  vec3 rd      = normalize(mat3(uInverseView) * rayView);
  vec3 ro      = uCameraPos;

  // Stop at whatever the scene already drew. A ray that hits nothing still
  // stops, at uRayMaxDist — otherwise sky pixels march to the far plane and
  // spend most of their steps in air the fog has already whited out.
  //
  // uDepthTexture is water.js's own depth prepass, rendered with the water
  // MESH HIDDEN (so water.frag can read actual underwater depth from it) —
  // which leaves it blind to the water surface itself. Without the clip
  // below, a beam over a lake would march all the way to the real lake floor,
  // as if the water weren't there, and never meet the water plane it is
  // supposed to. Clipped analytically against the (flat) sea-level
  // plane instead of a second depth pass — cheap, and a soft volumetric
  // shaft has no need of the water's own ripple detail.
  float terrainViewZ = viewZFromDepth(texture2D(uDepthTexture, vUv).r);
  float sceneDist = (rayView.z < -1e-5) ? (terrainViewZ / rayView.z) : 1e9;
  if (ro.y > uSeaLevel && rd.y < -1e-5) {
    sceneDist = min(sceneDist, (uSeaLevel - ro.y) / rd.y);
  }
  float far = min(min(sceneDist, uRayMaxDist), uUsableRadius);

  // Room for the ray to enter the deck and DISSOLVE in it — see deckFade. A
  // hard stop at the cloud base would read exactly as what it is: every shaft
  // terminating on one flat plane, so the light looks like it spawns at cloud
  // level rather than coming out of the cloud.
  if (rd.y > 1e-4) {
    far = min(far, max(uCloudLevel + uRayDeckFade - ro.y, 0.0) / rd.y);
  }
  if (far <= 0.0) { gl_FragColor = vec4(0.0); return; }

  int   steps = int(clamp(uRaySteps, 1.0, 96.0));
  float dt    = far / float(steps);
  // Jittered start, or the fixed step lays down rings centred on the camera.
  float t     = dt * mix(0.5, igNoise(gl_FragCoord.xy), uJitter);

  // Single scattering WITH extinction, not a plain average.
  //
  // The obvious form — mean transmittance along the ray, times the distance
  // walked — is wrong and looks it. Multiplying by path length makes the result
  // a depth gradient with a faint shadow modulation riding on it, and over the
  // march's length the mean washes the shadow structure out entirely: a
  // uniform lift across the whole frame, not beams.
  //
  // Carrying transmittance back toward the camera fixes both: contributions
  // attenuate with distance, so the near field dominates and the integral
  // saturates instead of growing without bound. `1 - att` rather than
  // `sigma * dt` is the energy-conserving step weight (Hillaire) — the exact
  // integral of an exponentially decaying source across the step.
  float sigma = max(uRayDensity, 1e-6);
  float att   = exp(-sigma * dt);
  float T     = 1.0;
  float L     = 0.0;
  for (int i = 0; i < 96; i++) {
    if (i >= steps) break;
    vec3 p = ro + rd * t;
    // Nothing in the first stretch of air in front of the lens. A shaft is a
    // thing seen ACROSS the landscape, at a distance; the few dozen units at
    // the camera's nose subtend most of the frame, so any light picked up there
    // arrives as a flat veil over the whole picture rather than as a beam with
    // a shape. It is also the part of the march the extinction weighting favours
    // most, so it dominates before it earns it. Smooth, not a hard start, or the
    // cut itself draws a visible front across the image.
    float nearW = smoothstep(0.0, max(uRayNearFade, 1e-3), t);
    L += sunlightAt(p) * deckFade(p) * nearW * T * (1.0 - att);
    T *= att;
    t += dt;
  }

  // Phase, NORMALISED against isotropic so 1.0 means "no directional bias" and
  // the brightness knob downstream stays meaningful. g (uRayAniso) cannot
  // change the lit/shadowed CONTRAST at a pixel, since shadowed air has no
  // direct in-scatter for it to scale, so it is not a brightness control. What
  // it does is vary across the frame with the view ray: a sunward/anti-sunward
  // gradient of 7.4x at g = 0.7 against 2.1x at g = 0.2 — the bright-side glare
  // that makes the effect read as light rather than fog.
  const float FOUR_PI = 12.56637061;
  float phase = henyeyGreenstein(dot(rd, uSunDir), uRayAniso) * FOUR_PI;

  // Fade out where the volume starts repeating, the same guard the cloud march
  // uses, or beams tile visibly across the horizon.
  float edge = 1.0 - smoothstep(uUsableRadius * 0.75, uUsableRadius, far);

  // The weather gate is NOT here — it is one scalar per frame, so it rides on
  // the composite's brightness instead, and the JS side skips this march
  // entirely while it is closed. See godrays.js setOvercast().
  gl_FragColor = vec4(vec3(L * phase * edge), 1.0);
}
