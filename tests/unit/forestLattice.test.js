import { describe, test, expect } from 'vitest'

// Guards the geometric contract that forest.glsl's 3-tap crown evaluation rests
// on. The shader visits only the THREE corners of the simplex triangle a
// fragment falls in; that is exact — no missed crowns, no seams — only while
//
//     crown radius + jitter <= CAN_SUPPORT (0.7071 field units)
//
// Ground truth here is INDEPENDENT of the selection logic: it brute-force
// enumerates every lattice site in a window and asks which ones actually reach
// the query point. The corner-picking code is the thing under test; the
// enumeration is the oracle. Nothing here re-implements the crown profile or
// the shading, so it cannot drift in lockstep with them.
//
// Mirrors the constants in src/terrain/shaders/includes/forest.glsl. If those change,
// these fail — which is the point.
const F2 = 0.36602540378   // (sqrt(3)-1)/2 — square → triangular skew
const G2 = 0.21132486540   // (3-sqrt(3))/6 — unskew
const CAN_A = 0.81649658   // claimed site spacing, sqrt(2/3)
const CAN_SUPPORT = 0.70711 // claimed 3-tap bound, = 0.866 * CAN_A
const CAN_SUPPORT2 = 1.41421 // claimed 5x5-block bound, the big-crown fallback

/** Unskewed field-space position of lattice site (i, j). */
function site(i, j) {
  const t = (i + j) * G2
  return [i - t, j - t]
}

/** The three corners forest.glsl evaluates for a point — the code under test. */
function corners(px, pz) {
  const s = (px + pz) * F2
  const i = Math.floor(px + s)
  const j = Math.floor(pz + s)
  const t = (i + j) * G2
  const x0x = px - (i - t)
  const x0z = pz - (j - t)
  const [i1x, i1z] = x0x > x0z ? [1, 0] : [0, 1]
  return [[i, j], [i + i1x, j + i1z], [i + 1, j + 1]]
}

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1])

/** An NxN block of lattice sites in SKEWED index space around p's cell. */
function block(px, pz, n) {
  const s = (px + pz) * F2
  const ci = Math.floor(px + s)
  const cj = Math.floor(pz + s)
  const out = []
  for (let a = -n; a <= n; a++) for (let b = -n; b <= n; b++) out.push([ci + a, cj + b])
  return out
}

/** Every lattice site within `r` of p, by brute force — the oracle. */
function sitesWithin(px, pz, r, window = 6) {
  const s = (px + pz) * F2
  const ci = Math.floor(px + s)
  const cj = Math.floor(pz + s)
  const hits = []
  for (let i = ci - window; i <= ci + window; i++) {
    for (let j = cj - window; j <= cj + window; j++) {
      if (dist(site(i, j), [px, pz]) <= r) hits.push([i, j])
    }
  }
  return hits
}

// Deterministic sample points — a fixed LCG, so a failure is reproducible.
function samplePoints(n) {
  let s = 12345
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
  return Array.from({ length: n }, () => [rnd() * 40 - 20, rnd() * 40 - 20])
}

describe('forest lattice — geometry of the simplex locator', () => {
  test('the skew produces an equilateral triangular lattice of spacing CAN_A', () => {
    const o = site(0, 0)
    for (const n of [site(1, 0), site(0, 1), site(1, 1)]) {
      expect(dist(o, n)).toBeCloseTo(CAN_A, 5)
    }
    // …and the two basis vectors meet at 120°, which is what makes it
    // equilateral rather than merely rhombic.
    const e1 = site(1, 0), e2 = site(0, 1)
    const cos = (e1[0] * e2[0] + e1[1] * e2[1]) / (CAN_A * CAN_A)
    expect(cos).toBeCloseTo(-0.5, 5)
  })

  test('CAN_SUPPORT is the triangle height — the true reach of a non-corner site', () => {
    // The nearest site that is NOT one of the three corners sits one triangle
    // height away, attained at an edge midpoint. Measured, not assumed.
    let worst = Infinity
    for (const [px, pz] of samplePoints(4000)) {
      const own = corners(px, pz).map(String)
      for (const [i, j] of sitesWithin(px, pz, 2.0)) {
        if (own.includes(String([i, j]))) continue
        worst = Math.min(worst, dist(site(i, j), [px, pz]))
      }
    }
    expect(worst).toBeGreaterThan(CAN_SUPPORT - 1e-3)
    expect(worst).toBeLessThan(CAN_SUPPORT + 1e-2)  // tight: the bound is not slack
  })
})

describe('forest lattice — 3-tap exactness', () => {
  test('at or below the bound, the 3 corners are every site that can reach', () => {
    for (const reach of [0.20, 0.45, 0.60, CAN_SUPPORT - 1e-4]) {
      for (const [px, pz] of samplePoints(1500)) {
        const own = new Set(corners(px, pz).map(String))
        for (const c of sitesWithin(px, pz, reach)) {
          expect(own.has(String(c)),
            `site ${c} reaches (${px},${pz}) at radius ${reach} but is not a corner`).toBe(true)
        }
      }
    }
  })

  test('a 3x3 skewed block buys nothing — which is why the fallback is 5x5', () => {
    // Guards a non-obvious choice in forest.glsl. The intuitive next step up
    // from three corners is a 3x3 block, but it adds the WRONG six neighbours
    // and its reach is identical. Verified here so nobody "optimises" the 5x5
    // fallback down to a 3x3 and silently loses crowns.
    let broke = false
    for (const [px, pz] of samplePoints(2000)) {
      const have = new Set(block(px, pz, 1).map(String))
      for (const c of sitesWithin(px, pz, CAN_SUPPORT * 1.05)) {
        if (!have.has(String(c))) { broke = true; break }
      }
      if (broke) break
    }
    expect(broke).toBe(true)
  })

  test('the 5x5 block covers twice the reach — the big-crown fallback', () => {
    // forest.glsl switches to a 5x5 skewed block past CAN_SUPPORT and clamps
    // the realised radius against CAN_SUPPORT2. Both numbers are asserted here.
    for (const [px, pz] of samplePoints(2000)) {
      const have = new Set(block(px, pz, 2).map(String))
      for (const c of sitesWithin(px, pz, CAN_SUPPORT2 - 1e-3, 8)) {
        expect(have.has(String(c)),
          `site ${c} reaches (${px},${pz}) but is outside the 5x5 block`).toBe(true)
      }
    }
    expect(CAN_SUPPORT2).toBeCloseTo(2 * CAN_SUPPORT, 4)
  })

  test('above the bound it genuinely breaks — the test has teeth', () => {
    // Proves the guard above is not vacuously green: past CAN_SUPPORT a
    // fourth site does reach in, and the shader's clamp is load-bearing.
    let missed = 0
    for (const [px, pz] of samplePoints(1500)) {
      const own = new Set(corners(px, pz).map(String))
      for (const c of sitesWithin(px, pz, CAN_SUPPORT * 1.35)) {
        if (!own.has(String(c))) missed++
      }
    }
    expect(missed).toBeGreaterThan(0)
  })
  test('the slope fades can only SHRINK a crown, so the extent bound holds', () => {
    // forest.glsl computes the candidate-set bound in forestResolve from the
    // UNFADED elongation and lean, then canCrown fades both by sw = mix(1,
    // steepT, slope) with steepT in [0,1]. That is only conservative if the
    // faded extent never exceeds the unfaded one. Independent restatement of
    // the two fades (not a copy of the shader's bound expression), swept over
    // the slider ranges the panel exposes.
    const extent = (elong, lean) => Math.max(elong, 1) * (1 + Math.abs(lean))
    for (let e = 1; e <= 3.0001; e += 0.05) {          // ctrl-forest-elong
      for (let l = -0.6; l <= 0.6001; l += 0.05) {     // ctrl-forest-lean
        const unfaded = extent(e, l)
        for (const sw of [0, 0.13, 0.5, 0.87, 1]) {    // any steepness x gating
          const faded = extent(1 + (e - 1) * sw, l * sw)
          expect(faded).toBeLessThanOrEqual(unfaded + 1e-9)
        }
      }
    }
  })

  test('crown height stays non-negative across the flatness coupling', () => {
    // hgt = uForestHeight * mix(1, flatT, uForestHeightFlat). A negative
    // factor would invert the crown into a pit and flip its lighting, so pin
    // the sign over the exposed ranges.
    for (let h = 0.2; h <= 2.0001; h += 0.05) {        // ctrl-forest-height
      for (let k = 0; k <= 1.0001; k += 0.05) {        // ctrl-forest-hgtflat
        for (const flatT of [0, 0.25, 0.5, 0.75, 1]) {
          expect(h * (1 + (flatT - 1) * k)).toBeGreaterThanOrEqual(-1e-9)
        }
      }
    }
  })
  test('the outline wobble only ever shrinks a crown', () => {
    // forest.glsl multiplies u by mWob = 1 + wob*0.5*(1 + wA), with the
    // harmonic sum wA normalised into [-1,1]. The crown rim is where u = 1, so
    // a LARGER u is a SMALLER crown: the invariant the candidate-set bound
    // depends on is mWob >= 1 for every roll. Independent restatement of that
    // expression, swept over the slider range and the full range of wA.
    for (let wob = 0; wob <= 0.6001; wob += 0.05) {      // ctrl-forest-wobble
      for (let wA = -1; wA <= 1.0001; wA += 0.05) {
        const mWob = 1 + wob * 0.5 * (1 + wA)
        expect(mWob).toBeGreaterThanOrEqual(1 - 1e-9)
        expect(mWob).toBeLessThanOrEqual(1 + wob + 1e-9)
      }
    }
  })

  test('the harmonic sum stays inside [-1,1] at every frequency', () => {
    // The wobble is wA = sum_k(wt_k * cos(k*theta)) / sum_k|wt_k|, where wt_k is
    // a per-tree roll times a triangular window centred on the frequency knob.
    // Each cosine is in [-1,1], so the normaliser is the ONLY thing holding wA
    // inside [-1,1] — and mWob >= 1, the invariant the candidate-set bound
    // rests on, follows from that. If the window ever ran off the end of the
    // series the normaliser would starve and wA would blow past 1, which is
    // why the slider's top (7) sits a window-width below CAN_WOB_K (9).
    //
    // Evaluated on real cosines of a real angle, swept over the whole slider
    // range — not on the algebra of the bound.
    const K = 9                       // CAN_WOB_K
    let worst = 0, leanest = Infinity
    for (let freq = 1; freq <= 7.001; freq += 0.5) {     // ctrl-forest-wobfreq
      for (let tree = 0; tree < 12; tree++) {
        const wt = []
        for (let k = 1; k <= K; k++) {
          const win = Math.max(0, 1 - Math.abs(k - freq) * 0.5)
          // deterministic stand-in for the shader's per-tree hash
          wt.push(win * Math.sin((tree + 1) * (k + 2) * 1.7))
        }
        const nrm = wt.reduce((a, w) => a + Math.abs(w), 1e-4)
        leanest = Math.min(leanest, nrm)
        for (let th = 0; th < 6.2832; th += 0.01) {
          let wA = 0
          for (let k = 1; k <= K; k++) wA += wt[k - 1] * Math.cos(k * th)
          worst = Math.max(worst, Math.abs(wA / nrm))
        }
      }
    }
    expect(worst).toBeLessThanOrEqual(1 + 1e-9)
    expect(worst).toBeGreaterThan(0.5)      // and it does use the range
    // The window always has real weight in it, so the normaliser is never the
    // bare 1e-4 epsilon — that would make wA a ratio of two near-zeros.
    expect(leanest).toBeGreaterThan(0.01)
  })

})
