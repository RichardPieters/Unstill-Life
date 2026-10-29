/**
 * artBirth.frag — one lattice's table of strokes: where each sits and when it
 * arrives.
 *
 * One texel per cell. R is the cell's BIRTH TIME, the reveal progress at which
 * its stroke appears; GB is the stroke's anchor in screen pixels. Drawn once
 * when the strokes are redrawn from scratch, three times over (one table per
 * lattice), at lattice resolution: a few thousand texels where the stroke pass
 * works on every pixel.
 *
 * Why a table. A stroke's arrival depends on the frame's colour and edge field
 * and on a growth field, none of which changes while the reveal plays over its
 * frozen scene. Worked out inside the stroke pass it would be redone for every
 * candidate of every pixel of every frame; as a table it is worked out once per
 * cell, and the stroke pass reads one texel. The same table tells the dirty
 * mask which pixels a stroke arriving this frame can touch (artDirty.frag).
 *
 * The arrival order comes from ONE seed growing outward (artGrowthRelax), not
 * an independent draw per mark. A hash gives every mark its own unrelated draw, so raising the threshold lights up dark or edge
 * pixels everywhere at once, scattered, because nothing ties one mark's arrival
 * to its neighbour's. The baked field instead reaches a point only once it has
 * reached every point between it and the seed, discounted more where the colour
 * changed along the way, so growth stays inside a colour and crosses into a
 * different one only once nothing closer and similar is left. There is exactly
 * one growing region at a time, because the field starts at 1 in one place.
 *
 * Darks and marks near a silhouette are pulled EARLIER, never later, which is
 * what keeps a bias of 0 spanning the same range the field alone would give:
 * the underpainting-then-drawing order a painter works in, layered on top of
 * the growth rather than replacing it.
 */

uniform vec2  uRes;            // the frame, in pixels

//#include hash
//#include format
//#include frame
//#include scene
//#include lattice
//#include orient

in  vec2 vUv;
layout(location = 0) out vec4 fragColor;

uniform float uLayerCellPx;    // this table's lattice: spacing in pixels,
uniform vec2  uGridOff;        // offset in cells
uniform vec2  uSeedOff;        // and the seed offset its hashes are drawn from

uniform sampler2D uBeauty;
uniform float uFlatten;

uniform float uBirthGate;      // 0 = no reveal is playing: every stroke is born
uniform sampler2D uGrowthField;
uniform float uRevealBias;         // 0 = pure scatter, 1 = darks/edges land first
uniform float uRevealGrowthJitter; // 0 = follow the growth field cleanly,
                                   // 1 = an independent per-mark draw instead

// Blocking in: an opening beat in which ONLY marks hard against an occlusion
// edge may spawn, so the silhouettes are drawn before any mass is laid over
// them. The drawing beat is added in front of the growth, never mixed into it.
uniform float uRevealEdgesFirst;  // 0 = no drawing stage, 1 = block in first
uniform float uRevealEdgeBeat;    // fraction of the reveal the drawing takes
uniform float uRevealEdgeMaxDepth; // edges farther than this (depth01) are not drawn first
// The same idea, independently, for the DARKEST marks: a painter's "block in
// the shadow masses" and "block in the silhouette" are two stages, each
// switched and timed on its own.
uniform float uRevealDarksFirst;
uniform float uRevealDarkBeat;

void main() {
  vec2 cell = floor(gl_FragCoord.xy) + vec2(float(TABLE_ORIGIN));
  vec2 hcell = cell + uSeedOff;
  LayerCfg cfg = layerCfg(uLayerCellPx, uLayerCellPx);
  cfg.gridOff = uGridOff;
  vec2 centrePx = strokeCentrePx(cell, hcell, cfg);

  float birth = 0.0;
  if (uBirthGate > 0.5) {
    vec2 anchorUv = clamp(centrePx / uRes, 0.0, 1.0);
    vec3 Csrc = frameLod(uBeauty, anchorUv, uFlatten);
    float smoothField = 1.0 - texture(uGrowthField, anchorUv).a;
    // Own hash salt, distinct from the second sitting's spawnFrac test (51.37),
    // so the two cannot correlate: a mark painted early by one would otherwise
    // be painted early by the other.
    float jitterField = hash1(hcell, 57.31);
    float rnd = mix(smoothField, jitterField, clamp(uRevealGrowthJitter, 0.0, 1.0));
    float luminance = dot(Csrc, vec3(0.2126, 0.7152, 0.0722));
    float edgeDist = nearestEdge(anchorUv).z;
    float reach = uLayerCellPx * uDotScale * uEdgeReach / max(uAspectRatio, 1.0);
    float edgeCloseness = 1.0 - clamp(edgeDist / max(reach, 1.0), 0.0, 1.0);
    // An edge beyond the depth limit is plain terrain: neither drawn in the
    // blocking-in beat nor pulled early by the darks-and-edges bias. Gating only
    // the beat would leave the bias landing all of them together right after it.
    // Applies only while blocking in is on; otherwise the bias is untouched.
    if (uRevealEdgesFirst > 0.5) edgeCloseness *= step(depth01(anchorUv), uRevealEdgeMaxDepth);
    float structureScore = max(1.0 - luminance, edgeCloseness);
    birth = rnd * (1.0 - uRevealBias * structureScore);

    // Marks hard against an edge draw themselves in quickly and in no
    // particular order (the artist is finding the shapes, not painting them),
    // and everything else is pushed past the beat. The band edges are chosen so
    // only marks genuinely ON the silhouette qualify: a wider band fills in as
    // a painted stripe rather than reading as a drawn line.
    if (uRevealEdgesFirst > 0.5) {
      float beat = clamp(uRevealEdgeBeat, 0.001, 0.9);
      float sketch = smoothstep(0.55, 0.95, edgeCloseness);
      float sketchBirth = beat * hash1(hcell, 91.7);
      birth = mix(beat + (1.0 - beat) * birth, sketchBirth, sketch);
    }
    // Its own qualifying mask (darkness, not edge distance), its own beat width
    // and hash salt. Applied AFTER the edges stage, so a mark that is both dark
    // and on an edge goes to whichever beat is enabled; with both on, the darks
    // stage has the final say.
    if (uRevealDarksFirst > 0.5) {
      float beat = clamp(uRevealDarkBeat, 0.001, 0.9);
      float darkMask = smoothstep(0.55, 0.95, 1.0 - luminance);
      float sketchBirth = beat * hash1(hcell, 132.9);
      birth = mix(beat + (1.0 - beat) * birth, sketchBirth, darkMask);
    }
  }
  fragColor = vec4(birth, centrePx, 1.0);
}
