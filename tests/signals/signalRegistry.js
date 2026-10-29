/**
 * signalRegistry.js — single row per GLSL signal under test, mirroring the
 * paramRegistry pattern. Adding a signal = one row here + a ground-truth fn in
 * fixtures.js + a case in the relevant spec. The debugViewId is the selector
 * the raw-probe path (uProbeRaw) reads through (see terrain.frag).
 *
 * tier:
 *   exact       analytic value, tight eps (normal-family on planes)
 *   near-exact  analytic value, slope-scaled eps (height — smoothDataUV residue)
 *   property    a relation, not a value (radius-independence)
 *   ordering    rank/sign only (hollowness, classify zonation, shading spread)
 *   invariant   range / monotonic response (moisture, erosion — no analytic truth)
 */
export const SIGNALS = [
  { id: 'height',   debugViewId: 1,  scalar: true,  tier: 'near-exact' },
  { id: 'flatness', debugViewId: 2,  scalar: true,  tier: 'exact' },
  { id: 'aspect',   debugViewId: 3,  scalar: true,  tier: 'exact' },
  { id: 'normal',   debugViewId: 11, scalar: false, tier: 'exact' },
  { id: 'NdotL',        debugViewId: 12, scalar: true,  tier: 'exact' },
  { id: 'concaveSmall', debugViewId: 4,  scalar: true,  tier: 'property' },
  { id: 'concaveLarge', debugViewId: 5,  scalar: true,  tier: 'ordering' },
  { id: 'hollowness',   debugViewId: 9,  scalar: true,  tier: 'ordering' },
  { id: 'classify',     debugViewId: 10, scalar: true,  tier: 'ordering' },
  { id: 'moisture',     debugViewId: 6,  scalar: true,  tier: 'invariant' },
  // ridge(7)/erosion(8)/bedrock(14): read RT_A channels .g/.b/.a, which the
  // fixture path leaves at 0 (setFixtureHeightfield writes only .r). No fixture
  // ground truth is possible for them. bedrock(14) is covered instead by
  // tests/visual/mantle.spec.js, which asserts its defining property — bedrock
  // wins on high ground — against the LIVE data-map pass.
]

export const byId = Object.fromEntries(SIGNALS.map(s => [s.id, s]))
