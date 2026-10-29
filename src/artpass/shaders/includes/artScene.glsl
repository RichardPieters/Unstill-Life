/**
 * artScene.glsl — what the art pass knows about the depicted scene.
 *
 * Depth is read straight from the hardware depth buffer; no world position is
 * reconstructed. Every threshold that touches depth is RELATIVE rather than
 * absolute (see artEdgeJfa.frag).
 *
 * Two inputs:
 *   uGBuffer  R,G = terrain normal x,z (*0.5+0.5) · B = water flag · A = coverage
 *             Cleared to zero, so alpha 0 means "no surface here" — sky.
 *   uDepth    the hardware depth attached to the same pass.
 *
 * The pass needs exactly three things from the scene — depth, a three-way
 * segment, and the surface normal's horizontal part — and this is all of them.
 * Material-id granularity is NOT among them: the lattice never asks which land
 * material a pixel is, only whether it is land.
 */

uniform sampler2D uGBuffer;
uniform sampler2D uDepth;
uniform float uCameraNear;
uniform float uCameraFar;
uniform float uFogNear;
uniform float uFogFar;

/** Terrain coverage: 1 on a painted surface, 0 in the sky. */
float coverAt(vec2 uv) { return texture(uGBuffer, uv).a; }

/** 1 on the water surface, 0 elsewhere. */
float waterAt(vec2 uv) { return texture(uGBuffer, uv).b; }

/** The surface normal's horizontal components. Only x and z are ever used. */
vec2 normalXZAt(vec2 uv) { return texture(uGBuffer, uv).rg * 2.0 - 1.0; }

/**
 * View-space distance along the camera axis, in world units, positive.
 *
 * The standard three.js perspective inverse. Note this is the AXIAL distance
 * (gl_FragCoord.z / gl_FragCoord.w), not the length of the view ray — the two
 * differ by the off-axis cosine. Axial is the right one here because it is
 * exactly what terrain.frag's fog uses, so `depth01` below and the scene's own
 * haze agree by construction rather than by luck.
 *
 * A cleared depth of 1 gives back uCameraFar, so sky is simply the farthest
 * thing in the frame rather than a special case.
 */
float viewZAt(vec2 uv) {
  float d = texture(uDepth, uv).x;
  return -((uCameraNear * uCameraFar) / ((uCameraFar - uCameraNear) * d - uCameraFar));
}

/**
 * 0 at the fog's near plane, 1 at its far plane. Drives stroke size, the aerial
 * spread falloff, and — because it is the same ramp the terrain shader fogs
 * with — how far the segment-solid colours melt into the sky.
 */
float depth01(vec2 uv) {
  return clamp((viewZAt(uv) - uFogNear) / max(uFogFar - uFogNear, 1.0), 0.0, 1.0);
}

/**
 * Distance to the surface under a pixel, or -1 where there is none.
 *
 * The edge detector and the ground gather both need "is there anything here at
 * all" separated from "how far away is it", because a surface against the sky
 * is an occlusion boundary against infinity — the limiting case of a depth
 * jump, not an exception to it.
 */
float surfaceDistAt(vec2 uv) {
  return (coverAt(uv) > 0.5) ? viewZAt(uv) : -1.0;
}
