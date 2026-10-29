import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { createSceneUniforms, SCENE_UNIFORM_NAMES } from '../../src/shared/sceneUniforms.js'

// ─── single writer: grep-level scan of the modules that hold shared objects ─
// The consumers of the scene-wide set only READ it at run time. The writers
// are the set's own `set` (wiring: panel, weatherDriver, main.js), its
// per-frame setCloudShadowFrame (main.js), the cloud volume for uUsableRadius,
// and SNAPSHOT RESTORE: terrain's importState hands the set its own captured
// values back (`importState`); no other owner restores a shared
// name. That path goes through the set's `set`, not what this scan looks for.
//
// What it does look for, line by line: a shared name (or a local alias of one,
// `const f = u.uFogNear` / `const w = u.uCloudWind.value`) written through
// `.value` — assigned, a field assigned, or mutated by set/copy/normalize/… —
// and any call of the set's writers from a module file. `importState` is
// allowed: terrain carries the cloud-shadow master in its snapshot entry.
const SRC = new URL('../../src/', import.meta.url)
// path → the shared names that file is allowed to write.
const SCANNED = {
  'terrain/': [], 'water/': [], 'artpass/': [], 'clouds/godrays.js': [],
  // The volume is uUsableRadius's one writer. Its march material also holds an
  // uCloudLit of its OWN (its texture slot, never mounted); the runtime test in
  // sceneUniformsSnapshot.test.js proves it mounts nothing but uUsableRadius.
  'clouds/cloudsVolume.js': ['uUsableRadius', 'uCloudLit'],
}
// Names a consumer mounts a shared object under besides its own (godrays).
const ALIASES = ['uSunDir', 'uShadowTiers']
const MUTATORS = 'set\\w*|copy|add\\w*|sub\\w*|multiply\\w*|divide\\w*|negate|normalize|lerp\\w*|fromArray|apply\\w*|clamp\\w*|round\\w*|floor|ceil|random'
const writesValue = pre => new RegExp(`${pre}\\.value(\\.\\w+)*\\s*=(?!=)|${pre}\\.value(\\.\\w+)*\\.(${MUTATORS})\\(`)
const VALUE_WRITE = writesValue('')
const writesThrough = x => new RegExp(`\\b${x}(\\.\\w+)+\\s*=(?!=)|\\b${x}\\.(${MUTATORS})\\(`)
const SET_CALL = /\b(sceneUniforms|_scene)\.(params\.set|setCloudShadowFrame)\(/
const DECL = /\b(?:const|let|var)\s+(\w+)\s*=\s*(.+)$/

function sourceFiles(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = new URL(name, dir)
    if (statSync(p).isDirectory()) out.push(...sourceFiles(new URL(name + '/', dir)))
    else if (name.endsWith('.js')) out.push(p)
  }
  return out
}

/** `{ at, names }` for every line of `text` that writes a shared uniform. */
function sharedWrites(text, file, names) {
  const nameRe = new RegExp(`\\b(${names.join('|')})\\b`, 'g')
  const lines = text.split('\n').map(l => l.replace(/\/\/.*$/, '').trim())
  // Locals bound to a shared object, or to its live value, anywhere in the file.
  const objAliases = new Map(), valAliases = new Map()
  for (const code of lines) {
    const m = code.match(DECL)
    if (!m) continue
    const found = m[2].match(nameRe)
    if (!found) continue
    ;(/\.value\s*;?$/.test(m[2]) ? valAliases : objAliases).set(m[1], found)
  }
  const hits = []
  lines.forEach((code, i) => {
    if (code.startsWith('*')) return
    const at = `${file}:${i + 1}: ${code}`
    const named = code.match(nameRe)
    if (named && VALUE_WRITE.test(code)) hits.push({ at, names: named })
    for (const [x, n] of objAliases) if (writesValue(`\\b${x}`).test(code)) hits.push({ at, names: n })
    for (const [x, n] of valAliases) if (writesThrough(x).test(code)) hits.push({ at, names: n })
    if (SET_CALL.test(code)) hits.push({ at, names: ['<a scene-set writer>'] })
  })
  return hits
}

describe('single writer per scene-wide uniform', () => {
  const names = [...SCENE_UNIFORM_NAMES, ...ALIASES]

  it('no module source writes one, except each listed owner its own', () => {
    let count = 0
    const hits = []
    for (const [p, allowed] of Object.entries(SCANNED)) {
      const files = p.endsWith('/') ? sourceFiles(new URL(p, SRC)) : [new URL(p, SRC)]
      count += files.length
      for (const f of files) {
        for (const h of sharedWrites(readFileSync(f, 'utf8'), f.pathname.split('/src/')[1], names)) {
          if (!h.names.every(n => allowed.includes(n))) hits.push(h.at)
        }
      }
    }
    expect(count).toBeGreaterThan(5)
    expect(hits).toEqual([])
  })

  it('the cloud volume\'s own writes are found, so its allowance is not vacuous', () => {
    const text = readFileSync(new URL('clouds/cloudsVolume.js', SRC), 'utf8')
    const written = new Set(sharedWrites(text, 'v', names).flatMap(h => h.names))
    expect(written.has('uUsableRadius')).toBe(true)
  })

  it('the scan catches each way of writing', () => {
    const bad = [
      'u.uFogCurve.value = 1',
      'this._material.uniforms.uCloudWind.value.set(x, z)',
      "this._march('uCloudLevel').value = v",
      'u.uFogColor.value.copy(c)',
      'u.uCloudWind.value.x = 1',
      'u.uCloudSunDir.value.normalize()',
      'const f = u.uFogNear\nf.value = 3',
      'const w = u.uCloudWind.value\nw.set(1, 2)',
      'const s = u.uCloudSunDir.value\ns.y = 0',
      "this._scene.params.set('fogCurve', 1)",
      'sceneUniforms.setCloudShadowFrame(frame)',
    ]
    for (const text of bad) expect(sharedWrites(text, 'x', names), text).toHaveLength(1)
    const fine = [
      'if (u.uCloudGround.value === null) return',
      'const t = u.uCloudShadowTiers.value',
      'this._marchedTiers = u.uShadowTiers.value',
      'const w = u.uCloudWind.value\nconst y = w.y',
      '// u.uFogCurve.value = 1',
      'this._scene.importState(state)',
    ]
    for (const text of fine) expect(sharedWrites(text, 'x', names), text).toEqual([])
  })
})

const LIT_FRAME = {
  ground: {}, level: 90, height: 140, extent: 2048, windX: 1.5, windZ: -2, sunX: 0.6, sunY: 0.8, sunZ: 0,
}

describe('createSceneUniforms', () => {
  it('mounts one object per name, under the consumer\'s own name when it asks for one', () => {
    const s = createSceneUniforms()
    const a = s.mount(['uFogCurve', 'uCloudShadowTiers'])
    const b = s.mount({ uShadowTiers: 'uCloudShadowTiers', uSunDir: 'uCloudSunDir' })
    const c = s.mount(['uCloudSunDir'])
    expect(b.uShadowTiers).toBe(a.uCloudShadowTiers)
    expect(b.uSunDir).toBe(c.uCloudSunDir)
    s.params.set('fogCurve', 0.42)
    expect(a.uFogCurve.value).toBe(0.42)
    expect(() => s.mount(['uNoSuchThing'])).toThrow()
  })

  it('is a factory: two sets share nothing', () => {
    const a = createSceneUniforms(), b = createSceneUniforms()
    a.params.set('lightLevel', 0.3)
    a.params.set('cloudShadowAmt', 0.1)
    expect(b.params.get('lightLevel')).not.toBe(0.3)
    expect(b.params.get('cloudShadowAmt')).not.toBe(0.1)
    expect(a.mount(['uFogColor']).uFogColor).not.toBe(b.mount(['uFogColor']).uFogColor)
  })

  it('writes a colour key in place from a hex int', () => {
    const s = createSceneUniforms()
    const color = s.mount(['uFogColor']).uFogColor.value
    s.params.set('fogColor', 0x336699)
    expect(s.params.get('fogColor')).toBe('#336699')
    expect(color.getHex()).toBe(0x336699)
  })

  it('derives the shadow amount: master × dial scale with a light volume, 0 without', () => {
    const s = createSceneUniforms()
    const amt = s.mount(['uCloudShadowAmt']).uCloudShadowAmt
    // No volume yet: the shaders must skip the lookup, so the amount is 0
    // whatever the master says.
    expect(amt.value).toBe(0)
    expect(s.params.get('cloudShadowAmt')).toBeGreaterThan(0)
    const master = s.params.get('cloudShadowAmt')
    // A dial push before the first frame scales the shipped master, not 0.
    s.params.set('cloudShadowScale', 0.5)
    s.setCloudShadowFrame(LIT_FRAME)
    expect(amt.value).toBeCloseTo(master * 0.5, 12)
    s.params.set('cloudShadowAmt', 0.4)
    expect(amt.value).toBeCloseTo(0.2, 12)
    expect(s.params.get('cloudShadowAmt')).toBe(0.4)   // the slider keeps its own value
    s.setCloudShadowFrame({ ...LIT_FRAME, ground: null })
    expect(amt.value).toBe(0)
    s.setCloudShadowFrame(LIT_FRAME)
    expect(amt.value).toBeCloseTo(0.2, 12)
  })

  it('places the frame only while the volume exists', () => {
    const s = createSceneUniforms()
    const u = s.mount(['uCloudLevel', 'uCloudWind', 'uCloudSunDir', 'uCloudGround'])
    const before = u.uCloudLevel.value
    s.setCloudShadowFrame({ ...LIT_FRAME, ground: null })
    expect(u.uCloudLevel.value).toBe(before)
    s.setCloudShadowFrame(LIT_FRAME)
    expect(u.uCloudGround.value).toBe(LIT_FRAME.ground)
    expect(u.uCloudLevel.value).toBe(90)
    expect([u.uCloudWind.value.x, u.uCloudWind.value.y]).toEqual([1.5, -2])
    expect([u.uCloudSunDir.value.x, u.uCloudSunDir.value.y, u.uCloudSunDir.value.z]).toEqual([0.6, 0.8, 0])
  })

  it('writes the sun direction even while the volume does not exist', () => {
    const s = createSceneUniforms()
    const u = s.mount(['uCloudSunDir'])
    s.setCloudShadowFrame({ ...LIT_FRAME, ground: null })
    expect([u.uCloudSunDir.value.x, u.uCloudSunDir.value.y, u.uCloudSunDir.value.z]).toEqual([0.6, 0.8, 0])
  })

  it('round-trips the master through its snapshot state, and recomputes the amount', () => {
    const a = createSceneUniforms()
    a.params.set('cloudShadowAmt', 0.35)
    const state = JSON.parse(JSON.stringify(a.exportState()))
    const b = createSceneUniforms()
    b.setCloudShadowFrame(LIT_FRAME)
    b.importState(state)
    expect(b.params.get('cloudShadowAmt')).toBeCloseTo(0.35, 12)
    expect(b.mount(['uCloudShadowAmt']).uCloudShadowAmt.value).toBeCloseTo(0.35, 12)
    b.importState({})   // an older snapshot without the key keeps the live master
    expect(b.params.get('cloudShadowAmt')).toBeCloseTo(0.35, 12)
  })

  it('round-trips every authored value as JSON, and nothing derived or per-frame', () => {
    const a = createSceneUniforms()
    a.params.set('fogColor', 0x336699)
    a.params.set('fogNear', 123); a.params.set('fogFar', 999); a.params.set('fogCurve', 0.31); a.params.set('fogMaxAlpha', 0.77)
    a.params.set('lightLevel', 0.66); a.params.set('cloudShadowAbs', 0.21); a.params.set('cloudShadowFloor', 0.52)
    a.params.set('cloudShadowTiers', 6); a.params.set('cloudShadowAmt', 0.35); a.params.set('cloudShadowScale', 0.45)
    const state = JSON.parse(JSON.stringify(a.exportState()))
    expect(state.fogColor).toBe('#336699')
    expect(Object.keys(state).sort()).toEqual([
      'cloudShadowAbs', 'cloudShadowAmt', 'cloudShadowFloor', 'cloudShadowScale', 'cloudShadowTiers',
      'fogColor', 'fogCurve', 'fogFar', 'fogMaxAlpha', 'fogNear', 'lightLevel',
    ])
    const b = createSceneUniforms()
    expect(b.importState(state)).toEqual([])
    expect(JSON.parse(JSON.stringify(b.exportState()))).toEqual(state)
  })
})
