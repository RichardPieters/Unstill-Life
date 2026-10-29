/**
 * artGround.frag — builds what lies under the paint. Run twice, as a separable
 * blur: once across, once down.
 *
 * This has to be a PREPASS, not per-fragment work. A hardware mip level is a
 * single prefiltered fetch — there are no taps in it to reject, so "stop
 * blurring across an edge" is not expressible there at any price. A gather is,
 * and doing it once per frame costs two passes instead of a lattice search
 * per pixel.
 *
 * Two jobs, chosen by uGroundMode, and they want OPPOSITE edge behaviour:
 *
 *  - Blurred source (mode 1) must NOT blur across an occlusion edge. Blurring a
 *    far plain into the cliff standing in front of it is a halo, and it reads
 *    as a glow around every ridge.
 *  - Segment solids (mode 3) must blur across, because softening the boundary
 *    between the three flat fields is the entire point of the mode.
 *
 * So the rejection is a flag rather than a policy. Where it is on, a tap is
 * dropped when its depth differs from the centre's by more than uEdgeTau — the
 * same relative test that defines an edge in artEdgeJfa.frag, for the same
 * reason: at 2000 units a 15-unit gap is nothing, near the camera it is a cliff.
 *
 * COST. At the default blur (mip level 4.8 → sigma 8.3px) the kernel is 51 taps
 * per axis, and every tap that survives to the rejection test costs a second,
 * dependent depth fetch. That is why it runs at a fraction of full resolution:
 * it is a blur several pixels wide by construction, so the resolution it is
 * computed at is the one thing about it that cannot show.
 *
 * Measured, this is the SECOND most expensive stage, not the first — the stroke
 * lattice in artPaint.frag costs more. Worth stating because the taps here look
 * far more alarming than the lattice candidates a paint fragment tests (25 at
 * the shipped defaults).
 */

//#include scene
//#include frame

in  vec2 vUv;
out vec4 fragColor;

uniform sampler2D uBeauty;
uniform sampler2D uPrev;       // previous blur pass; unused on the first

uniform vec2  uRes;            // this prepass's own resolution
uniform float uGroundMode;     // 1 = blurred source · 3 = segment solids
uniform float uGroundSigma;    // Gaussian sigma, in THIS pass's pixels
uniform float uEdgeTau;        // same relative depth jump that defines an edge
uniform float uRespectEdges;   // 0 = plain blur · 1 = fully held at an edge
uniform vec2  uAxis;           // (1,0) then (0,1)
uniform float uFirstPass;      // 1 = read the source, 0 = read uPrev

uniform vec3  uColSky;
uniform vec3  uColLand;
uniform vec3  uColWater;
uniform float uSegFog;         // how far fog melts the land colours into the sky

/** The unblurred ground: either the rendered frame, or one flat colour per segment. */
vec3 composeGround(vec2 uv) {
  if (uGroundMode > 2.5) {
    if (coverAt(uv) < 0.5) return uColSky;
    vec3 c = (waterAt(uv) > 0.5) ? uColWater : uColLand;
    // Far ridges are so deep in the scene's fog that they READ as sky — the
    // frame shows them as pale haze, not as terrain. Painting them the full
    // terrain colour puts solid green mountains where the picture has none. So
    // the land colours melt toward the sky colour by the scene's own fog.
    //
    // depth01 IS that fog ramp: terrain.frag mixes toward the fog colour by
    // clamp((viewZ - fogNear)/(fogFar - fogNear)), and viewZ is what depth01
    // normalises.
    return mix(c, uColSky, depth01(uv) * uSegFog);
  }
  return frameAt(uBeauty, uv);
}

vec3 srcAt(vec2 uv) {
  return (uFirstPass > 0.5) ? composeGround(uv) : texture(uPrev, uv).rgb;
}

void main() {
  float sigma = max(uGroundSigma, 0.0);
  if (sigma < 0.3) { fragColor = vec4(srcAt(vUv), 1.0); return; }

  // Three sigma: the kernel has decayed to ~1% at the rim, so the truncation
  // does not show as a ring. Capped at the loop bound, past which the blur
  // stops growing.
  float r = min(ceil(sigma * 3.0), 64.0);

  float centre = surfaceDistAt(vUv);
  vec2 stepUv = uAxis / uRes;
  vec3  acc = vec3(0.0);
  float wsum = 0.0;

  // A fixed trip count: the loop bound must be a constant, and a dynamic skip
  // past the radius keeps the cost proportional to the actual blur.
  for (int i = -64; i <= 64; i++) {
    float fi = float(i);
    if (abs(fi) > r) continue;
    vec2 uv = vUv + stepUv * fi;
    if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) continue;

    float w = exp(-0.5 * (fi * fi) / (sigma * sigma));

    // Rejection is a WEIGHT, not a yes/no. A hard cut leaves the blur with
    // straight hard-edged smears along every ridge — it reads as broken rather
    // than as edge-aware — and it loses the plain, even background a pure blur
    // gives. At uRespectEdges = 0 this is an ordinary blur.
    if (uRespectEdges > 0.0) {
      float t = surfaceDistAt(uv);
      float reject;
      if ((t < 0.0) != (centre < 0.0)) {
        reject = 1.0;                 // sky and surface never average together
      } else if (t < 0.0) {
        reject = 0.0;                 // both sky
      } else {
        // The same relative test that defines an edge, ramped rather than
        // thresholded so the transition itself is not a new hard line.
        float rel = abs(t - centre) / max(min(t, centre), 1e-4);
        reject = smoothstep(uEdgeTau * 0.5, uEdgeTau * 2.0, rel);
      }
      w *= mix(1.0, 1.0 - reject, clamp(uRespectEdges, 0.0, 1.0));
    }
    acc += srcAt(uv) * w;
    wsum += w;
  }

  // wsum is never zero: the centre tap always survives its own test.
  fragColor = vec4(acc / max(wsum, 1e-5), 1.0);
}
