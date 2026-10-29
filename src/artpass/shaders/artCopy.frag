/**
 * artCopy.frag — a straight blit, used to HOLD a frame.
 *
 * The art pass freezes twice over: the painted lattice, so the strokes stop
 * being recomputed and therefore stop tracking a landscape that has started
 * moving again, and the frame that lattice was painted FROM, so the exit
 * animation has something to measure the live landscape's drift against.
 *
 * Both are plain copies, which is why one shader serves both. It exists at all
 * only because a WebGLRenderTarget cannot be aliased: the paint target is
 * rewritten every frame it repaints, so keeping its contents means
 * copying them somewhere the next frame will not touch.
 */

in  vec2 vUv;
out vec4 fragColor;

uniform sampler2D uSrc;

void main() {
  fragColor = texture(uSrc, vUv);
}
