/**
 * artQuad.vert — the vertex stage every art-pass fullscreen program shares.
 *
 * FullScreenQuad draws ONE triangle covering the viewport, with uv already
 * running 0..2 across it, so the position needs no transform and the uv needs
 * no adjustment.
 *
 * There is deliberately no y-flip anywhere in this pass: every input is a
 * three.js texture or a render target written by this same pass, so one
 * orientation convention holds throughout. (A flip applied to only some of the
 * passes would scramble the jump-flood chain.)
 */
out vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
