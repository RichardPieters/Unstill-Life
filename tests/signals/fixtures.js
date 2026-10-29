/**
 * fixtures.js — analytic sample surfaces + their INDEPENDENT mathematical
 * ground truth. Used by the signal specs (tests/signals/*.spec.js).
 *
 * A fixture is plain data { kind, params }. The surface height formula per
 * kind lives once, page-side, in probe.js (it's the controlled INPUT, not a
 * signal under test). The ground-truth functions here are the closed-form
 * math of the surface — stated directly, NEVER differenced from the height
 * formula or copied from a shader. That independence is what makes the tests
 * meaningful (a re-implementation of the signal would drift in lockstep).
 */
import { PLANE_SIZE } from '../../src/shared/sceneConfig.js'

export { PLANE_SIZE }

// ─── Tilted plane: h = ax·x + az·z + c ────────────────────────────────────────
// slopeDeg = tilt from horizontal; aziDeg = downhill direction in world XZ
// (0 → downhill toward +x). Ground-truth gradient magnitude is tan(slope).
export function tiltedPlane(slopeDeg, aziDeg = 0, c = 0) {
  const t = (slopeDeg * Math.PI) / 180
  const a = (aziDeg * Math.PI) / 180
  const g = Math.tan(t)
  return { kind: 'plane', params: { ax: g * Math.cos(a), az: g * Math.sin(a), c } }
}

// True upward unit normal of h = ax·x + az·z + c is normalize(-ax, 1, -az).
export function planeNormal({ ax, az }) {
  const n = [-ax, 1, -az]
  const L = Math.hypot(n[0], n[1], n[2])
  return [n[0] / L, n[1] / L, n[2] / L]
}

// flatness = normal.y.
export function planeFlatness(params) {
  return planeNormal(params)[1]
}

// aspect = dot( normalize(horizontal normal), normalize(sunAzimuth) ), where
// the horizontal normal is (−ax, −az). Independent of the shader's aspect().
export function planeAspect({ ax, az }, sunAz) {
  const nH = [-ax, -az]
  const lH = Math.hypot(nH[0], nH[1])
  if (lH < 1e-6) return 0
  const lS = Math.hypot(sunAz[0], sunAz[1])
  return (nH[0] / lH) * (sunAz[0] / lS) + (nH[1] / lH) * (sunAz[1] / lS)
}

// N·L = dot(normal, normalize(sunAz.x, sunElevation, sunAz.z)).
export function planeNdotL(params, sunAz, sunElevation) {
  const n = planeNormal(params)
  const l = [sunAz[0], sunElevation, sunAz[1]]
  const L = Math.hypot(l[0], l[1], l[2])
  return n[0] * (l[0] / L) + n[1] * (l[1] / L) + n[2] * (l[2] / L)
}

// Height at a world point (for the near-exact height spec).
export function planeHeight({ ax, az, c }, x, z) {
  return ax * x + az * z + c
}

// ─── Radial paraboloid: h = k·(x²+z²) + c ─────────────────────────────────────
// Constant curvature (∇²h = 4k everywhere), so on it concaveSmall is a single
// position-independent value — ideal for the radius-independence property and
// concavity-sign tests. k>0 = bowl/basin (concave up), k<0 = dome/hill.
export function paraboloid(k, c = 0) {
  return { kind: 'paraboloid', params: { k, c } }
}

// ─── Gaussian dome: h = amp·exp(−r²/2σ²) + c ──────────────────────────────────
// Flat apex, flanks of every facing → wide spread of normals/N·L. For the
// shading tonal-spread test.
export function gaussianDome(amp, sig, c = 0) {
  return { kind: 'gaussian', params: { amp, sig, c } }
}

// Data-map texel size in world units (PLANE_SIZE / map resolution).
export const MAP_SIZE = 512
export const TEXEL_WORLD = PLANE_SIZE / MAP_SIZE
