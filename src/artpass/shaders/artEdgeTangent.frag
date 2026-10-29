/**
 * artEdgeTangent.frag — prepass 3 of 3. Turns the nearest-seed field into a smooth
 * edge direction.
 *
 * Taking the tangent as the perpendicular of `here - seed` does not work, and
 * the failure is visible rather than subtle:
 *
 *  - Both are integer pixel positions, so at short range the offset takes only
 *    a handful of values — at distance 1 there are eight — and the direction
 *    SNAPS to those angles. The alignment band becomes flat blocks.
 *  - Those blocks are the seeds' Voronoi cells, and the hard ticks between them
 *    are where the nearest seed flips from one to the next.
 *  - On the edge itself the offset is the zero vector and there is no direction
 *    at all.
 *
 * So the direction is fitted to the edge instead of inferred from one offset.
 * The seeds found by a neighbourhood of pixels all lie ON the edge, so they
 * trace it; the principal axis of their spread IS the local edge tangent. For a
 * 2x2 covariance [[a,b],[b,c]] that axis is 0.5*atan(2b, a-c) — which is
 * already a double angle, exactly the form an orientation wants, since a stroke
 * direction is a line and not an arrow.
 *
 * Fitting is confined to seeds near our own, so a window spanning two separate
 * ridges fits the nearer one rather than a line through both.
 *
 * Output: RG = the double-angle tangent vector mapped to 0..1, BA = distance to
 * the edge as a 16-bit value. One fetch downstream replaces this whole search.
 */

in  vec2 vUv;
out vec4 fragColor;

uniform sampler2D uSeed;
uniform vec2  uRes;
uniform float uFitRadius;      // half-width of the fitting window, pixels

const float NONE = 65535.0;
const float DIST_MAX = 4095.0; // distance is stored as 16-bit over this range

vec2 seedAt(vec2 uv) {
  vec4 b = texture(uSeed, uv) * 255.0;
  return vec2(b.x * 256.0 + b.y, b.z * 256.0 + b.w);
}

void main() {
  vec2 here = floor(vUv * uRes);
  vec2 s0 = seedAt(vUv);

  if (s0.x >= NONE) {
    // No edge anywhere: direction undefined, distance saturated.
    fragColor = vec4(0.5, 0.5, 1.0, 1.0);
    return;
  }

  float d0 = distance(here, s0);

  // Second moment of the neighbouring seeds about their own mean.
  vec2  sum = vec2(0.0);
  vec3  mom = vec3(0.0);          // (xx, xy, yy), accumulated then centred
  float n = 0.0;
  float R = max(uFitRadius, 1.0);
  float step = max(floor(R / 3.0), 1.0);

  for (int j = -12; j <= 12; j++) {
    float fj = float(j) * step;
    if (abs(fj) > R) continue;
    for (int i = -12; i <= 12; i++) {
      float fi = float(i) * step;
      if (abs(fi) > R) continue;
      vec2 uv = vUv + vec2(fi, fj) / uRes;
      if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) continue;
      vec2 s = seedAt(uv);
      if (s.x >= NONE) continue;
      // Only seeds belonging to the same stretch of edge. Without this a window
      // that reaches a second ridge fits a line through both of them.
      if (distance(s, s0) > R * 1.5) continue;
      sum += s;
      mom += vec3(s.x * s.x, s.x * s.y, s.y * s.y);
      n += 1.0;
    }
  }

  vec2 dir;
  if (n < 2.0) {
    // Too few seeds to fit. Fall back to the offset's perpendicular, which is
    // at least defined, and to a fixed direction when even that is degenerate.
    vec2 off = here - s0;
    dir = (length(off) > 1e-4) ? normalize(vec2(-off.y, off.x)) : vec2(1.0, 0.0);
  } else {
    vec2 mean = sum / n;
    float a = mom.x / n - mean.x * mean.x;
    float b = mom.y / n - mean.x * mean.y;
    float c = mom.z / n - mean.y * mean.y;
    // Principal axis as a double angle. Degenerate when the seeds are a single
    // point (a = c, b = 0), which the length test below catches.
    vec2 dbl = vec2(a - c, 2.0 * b);
    if (length(dbl) < 1e-6) {
      vec2 off = here - s0;
      dir = (length(off) > 1e-4) ? normalize(vec2(-off.y, off.x)) : vec2(1.0, 0.0);
    } else {
      dbl = normalize(dbl);
      // Halve the angle to recover the axis itself.
      float ang = 0.5 * atan(dbl.y, dbl.x);
      dir = vec2(cos(ang), sin(ang));
    }
  }

  // Stored as the DOUBLE angle, so consumers can blend it against another
  // orientation without opposing directions cancelling.
  float a2 = 2.0 * atan(dir.y, dir.x);
  vec2 enc = vec2(cos(a2), sin(a2)) * 0.5 + 0.5;

  float dn = clamp(d0 / DIST_MAX, 0.0, 1.0) * 65535.0;
  float dh = floor(dn / 256.0);
  float dl = floor(dn - dh * 256.0);
  fragColor = vec4(enc, dh / 255.0, dl / 255.0);
}
