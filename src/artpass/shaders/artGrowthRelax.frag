/**
 * artGrowthRelax.frag — the reveal's growth field: SEED it (`uGrowthSeeding` 1, drawn
 * once), then relax it (`uGrowthSeeding` 0, once per halving step, exactly like the edge
 * field's jump flood — same technique, a different quantity being propagated).
 *
 * SEED. The entrance animation grows outward from ONE point rather than
 * appearing as scattered independent dabs: a single seed pixel starts at full
 * "reached" score, everything else at zero, and the relax step propagates that
 * score outward, discounted more where the colour changes than where it stays
 * similar — so the front travels quickly across a flat sky or a calm lake and
 * visibly hesitates at a shoreline or a tree line before crossing it. The seed
 * pass also bakes in the one piece of data the relax step needs and cannot get
 * any other way: each pixel's own colour, read once and then carried through
 * every relax pass UNCHANGED (colour is a fixed property of a point; only the
 * score propagates). Built ONCE per playReveal(), not every frame.
 *
 * RELAX.
 * Each pixel keeps a SCORE in (0, 1]: how strongly the growth has "reached" it
 * from the one seed pixel. A hop of geometric distance d to a neighbour whose
 * colour differs by cdiff costs
 *
 *     hopCost = (d / reach) * (1 + colourWeight * cdiff)
 *
 * and the score that arrives via that hop is the neighbour's own score decayed
 * by exp(-hopCost). Taking the MAX of every reachable neighbour's discounted
 * score, ping-ponged across all the halving steps, converges toward the same
 * quantity a true colour-weighted shortest-path search would give — no lower,
 * because every path is considered as a candidate, never forced.
 *
 * That framing is what keeps this bounded in (0, 1] with no separate
 * normalisation step: exp(-hopCost) is already there, unlike a raw
 * accumulated-cost scheme which needs an arbitrary constant to squash an
 * unbounded number back into a usable range. artPaint.frag reads 1 - score as
 * the mark's birth time — 0 at the seed, rising with distance and with how
 * much colour the front had to cross to get there.
 *
 * Approximate, in the same sense and for the same reason the edge field's jump
 * flood is approximate: a handful of ping-pong passes at geometrically
 * shrinking steps does not examine every path, only a fixed set of candidate
 * hops. It is not exact geodesic relaxation. It does not need to be — the
 * result only has to look like paint spreading, not withstand a pathfinding
 * benchmark.
 */

//#include frame

in  vec2 vUv;
out vec4 fragColor;

uniform sampler2D uPrev;
uniform sampler2D uBeauty;       // the frame, read by the seed pass
uniform float uGrowthSeeding;             // 1 = seed, 0 = relax
uniform vec2  uSeedPx;           // the one point growth starts from, in THIS prepass's pixels
uniform vec2  uRes;           // this prepass's own resolution
uniform float uStep;              // offset for this pass, in pixels
uniform float uRevealGrowthReach;    // screen-cost the front travels before fading
uniform float uRevealColourWeight;   // 0 = ignore colour, grow as a plain circle

void main() {
  if (uGrowthSeeding > 0.5) {
    vec3 colour = frameAt(uBeauty, vUv);
    // A small radius rather than an exact equality test: floats rarely land on
    // one another exactly, and a single unreachable seed pixel means the entire
    // field stays at zero forever.
    float score = (distance(vUv * uRes, uSeedPx) < 1.5) ? 1.0 : 0.0;
    fragColor = vec4(colour, score);
    return;
  }

  vec4 self = texture(uPrev, vUv);
  vec3 myColour = self.rgb;       // fixed at the seed pass, never touched again
  float best = self.a;

  float reach = max(uRevealGrowthReach, 1.0);

  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      if (dx == 0 && dy == 0) continue;
      vec2 offsetPx = vec2(float(dx), float(dy)) * uStep;
      vec2 uv = vUv + offsetPx / uRes;
      if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) continue;

      vec4 nb = texture(uPrev, uv);
      float d = length(offsetPx);
      float cdiff = length(myColour - nb.rgb);
      float hopCost = (d / reach) * (1.0 + uRevealColourWeight * cdiff);
      float candidate = nb.a * exp(-hopCost);
      best = max(best, candidate);
    }
  }

  fragColor = vec4(myColour, best);
}
