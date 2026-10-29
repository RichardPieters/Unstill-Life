/**
 * artEdgeJfa.frag — the edge field's two jobs in one program: SEED the
 * occlusion boundaries (`uEdgeSeeding` 1, drawn once), then jump-flood them into a
 * distance field (`uEdgeSeeding` 0, drawn once per halving step).
 *
 * SEED
 * An edge here is a DEPTH discontinuity: a cliff standing against far plains, a
 * ridge cutting the valley behind it, the silhouette against the sky. Not a
 * material boundary — the terrain's zonation bands are altitude isolines, and
 * aligning strokes to those would draw a topographic map rather than a
 * painting. Measured on the reference capture, material boundaries cover 6.4%
 * of the frame against 1.14% for these, so they are also far too dense to act
 * as a local override.
 *
 * The test is RELATIVE — |z1 - z2| / min(z1, z2) — rather than an absolute
 * depth jump, because of perspective: at 40 world units the gap between a cliff
 * and the plain behind it might be 15 units and read as a hard edge, while at
 * 2000 units the same 15-unit gap is nothing at all. A fixed absolute threshold
 * therefore means something different in every part of the frame, and there is
 * no value that works both near and far. Dividing by the depth removes the
 * scale and the threshold means the same thing everywhere.
 *
 * Output is the JFA seed: a pixel that IS an edge stores its own coordinates,
 * everything else stores the sentinel. Coordinates are 16-bit — x in RG, y in
 * BA — because 8 bits cannot address a 1280-pixel axis.
 *
 * FLOOD
 * Jump flooding: each pass looks at the eight neighbours `uStep` pixels away
 * plus itself, and keeps whichever carries the nearest seed. Starting at a step
 * of half the larger axis and halving to 1 propagates every seed across the
 * whole frame in ceil(log2(N)) passes instead of N.
 *
 * The result is, for every pixel, the position of the nearest occlusion edge —
 * which gives BOTH the distance to it and the direction to it, at any range.
 * That is the whole point: a one-pixel central-difference detector aligns a
 * stroke only if its anchor happens to land in a 2-pixel band. Measured on the
 * reference capture, that catches 19.7% of the strokes overlapping an edge at
 * cell 3 and 6.7% at cell 21 — the reach has to scale with the stroke, and a
 * distance field is what makes that possible.
 *
 * Note JFA is APPROXIMATE: a small fraction of pixels resolve to a seed that is
 * not the true nearest, and the error mode is a far jump rather than a near
 * miss. Here that is tolerable because the field is only read inside a band a
 * stroke-radius wide, where seeds are dense and the approximation is exact in
 * practice; it would not be tolerable as a general SDF.
 */

//#include scene

in  vec2 vUv;
out vec4 fragColor;

uniform sampler2D uSeed;
uniform vec2  uRes;        // this prepass's own resolution, not the screen's
uniform float uStep;       // offset for this pass, in pixels
uniform float uEdgeSeeding;       // 1 = seed the edges, 0 = flood
uniform float uEdgeTau;    // relative depth jump that counts as an edge

const float NONE = 65535.0;

vec4 seedAt() {
  vec2 px = 1.0 / uRes;
  float t0 = surfaceDistAt(vUv);

  bool edge = false;
  for (int i = 0; i < 4; i++) {
    vec2 o = (i == 0) ? vec2(px.x, 0.0) : (i == 1) ? vec2(-px.x, 0.0)
           : (i == 2) ? vec2(0.0, px.y) : vec2(0.0, -px.y);
    float t1 = surfaceDistAt(vUv + o);

    // Sky against sky is not an edge; surface against sky always is. The
    // silhouette is an occlusion boundary against infinity, which is the
    // limiting case of the relative test rather than an exception to it.
    if (t0 < 0.0 && t1 < 0.0) continue;
    if (t0 < 0.0 || t1 < 0.0) { edge = true; break; }

    if (abs(t0 - t1) / max(min(t0, t1), 1e-4) > uEdgeTau) { edge = true; break; }
  }

  if (!edge) return vec4(1.0);   // sentinel: no seed here

  // Own pixel coordinates, 16-bit, high byte first. floor() not round(): the
  // value must land back on the same integer after the 0..255 round trip.
  vec2 ip = floor(vUv * uRes);
  float xh = floor(ip.x / 256.0), xl = ip.x - xh * 256.0;
  float yh = floor(ip.y / 256.0), yl = ip.y - yh * 256.0;
  return vec4(xh, xl, yh, yl) / 255.0;
}

vec2 decode(vec4 c) {
  vec4 b = c * 255.0;
  return vec2(b.x * 256.0 + b.y, b.z * 256.0 + b.w);
}

vec4 encode(vec2 p) {
  float xh = floor(p.x / 256.0), xl = p.x - xh * 256.0;
  float yh = floor(p.y / 256.0), yl = p.y - yh * 256.0;
  return vec4(xh, xl, yh, yl) / 255.0;
}

void main() {
  if (uEdgeSeeding > 0.5) { fragColor = seedAt(); return; }

  vec2 here = floor(vUv * uRes);

  vec2  best = decode(texture(uSeed, vUv));
  // A sentinel must lose to any real seed, so give it an unreachable cost
  // rather than its literal distance — (65535,65535) is finite, and on a big
  // enough target a genuine seed could in principle sit farther away.
  float bestD = (best.x >= NONE) ? 1e30 : distance(here, best);

  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      vec2 uv = vUv + vec2(float(dx), float(dy)) * uStep / uRes;
      if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) continue;
      vec2 cand = decode(texture(uSeed, uv));
      if (cand.x >= NONE) continue;
      float d = distance(here, cand);
      if (d < bestD) { bestD = d; best = cand; }
    }
  }

  fragColor = (bestD > 1e29) ? vec4(1.0) : encode(best);
}
