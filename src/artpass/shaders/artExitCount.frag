/**
 * artExitCount.frag — which strokes of the lattice have gone, one texel each.
 *
 * Asks artExit.glsl's rule of every cell of the base lattice, at the anchor the
 * lattice table holds, with the stroke id the paint pass gives the cell. The
 * result is read back (a few thousand texels, asynchronously) and counted, so
 * the sound can follow the strokes actually leaving the picture, burst for
 * burst, which the drift rule makes unpredictable in advance.
 *
 * The same ratchet as the dissolve: once gone, always gone. The count covers the
 * base lattice, a fair sample of the rest: a stroke buried under others counts
 * as gone although nothing visible happens, but they are spread at random, so
 * the share is right.
 */

//#include hash
//#include format
//#include lattice
//#include frame
//#include exit

out vec4 fragColor;

uniform vec2 uRes;               // the frame, in pixels
uniform sampler2D uBirthBase;    // the base lattice table: GB the anchor
uniform sampler2D uPrevGone;     // this pass's own output, one frame ago
uniform float uHavePrev;         // 0 on the first frame of an exit

void main() {
  ivec2 texel = ivec2(gl_FragCoord.xy);
  vec2 cell = vec2(texel) + vec2(float(TABLE_ORIGIN));
  vec2 anchorPx = texelFetch(uBirthBase, texel, 0).yz;
  // The id the stroke carries in the paint buffer (artPaint.frag's `ord`).
  float gone = strokeGone(hash1(cell, 41.9), clamp(anchorPx / uRes, 0.0, 1.0));
  float prev = uHavePrev > 0.5 ? texelFetch(uPrevGone, texel, 0).r : 0.0;
  fragColor = vec4(max(gone, prev), 0.0, 0.0, 1.0);
}
