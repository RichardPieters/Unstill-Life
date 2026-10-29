import { describe, it, expect } from 'vitest'
import {
  ART_PARAMS, ART_GROUPS, ART_COLORS, ART_GROUND_MODES, ART_DEBUG_VIEWS,
  ART_REVEAL_TOGGLES, artDefaults,
} from '../../src/artpass/artPassParams.js'
import { coverageFloor } from '../../src/artpass/artPassMath.js'
import { TOOLTIPS } from '../../src/panel/tooltips.js'

/**
 * artPassParams.js is the single source of truth for the art pass: the panel
 * generates its controls from it, the pass builds its uniforms from it, and the
 * snapshot round-trips through it. The generic row checks (shape, encode,
 * unique ids and keys, range, step grid, tooltip, uniform declared in an art
 * shader) are paramRows.test.js's; these are the art pass's own.
 *
 * Structural checks. Nothing here asserts a tuned VALUE; those change
 * legitimately and a test on them would go red on every retune and be deleted.
 */
describe('art pass parameter registry', () => {
  it('puts every row in a group the panel renders', () => {
    const groups = new Set(ART_GROUPS.map(g => g.id))
    for (const p of [...ART_PARAMS, ...ART_REVEAL_TOGGLES].filter(p => p.kind !== 'hidden')) {
      expect(groups.has(p.group), `${p.id} is in unknown group "${p.group}"`).toBe(true)
    }
  })

  // A row with no uniform is held by artPass.params and reaches the picture
  // only through something the pass does with it (a derived uniform, the LUT,
  // the prepass size, a JS-side curve). Listing them here means adding one
  // without writing that handling shows up as a failing test rather than as a
  // dead slider.
  it('accounts for every row that is not a straight uniform passthrough', () => {
    const derived = ART_PARAMS.filter(p => !p.uniform).map(p => p.key).sort()
    expect(derived).toEqual([
      'beta', 'cell', 'cull', 'edgeFit', 'exitDuration', 'exitResumeEase', 'groundBlur', 'heightScale',
      'keepEdges', 'normalRadius', 'paintScale', 'prepassScale', 'revealDuration', 'revealEvenPace',
      'revealGroundBeat', 'revealGrowthReach', 'revealPrimeDuration', 'revealPrimeLighten', 'weaveScale',
    ])
  })

  it('exports defaults for every row including the colours and toggles', () => {
    const d = artDefaults()
    for (const p of ART_PARAMS) expect(d[p.key]).toBe(p.value)
    for (const c of ART_COLORS) expect(d[c.key]).toMatch(/^#[0-9a-f]{6}$/i)
    for (const t of ART_REVEAL_TOGGLES) expect(d[t.key]).toBe(t.value)
  })

  // A toggle is written as 1/0 only where it names a uniform; RevealDirector
  // reads the others from artPass.params. The encode has to say which.
  it('encodes a toggle as 1/0 exactly when it reaches a shader', () => {
    for (const t of ART_REVEAL_TOGGLES) expect(t.encode, t.id).toBe(t.uniform ? 'float01' : 'bool')
  })
})

/**
 * The coverage condition. Dot fill and placement jitter are not independent:
 * raising jitter without raising dot fill opens holes in the lattice, and a
 * hole reads as a flat patch of bare ground rather than as an obvious bug.
 * That coupling is invisible when the two sliders are dragged separately —
 * see coverageFloor's own tests (artPassMath.test.js) for the general rule.
 *
 * The shipped defaults sit BELOW the floor — jitter 0.56 wants dotScale >= ~1.10,
 * and dotScale is 0.77 — which is a deliberate look (a sparser lattice that
 * lets bare ground show through), not an oversight, so this only pins the
 * known gap rather than asserting a "no holes" premise. If this default
 * combination changes again, update the expected gap rather than restoring the
 * old assertion outright — check first whether the new values are meant to
 * clear the floor or not.
 */
describe('the shipped defaults\' known coverage gap', () => {
  it('dotScale sits below the jitter-implied floor by a known, intentional margin', () => {
    const d = artDefaults()
    const floor = coverageFloor(d.jitter)
    expect(d.dotScale).toBeLessThan(floor)
    expect(floor - d.dotScale).toBeCloseTo(0.3330865786510142, 6)
  })
})

/**
 * The diagnostic views. "no orientation" is not a diagnostic — it is the
 * painting with the direction field switched off — so it must stay LIT while
 * every genuine diagnostic stays unlit. The sandbox conflated the two into one
 * uniform, which is how a diagnostic ended up shaded and stopped being
 * measurable by a probe reading pixels back off the canvas.
 */
describe('art pass debug views', () => {
  it('numbers the views contiguously from zero', () => {
    expect(ART_DEBUG_VIEWS.map(v => v.value)).toEqual(ART_DEBUG_VIEWS.map((_, i) => i))
  })

  it('leaves the painting and the no-orientation view unshaded by uDebugView', () => {
    expect(ART_DEBUG_VIEWS[0]).toMatchObject({ shader: 0, orient: 1 })
    expect(ART_DEBUG_VIEWS[1]).toMatchObject({ shader: 0, orient: 0 })
  })

  it('gives every genuine diagnostic a distinct shader branch', () => {
    const diagnostics = ART_DEBUG_VIEWS.filter(v => v.shader > 0).map(v => v.shader)
    expect(new Set(diagnostics).size).toBe(diagnostics.length)
  })

  it('numbers the ground modes to match the shader dispatch', () => {
    expect(ART_GROUND_MODES.map(m => m.value)).toEqual([0, 1, 2, 3])
  })
})

/**
 * The art pass's generated controls that are not rows (paramRows.test.js
 * covers the rows' tooltips). tests/visual/tooltips.spec.js fails the build for
 * a control inside #debug with no title, but it needs a browser; this catches
 * the same omission in the unit run.
 */
describe('art pass tooltips', () => {
  const selectors = new Set(TOOLTIPS.map(t => t.selector))

  for (const m of ART_GROUND_MODES) {
    it(`ground mode ${m.label} has a tooltip`, () =>
      expect(selectors.has(`input[name=art-ground][value='${m.value}']`)).toBe(true))
  }
  for (const v of ART_DEBUG_VIEWS) {
    it(`view ${v.label} has a tooltip`, () =>
      expect(selectors.has(`input[name=art-view][value='${v.value}']`)).toBe(true))
  }
  it('covers the enable toggle', () => expect(selectors.has('#tog-artpass')).toBe(true))
})
