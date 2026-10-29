import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { ArtPass } from '../../src/artpass/artPass.js'
import { ArtGBuffer } from '../../src/artpass/artGBuffer.js'
import { ART_ROWS, ART_REVEAL_TOGGLES, ART_DEBUG_VIEWS } from '../../src/artpass/artPassParams.js'
import { reliefScale, sigmaForMipLevel, prepassFraction, texelScale, MIN_CELL_PX } from '../../src/artpass/artPassMath.js'
import { Terrain } from '../../src/terrain/terrain.js'
import { Water } from '../../src/water/water.js'
import { createSceneUniforms } from '../../src/shared/sceneUniforms.js'
import { rawRgbHex } from '../../src/shared/uniformValue.js'
import { removedNameHits } from './sourceScan.js'

/**
 * artPass.params (artPass.js over artPassParams.js's rows): what a write of
 * each key re-does, the derived uniforms, the change guard and the snapshot
 * shape. The pass builds THREE materials and a CPU lookup only; no GL context
 * is needed.
 */

function make() {
  const scene = createSceneUniforms()
  const gbuffer = new ArtGBuffer(new Terrain(new EventTarget(), scene), new Water(new EventTarget(), scene))
  return new ArtPass(gbuffer, new THREE.PerspectiveCamera(), { sceneUniforms: scene })
}

// What a change of each key re-did before the accessor (setParam, setColor,
// setToggle, setGroundMode, setDebugView), written out here independently of
// the rows: every write thawed the held picture except an exit slider's; the
// ones only the ground and the canvas surface read repainted it but left the
// strokes standing; beta and cull rebuilt the pigment lookup; prepassScale
// dropped the sized targets.
const EXIT_SLIDERS = ['exitDuration', 'exitThreshold', 'exitGroundBeat', 'exitJitter', 'exitSoftness',
  'exitSweep', 'exitResumeEase']
const GROUND_ONLY = ['weave', 'weaveScale', 'groundBlur', 'keepEdges', 'segFog',
  'groundColor', 'colSky', 'colLand', 'colWater', 'groundMode']
const FINISH_ONLY = ['weaveDepth', 'normalRadius', 'lightAz', 'lightEl', 'ambient', 'diffuse',
  'specular', 'specPower', 'crevice', 'highKey', 'heightScale']
const LUT = ['beta', 'cull']
const RESIZE = ['prepassScale']
const expectedEffects = key => [
  ...(EXIT_SLIDERS.includes(key) || FINISH_ONLY.includes(key) ? [] : [GROUND_ONLY.includes(key) ? 'compose' : 'thaw']),
  ...(LUT.includes(key) ? ['lut'] : []),
  ...(RESIZE.includes(key) ? ['resize'] : []),
]

// The values the pre-accessor branches wrote into the uniforms that are not
// one row's (its heightScale/cell, groundBlur/prepassScale, keepEdges/ground
// mode and debug-view branches).
function expectedDerived(get) {
  const view = ART_DEBUG_VIEWS.find(v => v.value === get('debugView')) || ART_DEBUG_VIEWS[0]
  return {
    uHeightScale:  get('heightScale') * reliefScale(get('cell')),
    uCellPx:       Math.max(get('cell') * get('paintScale'), MIN_CELL_PX),
    uWeaveScale:   get('weaveScale') * get('paintScale'),
    uNormalRadius: get('normalRadius') * get('paintScale'),
    uFitRadius:    get('edgeFit') * texelScale(get('prepassScale'), get('paintScale')),
    uRevealGrowthReach: get('revealGrowthReach') * texelScale(get('prepassScale'), get('paintScale')),
    uGroundSigma:  sigmaForMipLevel(get('groundBlur')) * get('paintScale')
      * prepassFraction(get('prepassScale'), get('paintScale')),
    uRespectEdges: get('groundMode') === 1 ? get('keepEdges') : 0,
    uDebugView:    view.shader,
    uOrientMode:   view.orient,
    uDebug:        view.shader > 0 ? 1 : 0,
  }
}

const uniform = (pass, name) => pass.uniformValue(name)
const derivedNow = pass => Object.fromEntries(
  Object.keys(expectedDerived(() => 0)).map(n => [n, uniform(pass, n)]))
const expectDerived = (pass, why) => {
  const want = expectedDerived(k => pass.params.get(k))
  for (const [n, v] of Object.entries(derivedNow(pass))) expect(v, `${why}: ${n}`).toBeCloseTo(want[n], 12)
}

/** A value for row `r` that differs from what it holds. */
function another(pass, r) {
  const cur = pass.params.get(r.key)
  if (r.encode === 'bool' || r.encode === 'float01') return !cur
  if (r.encode === 'rawRgb') return cur === '#123456' ? '#654321' : '#123456'
  if (r.key === 'groundMode') return cur === 1 ? 3 : 1
  if (r.key === 'debugView') return cur === 0 ? 4 : 0
  if (r.key === 'paintScale') return cur === 1 ? 0.5 : 1
  return cur === r.max ? r.min : r.max
}

/** A pass that records what each param write re-does. */
function watched() {
  const pass = make()
  let effects = []
  const thaw = pass._thaw.bind(pass)
  const thawCompose = pass._thawCompose.bind(pass)
  const lut = pass._rebuildLut.bind(pass)
  let inThaw = false
  pass._thaw = () => { effects.push('thaw'); inThaw = true; thaw(); inThaw = false }
  pass._thawCompose = () => { if (!inThaw) effects.push('compose'); thawCompose() }
  pass._rebuildLut = () => { effects.push('lut'); lut() }
  const take = () => {
    const out = [...effects]
    if (pass._sizedFor === null) out.push('resize')
    effects = []
    pass._sizedFor = 'sized'
    return out
  }
  take()
  return { pass, take }
}

describe('artPass.params', () => {
  it('holds every row at its default after construction', () => {
    const pass = make()
    for (const r of ART_ROWS) expect(pass.params.get(r.key), r.key).toBe(r.value)
  })

  it('computes the derived uniforms from the defaults at construction', () => {
    expectDerived(make(), 'construction')
  })

  it('a change re-does exactly what the pre-accessor setter did for that key', () => {
    const { pass, take } = watched()
    for (const r of ART_ROWS) {
      const v = another(pass, r)
      expect(pass.params.set(r.key, v), r.key).toBe(true)
      expect(take(), r.key).toEqual(expectedEffects(r.key))
      expect(pass.params.get(r.key), r.key).toBe(v)
      if (r.uniform) {
        const u = uniform(pass, r.uniform)
        const held = u && u.isVector3 ? rawRgbHex(u) : u
        expect(held, r.key).toBe(r.encode === 'float01' ? (v ? 1 : 0) : v)
      }
      expectDerived(pass, r.key)
    }
  })

  it('treats a set equal to the current value as a no-op', () => {
    const { pass, take } = watched()
    for (const r of ART_ROWS) pass.params.set(r.key, pass.params.get(r.key))
    expect(take()).toEqual([])
  })

  it('a pass that is switched off is not revealing, whatever the director still remembers', () => {
    // The checkbox can switch the pass off mid-reveal; render() then never ticks
    // the reveal to its end. A stale "playing" would keep dynamics from reading
    // attention for good (frameLogic.shouldAdvanceDynamics).
    const pass = make()
    pass.playReveal()
    expect(pass.isRevealPlaying()).toBe(true)
    pass.enabled = false
    expect(pass.isRevealPlaying()).toBe(false)
  })

  it('writes a colour as raw bytes, without colour management', () => {
    const pass = make()
    pass.params.set('colSky', '#ff8000')
    const v = uniform(pass, 'uColSky')
    expect([v.x, v.y, v.z]).toEqual([1, 128 / 255, 0])
  })

  it('the reveal reads the live params', () => {
    const pass = make()
    pass.params.set('revealDuration', 7.5)
    pass.params.set('revealUnderpaintFirst', true)
    const s = pass._reveal._getState()
    expect(s.revealDuration).toBe(7.5)
    expect(s.revealUnderpaintFirst).toBe(true)
  })

  it('a random exit holds the scene still only while that toggle is on', () => {
    const pass = make()
    pass._reveal.isExitPlaying = () => true
    expect(pass.holdsSceneStill()).toBe(false)
    pass.params.set('exitRandom', true)
    expect(pass.holdsSceneStill()).toBe(true)
  })
})

describe('artPass snapshot', () => {
  it('exports { format, params, enabled }: every row by key, and no uniform', () => {
    const s = make().exportState()
    expect(Object.keys(s).sort()).toEqual(['enabled', 'format', 'params'])
    expect(Object.keys(s.params)).toEqual(ART_ROWS.filter(r => r.persist !== false).map(r => r.key))
    for (const k of ['beta', 'cull', 'groundMode', 'debugView', 'colSky', 'exitResumeEase',
      ...ART_REVEAL_TOGGLES.map(t => t.key)]) expect(s.params, k).toHaveProperty(k)
  })

  // Plan bug 1: the restore copied the derived uHeightScale (the slider times
  // the relief scale of the cell size) back into the heightScale slider, so
  // each restore multiplied the slider again.
  it('restores the relief height slider as it was, not as its derived uniform (plan bug 1)', () => {
    const a = make()
    a.params.set('cell', 26)                       // a relief scale far from 1
    a.params.set('heightScale', 1.3)
    expect(uniform(a, 'uHeightScale')).not.toBeCloseTo(1.3, 3)
    const state = JSON.parse(JSON.stringify(a.exportState()))
    const b = make()
    b.importState(state)
    expect(b.params.get('heightScale')).toBe(1.3)
    expect(uniform(b, 'uHeightScale')).toBeCloseTo(uniform(a, 'uHeightScale'), 12)
    for (let i = 0; i < 3; i++) b.importState(JSON.parse(JSON.stringify(b.exportState())))
    expect(b.params.get('heightScale')).toBe(1.3)  // no compounding
  })

  // Plan bug 2: these three were not captured while their derived uniform was,
  // so the slider and the prepass resolution disagreed with the picture.
  it('captures the ground blur, the edge hold and the prepass scale, and the picture they derive (plan bug 2)', () => {
    const a = make()
    a.params.set('groundBlur', 7.4)
    a.params.set('keepEdges', 0.85)
    a.params.set('prepassScale', 0.8)
    const state = JSON.parse(JSON.stringify(a.exportState()))
    const b = make()
    b._sizedFor = 'sized'                          // a resize is owed only if the scale changes
    b.importState(state)
    expect(b.params.get('groundBlur')).toBe(7.4)
    expect(b.params.get('keepEdges')).toBe(0.85)
    expect(b.params.get('prepassScale')).toBe(0.8)
    expect(b._sizedFor).toBe(null)                 // the prepass targets are reallocated for the restored scale
    expect(uniform(b, 'uGroundSigma')).toBeCloseTo(uniform(a, 'uGroundSigma'), 12)
    expect(uniform(b, 'uRespectEdges')).toBeCloseTo(uniform(a, 'uRespectEdges'), 12)
  })

  it('a restore ends fully painted and at rest, and thaws a held picture', () => {
    const a = make()
    const thawed = []
    a._thaw = () => thawed.push(true)
    let reset = 0
    a._resetReveal = () => { reset++ }
    a.importState(JSON.parse(JSON.stringify(make().exportState())))
    expect(thawed).toHaveLength(1)
    expect(reset).toBe(1)
  })

  it('round-trips the params it captures through importState', () => {
    const a = make()
    const set = {
      cell: 11, diffuse: 2.4, colSky: '#123456', groundColor: '#abcdef', beta: 0.41, cull: 0.03,
      groundMode: 3, debugView: 2, revealDuration: 5, exitResumeEase: 2,
      revealUnderpaintFirst: true, exitRandom: true,
    }
    for (const [k, v] of Object.entries(set)) a.params.set(k, v)
    const state = JSON.parse(JSON.stringify(a.exportState()))

    const b = make()
    const report = b.importState(state)
    expect(report.unknown).toEqual([])
    expect(report.rejected).toEqual([])
    for (const [k, v] of Object.entries(set)) expect(b.params.get(k), k).toBe(v)
    for (const n of ['uRespectEdges', 'uGroundSigma', 'uDebugView', 'uOrientMode', 'uDebug']) {
      expect(uniform(b, n), n).toBeCloseTo(uniform(a, n), 12)
    }
  })
})

describe('artPass removed methods', () => {
  // Defined on no other module: any mention is a stale caller or comment.
  const ONLY_ART = [
    'setParam', 'getParam', 'setColor', 'getColor', 'setToggle', 'getToggle',
    'setGroundMode', 'getGroundMode', '_syncRespectEdges', '_syncGroundSigma', 'ART_GROUND_MODE_DEFAULT',
  ]
  // Still named by the terrain and cloud tests' own scans: only a call on the
  // art pass is stale.
  const SHARED = { receiver: 'artPass', names: ['setDebugView', 'getDebugView'] }

  it('no source or test still names them', () => {
    expect(removedNameHits(ONLY_ART, SHARED, import.meta.url)).toEqual([])
  })
})

/**
 * WHEN each cache of the pass is thrown away, event by event. The caches are the
 * strokes (redrawn whole next frame), the prepasses (edge field, ground), the
 * growth field (baked once per entrance) and the hold (the finished picture).
 * Every stale-picture bug so far was a missing edge here, so the edges are
 * pinned as a table: what each event makes stale, and what it leaves alone.
 */
describe('what each event invalidates', () => {
  function spied() {
    const pass = make()
    pass.setSize(64, 36)
    const seen = { strokes: 0, hold: 0, growth: 0 }
    const strokesInvalidate = pass._strokes.invalidate.bind(pass._strokes)
    pass._strokes.invalidate = () => { seen.strokes++; strokesInvalidate() }
    const thaw = pass._reveal.thaw.bind(pass._reveal)
    pass._reveal.thaw = () => { seen.hold++; thaw() }
    const stale = pass._reveal.markGrowthStale.bind(pass._reveal)
    pass._reveal.markGrowthStale = () => { seen.growth++; stale() }
    pass._prepassNeedsBuild = false
    // What happened since the last call, as booleans: 'strokes', 'prepass', 'hold', 'growth'.
    const take = () => {
      const out = { strokes: seen.strokes > 0, prepass: pass._prepassNeedsBuild, hold: seen.hold > 0, growth: seen.growth > 0 }
      seen.strokes = seen.hold = seen.growth = 0
      pass._prepassNeedsBuild = false
      return out
    }
    return { pass, take }
  }
  const none = { strokes: false, prepass: false, hold: false, growth: false }

  it('a scene that stops moving invalidates nothing; one that starts moving invalidates strokes and prepasses', () => {
    const { pass, take } = spied()
    pass.setSceneStatic(true)
    expect(take()).toEqual(none)
    pass.setSceneStatic(true)
    expect(take()).toEqual(none)
    pass.setSceneStatic(false)
    expect(take()).toEqual({ ...none, strokes: true, prepass: true })
  })

  it('switching the pass on redraws the strokes; leaving it on does not', () => {
    const { pass, take } = spied()
    pass.enabled = false
    take()
    pass.enabled = true
    expect(take().strokes).toBe(true)
    pass.enabled = true
    expect(take()).toEqual(none)
  })

  it('a stroke setting invalidates strokes, prepasses and the hold; a ground setting leaves the strokes', () => {
    const { pass, take } = spied()
    pass.params.set('cell', 12)
    expect(take()).toEqual({ ...none, strokes: true, prepass: true, hold: true })
    pass.params.set('groundColor', '#123456')
    expect(take()).toEqual({ ...none, prepass: true, hold: true })
  })

  it('a finish-only or exit setting invalidates nothing', () => {
    const { pass, take } = spied()
    pass.params.set('lightAz', 0.2)
    pass.params.set('exitDuration', 3)
    expect(take()).toEqual(none)
  })

  it('a resize invalidates strokes, prepasses and the growth field, and drops the hold', () => {
    const { pass, take } = spied()
    pass.setSize(64, 36)
    expect(take()).toEqual(none)
    pass.setSize(80, 45)
    const t = take()
    expect(t.prepass).toBe(true)
    expect(t.growth).toBe(true)
    expect(pass._strokes._shown).toBeNull()
  })

  it('restoring a snapshot invalidates strokes, prepasses and the hold', () => {
    const { pass, take } = spied()
    pass.importState(pass.exportState())
    expect(take()).toEqual({ ...none, strokes: true, prepass: true, hold: true })
  })

  it('starting an entrance asks for a new growth field', () => {
    const { pass } = spied()
    pass.playReveal()
    expect(pass._reveal.needsGrowthBuild()).toBe(true)
  })
})
