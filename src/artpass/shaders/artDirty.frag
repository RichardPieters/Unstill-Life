/**
 * artDirty.frag — which parts of the canvas a stroke arriving this frame can
 * touch.
 *
 * One texel per BLOCK of uCellPx screen pixels. A block is dirty when some
 * stroke born since the last frame (a birth time in (uPrevSpawn, uRevealSpawn])
 * can reach any pixel in it. The stroke pass redraws the pixels of dirty blocks
 * and discards every other pixel, so they keep what the last frame left in the
 * target: during a reveal a frame repaints the few blocks around the strokes
 * that just arrived, not the whole canvas.
 *
 * The test is conservative, never exact: a block next to a new stroke may turn
 * out unchanged, and is then redrawn to the same result. The reach is the
 * stroke pass's own bound (strokeReachPx), padded by a pixel for the two
 * programs' separate floating-point evaluation of the same expression. A
 * block's pixels can change only through strokes that reach them, so no
 * changing pixel is ever left out.
 */

//#include hash
//#include lattice

layout(location = 0) out vec4 fragColor;

uniform float uRevealSpawn;
uniform float uPrevSpawn;      // the progress the target already holds; -1 = nothing born
uniform float uSizeByDepth;    // > 0: the depth in-fill's lattice is drawn
uniform float uLayer2;         // > 0: the second sitting is drawn
uniform sampler2D uBirthBase;  // the three lattice tables (artBirth.frag)
uniform sampler2D uBirthFill;
uniform sampler2D uBirthLayer2;

bool layerTouches(sampler2D table, float cellPx, vec2 gridOff, vec4 rect, float reach) {
  ivec2 dim = textureSize(table, 0);
  // A cell's centre is (cell + gridOff + 0.5 + jitter) * cellPx, jitter within
  // +-uJitter/2: the cells whose centre can lie within `reach` of the block.
  vec2 lo = (rect.xy - reach) / cellPx - gridOff - 0.5 - uJitter * 0.5;
  vec2 hi = (rect.zw + reach) / cellPx - gridOff - 0.5 + uJitter * 0.5;
  ivec2 c0 = max(ivec2(floor(lo)) - TABLE_ORIGIN, ivec2(0));
  ivec2 c1 = min(ivec2(ceil(hi)) - TABLE_ORIGIN, dim - 1);
  float reachSq = reach * reach;
  for (int y = c0.y; y <= c1.y; y++) {
    for (int x = c0.x; x <= c1.x; x++) {
      vec3 t = texelFetch(table, ivec2(x, y), 0).rgb;
      if (t.x <= uPrevSpawn || t.x > uRevealSpawn) continue;
      vec2 d = t.yz - clamp(t.yz, rect.xy, rect.zw);
      if (dot(d, d) <= reachSq) return true;
    }
  }
  return false;
}

void main() {
  vec2 block = floor(gl_FragCoord.xy);
  vec4 rect = vec4(block * uCellPx, (block + 1.0) * uCellPx);
  bool dirty = false;
  if (uRevealSpawn > 0.0) {
    float reachBase = strokeReachPx(uCellPx) + 1.0;
    dirty = layerTouches(uBirthBase, uCellPx, vec2(0.0), rect, reachBase);
    if (!dirty && uSizeByDepth > 0.0) {
      // The in-fill: base-size strokes on a lattice at half the spacing.
      dirty = layerTouches(uBirthFill, uCellPx * 0.5, vec2(0.0), rect, reachBase);
    }
    if (!dirty && uLayer2 > 0.0) {
      dirty = layerTouches(uBirthLayer2, uCellPx, vec2(0.5), rect, reachBase);
    }
  }
  fragColor = vec4(dirty ? 1.0 : 0.0, 0.0, 0.0, 1.0);
}
