/**
 * artOrient.glsl — the stroke orientation field.
 *
 * Direction is assigned per segment and then overridden near an edge, so
 * strokes turn to run along it. That override is what makes a dotted tree line
 * read as a tree line rather than dissolving into the sky behind it.
 *
 * "Edge" means an OCCLUSION boundary — a depth discontinuity — not a material
 * boundary. See artEdgeJfa.frag for why: the terrain's zonation bands are
 * altitude isolines, so aligning strokes to those draws a topographic map
 * rather than a painting. The boundary set arrives as a distance field
 * (uEdgeField) built by the jump-flood prepass, which is what lets the override
 * reach as far as the stroke does rather than only where the stroke's anchor
 * happens to land within a pixel or two of the edge.
 *
 * Requires artScene.glsl (coverAt / waterAt / normalXZAt), artHash.glsl (hash1)
 * and artLattice.glsl (uCellPx, uDotScale, uAspectRatio) spliced before it, and
 * the including shader to declare uRes.
 */

uniform sampler2D uEdgeField;  // nearest-edge tangent + distance, from the JFA
uniform float uEdgeAlign;      // how far the edge override wins
uniform float uEdgeReach;      // its reach, in stroke radii
uniform float uOrientMode;     // 0 = every stroke horizontal, 1 = the field

const float EDGE_DIST_MAX = 4095.0;

/**
 * The occlusion edge nearest a point.
 *
 * Returns the edge's TANGENT as a double-angle vector in .xy and the distance
 * to it in .z. Both come from one fetch of the prepass field: the tangent is
 * fitted there to the neighbouring seeds rather than taken from this pixel's
 * own offset, which at short range snaps to a handful of integer directions and
 * is undefined outright on the edge itself.
 *
 * The field is built at a fraction of full resolution, so the distance it
 * stores is in ITS pixels. uEdgeFieldScale converts back to screen pixels —
 * without it, halving the prepass resolution would silently halve the reach of
 * every alignment.
 */
uniform float uEdgeFieldScale;

vec3 nearestEdge(vec2 uv) {
  vec4 t = texture(uEdgeField, uv);
  vec2 dbl = t.xy * 2.0 - 1.0;
  float d = (t.z * 255.0 * 256.0 + t.w * 255.0) / 65535.0 * EDGE_DIST_MAX;
  return vec3(dbl, d / max(uEdgeFieldScale, 1e-3));
}

// ─── orientation ─────────────────────────────────────────────────────────────
// Every term is evaluated at ONE uv — the stroke's anchor, never the fragment
// being shaded. A per-fragment tangent would give each pixel of a stroke a
// different rotation frame, and the shape test downstream assumes a single
// angle for the whole stroke: it would stop being a mark and become a smear
// whose shape varies within itself.
float orientationAt(vec2 uv) {
  if (uOrientMode < 0.5) return 0.0;

  float water = waterAt(uv);
  float cover = coverAt(uv);

  float ang;
  if (water > 0.5) {
    ang = 0.0;                                  // water: horizontal dashes
  } else if (cover < 0.5) {
    // Sky: a criss-cross pair, chosen per cell rather than smoothly varying.
    ang = (hash1(floor(uv * uRes / uCellPx), 3.3) < 0.5) ? 0.6 : -0.6;
  } else {
    // Terrain: along the contour, i.e. perpendicular to the surface gradient.
    // The normal's horizontal component points downhill, so its perpendicular
    // in screen space follows the slope's level line.
    vec2 n = normalXZAt(uv);
    ang = atan(n.x, -n.y) + 1.5707963;          // .y here is the normal's z
  }

  if (uEdgeAlign <= 0.0) return ang;

  vec3 e = nearestEdge(uv);

  // How far the override reaches. A stroke should align when it OVERLAPS the
  // edge, so the reach is the stroke's own radius — scaled by uEdgeReach, since
  // "overlaps" and "looks aligned" are not quite the same band and the right
  // multiple is a matter of taste rather than of geometry.
  //
  // Elongation divides the minor semi-axis by uAspectRatio, and that axis is
  // the one that has to span the gap: a long thin stroke lying along an edge
  // reaches it from much closer than its length suggests. Using the nominal
  // radius here would over-reach by up to 4x at the top of the slider.
  float reach = uCellPx * uDotScale * uEdgeReach / max(uAspectRatio, 1.0);
  if (e.z > reach) return ang;
  if (dot(e.xy, e.xy) < 1e-8) return ang;        // no edge direction here

  // Falloff across the band. smoothstep from the far end would leave the
  // strokes that merely graze the edge — the majority, since area grows as d^2
  // — with almost no alignment at all, so the curve is deliberately flat near
  // the edge and only lets go at the rim.
  float w = 1.0 - smoothstep(0.55, 1.0, e.z / reach);

  // Blend as a double angle so opposing directions reinforce rather than
  // cancel: an orientation is a line, not an arrow, and 0 and pi are the same
  // stroke.
  vec2 a = vec2(cos(2.0 * ang), sin(2.0 * ang));
  vec2 b = normalize(e.xy);                      // already a double angle
  vec2 m = mix(a, b, clamp(w, 0.0, 1.0) * uEdgeAlign);
  return 0.5 * atan(m.y, m.x);
}
