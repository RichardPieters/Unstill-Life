/**
 * artGrowthPick.frag — finds where the growth should START.
 *
 * Renders the frame down to a very small grid (32x32), each cell carrying the
 * MEAN colour of the block it covers. artPass.js then reads those few hundred
 * bytes back once per playReveal() and takes the darkest cell as the seed.
 *
 * The averaging is the whole point, and is why this is a pass rather than a
 * single texture fetch at a small LOD: the seed must land in the darkest
 * PATCH, not on the darkest PIXEL. A lone dark speck in an otherwise light
 * passage — one shaded rock face, a single pixel of deep shadow between two
 * trees — is the darkest pixel in the frame surprisingly often, and starting
 * there puts the growth in a place with nowhere to grow, so the reveal opens
 * by painting a tiny isolated spot and then jumping somewhere else entirely.
 * A block mean cannot be dragged down by one pixel, so the darkest cell is
 * reliably a dark AREA.
 *
 * (Mip level 5 of the frame would give the same average for free, but the
 * composited buffer has no mip chain generated, and building one every reveal
 * to read four hundred pixels off the bottom of it costs more than this does.)
 */

//#include frame

in  vec2 vUv;
out vec4 fragColor;

uniform sampler2D uBeauty;
uniform vec2  uRes;         // this tiny target's own resolution

const int TAPS = 4;         // per axis, so 16 samples per cell

void main() {
  vec2 cell = 1.0 / uRes;
  vec2 corner = floor(vUv * uRes) * cell;

  vec3 sum = vec3(0.0);
  for (int j = 0; j < TAPS; j++) {
    for (int i = 0; i < TAPS; i++) {
      vec2 uv = corner + (vec2(float(i), float(j)) + 0.5) / float(TAPS) * cell;
      sum += frameAt(uBeauty, uv);
    }
  }

  fragColor = vec4(sum / float(TAPS * TAPS), 1.0);
}
