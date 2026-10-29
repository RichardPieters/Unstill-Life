import { describe, it, expect } from 'vitest'
import { captureScene, applyScene, SNAPSHOT_VERSION } from '../../src/scene/sceneSnapshot.js'
import { SCENE_MODULES } from '../../src/scene/sceneModules.js'

/**
 * The completeness guard SCENE_MODULES exists for: every listed module must
 * actually show up in captureScene()'s output, and applyScene() must actually
 * call its importState. Uses fake module doubles rather than the real
 * classes — this is a test of the LOOP in sceneSnapshot.js, not of any one
 * module's own state, so a fake that only implements the exportState/
 * importState contract is the right ground truth (never a re-implementation
 * of a module's own export/import logic).
 */
function fakeModule(key) {
  const mod = {
    exportState: () => ({ [key]: 'exported' }),
    importState: state => ({
      unknown: state.unknownProbe ? ['someUnknownKey'] : [],
      rejected: state.rejectedProbe ? ['someRejectedKey'] : [],
    }),
  }
  // applyScene always calls terrain.renderDataMap() after restoring state —
  // not part of the exportState/importState contract, just this one module's
  // own extra rebuild step (see sceneSnapshot.js).
  if (key === 'terrain') mod.renderDataMap = () => {}
  // captureScene reads the live horizon hex off `sky` (the background is a
  // gradient texture with no colour to read back) — also not part of the
  // exportState/importState contract.
  if (key === 'sky') mod.params = { get: () => 0x123456 }
  return mod
}

function fakeDeps(overrides = {}) {
  const deps = {
    renderer: { getSize: v => v.set(800, 600), getPixelRatio: () => 1.25 },
    flyCamera: { getPose: () => ({ pos: [0, 0, 0], yaw: 0, pitch: 0 }), setPose: () => {} },
    applyHorizon: () => {},
    forgetHorizon: () => {},
    setPaused: () => {},
  }
  for (const { key, required } of SCENE_MODULES) {
    // Every module present by default; a test overrides individual keys to
    // simulate an optional dep the caller never constructed (undefined).
    deps[key] = key in overrides ? overrides[key] : fakeModule(key)
    if (!required && overrides[key] === undefined && key in overrides) deps[key] = undefined
  }
  return deps
}

describe('captureScene / SCENE_MODULES completeness', () => {
  it('every SCENE_MODULES key appears in captureScene() output when the dep is present', () => {
    const snap = captureScene(fakeDeps())
    for (const { key } of SCENE_MODULES) {
      expect(snap, `${key} missing from captureScene() output`).toHaveProperty(key)
      expect(snap[key]).toEqual({ [key]: 'exported' })
    }
    expect(snap.version).toBe(SNAPSHOT_VERSION)
    expect(snap.camera).toBeTruthy()
    expect(snap.scene.horizonHex).toMatch(/^#[0-9a-f]{6}$/i)
    // The ratio the renderer actually draws at (capped), not the screen's own.
    expect(snap.render).toEqual({ w: 800, h: 600, dpr: 1.25 })
  })

  it('an absent OPTIONAL module is omitted from the output, not present as undefined', () => {
    const optional = SCENE_MODULES.find(m => !m.required)
    const snap = captureScene(fakeDeps({ [optional.key]: undefined }))
    expect(optional.key in snap).toBe(false)
  })

  it('a REQUIRED module is captured unconditionally (no truthy-check on the dep)', () => {
    const required = SCENE_MODULES.filter(m => m.required)
    expect(required.length).toBeGreaterThan(0)
    for (const { key } of required) {
      const snap = captureScene(fakeDeps())
      expect(snap[key]).toEqual({ [key]: 'exported' })
    }
  })

  it('applyScene calls importState for every module present in the snapshot', () => {
    const deps = fakeDeps()
    const calls = []
    for (const { key } of SCENE_MODULES) {
      const original = deps[key].importState
      deps[key].importState = state => { calls.push(key); return original(state) }
    }
    const snap = captureScene(fakeDeps())
    applyScene(deps, snap)
    for (const { key } of SCENE_MODULES) expect(calls, `${key} never imported`).toContain(key)
  })

  it('applyScene makes the horizon forget its cache after the modules restored', () => {
    const deps = fakeDeps()
    const order = []
    deps.forgetHorizon = () => order.push('forget')
    deps[SCENE_MODULES[0].key].importState = () => { order.push('import') }
    applyScene(deps, captureScene(fakeDeps()))
    expect(order).toEqual(['import', 'forget'])
  })

  it('applyScene collects `unknown` keys reported by any module', () => {
    const deps = fakeDeps()
    const snap = captureScene(fakeDeps())
    const probedKey = SCENE_MODULES[0].key
    snap[probedKey].unknownProbe = true
    const report = applyScene(deps, snap)
    expect(report.unknown).toContain('someUnknownKey')
  })

  it('applyScene collects `rejected` values reported by any module, apart from `unknown`', () => {
    const deps = fakeDeps()
    const snap = captureScene(fakeDeps())
    snap[SCENE_MODULES[0].key].rejectedProbe = true
    const report = applyScene(deps, snap)
    expect(report.rejected).toContain('someRejectedKey')
    expect(report.unknown).not.toContain('someRejectedKey')
  })

  it('an absent optional module in deps is skipped by applyScene, not thrown on', () => {
    const optional = SCENE_MODULES.find(m => !m.required)
    const deps = fakeDeps({ [optional.key]: undefined })
    const snap = captureScene(fakeDeps())   // snapshot HAS the key; this dep doesn't
    expect(() => applyScene(deps, snap)).not.toThrow()
  })
})
