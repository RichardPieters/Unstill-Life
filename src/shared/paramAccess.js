/**
 * paramAccess.js — one owner's params by key: get, set, change hooks.
 *
 *   this.params = paramAccess({ tables, rows, fields, derived, onInvalidate })
 *   terrain.params.set('snowBase', 0.8) · get · has · keys()
 *   terrain.params.onChange('gateLo', v => …) · onAnyChange((key, v) => …)
 *
 * WHERE A VALUE LIVES — decided per row, once, at construction:
 *   uniform   the row names one: `set` writes and `get` reads it, in the FIRST
 *             table that has the name (inside an owner a name is one { value }
 *             object in every table). With `index` the row is one element of an
 *             array uniform.
 *   field     `fields[key]` = { get, set }, for state that is not one uniform: a
 *             driver's base, a resource (segments), one value written into two
 *             uniforms. objectFields(obj, names) builds fields over a plain
 *             settings object.
 *   held      neither: JS-only state kept here, seeded from the row's value (an
 *             angle a derived uniform is computed from).
 *
 * SET(key, v), in this order:
 *   encode    'bool' → !!v · 'float01' → 1/0 · 'int' → rounded; then the row's
 *             `clamp`
 *   guard     equal to the current value → nothing happens (returns true).
 *             Equal means ===, a Color's hex, a raw Vector3's '#rrggbb', a
 *             Vector2's x and y
 *   pair      a lo end set above its hi (or hi below lo) moves the partner first,
 *             so lo ≤ hi holds after every write
 *   write     through uniformValue.js's typed writer; a value of the wrong kind
 *             is rejected and `set` returns false
 *   derived   every derived uniform with `key` in its `from` is recomputed:
 *             fn(read) → typed writer, `read` being `get`. Never a row's uniform;
 *             also computed once at construction
 *   invalidate  onInvalidate(cls) for each class in the row's `invalidates`
 *   notify    onChange(key) listeners, then onAnyChange; never during
 *             construction. `notify(key)` runs only this step, for a value that
 *             moved behind the accessor (a walked scalar, an imported state)
 * GET(key)  the stored value: a number or boolean; 'float01' rows as a boolean,
 *             'srgb' and 'rawRgb' rows as '#rrggbb'. An unknown key, or a uniform
 *             no table has, reads null and `set` ignores it (returns false).
 *
 * EXPORT / IMPORT  `export()` is every row without `persist: false`, as JSON;
 *   `import(values)` writes them back through `set` (so derived uniforms,
 *   invalidations and hooks fire), in row order, and returns { applied, unknown,
 *   rejected }. State that is not a row (integrated uniforms, a driver's angle)
 *   is the owner's. `rowUniforms()` / `derivedUniforms()` feed the
 *   classification test (uniformSerialize.js).
 *
 * STAYS AN OWNER METHOD: anything that is not one value: per-frame inputs,
 * resource work callable on its own (setSegments), readouts of internal state,
 * lifecycle, exportState/importState. A field's setter may call such a method.
 */
import { writeUniformValue, rawRgbHex } from './uniformValue.js'
import { ENCODES, clampBounds } from './paramSchema.js'
import { clamp } from './mathUtils.js'

const ENCODE = {
  bool:    v => !!v,
  float01: v => (v ? 1 : 0),
  int:     v => Math.round(v),
}
const DECODE = {
  float01: v => !!v,
  // A field may already hold '#rrggbb' (the weather's profile rows).
  srgb:    c => (typeof c === 'string' ? c : '#' + c.getHexString()),
  rawRgb:  rawRgbHex,
}

const hexOf = v => (typeof v === 'string' && v[0] === '#' ? parseInt(v.slice(1), 16) : v)

// Whether writing `next` over `cur` would change nothing.
function same(cur, next) {
  if (cur === next) return true
  if (cur && cur.isColor) return cur.getHex() === hexOf(next)
  if (cur && cur.isVector3) return typeof next === 'string' && rawRgbHex(cur) === next.toLowerCase()
  if (cur && cur.isVector2) return !!next && cur.x === next.x && cur.y === next.y
  return false
}

// A stored value as JSON: a Vector2 as { x, y }, a Color as '#rrggbb'.
function jsonOf(v) {
  if (v && v.isVector2) return { x: v.x, y: v.y }
  if (v && v.isColor) return '#' + v.getHexString()
  return v
}

// A { value } view of one array element, so the typed writer reaches it.
const element = (u, i) => ({
  get value() { return u.value[i] },
  set value(v) { u.value[i] = v },
})

/**
 * `fields` entries over the named properties of a plain settings object, for
 * an owner (or its driver) whose params are such properties:
 *   fields: { ...objectFields(driver.settings, ['baseSpeed0', 'driftEnabled']) }
 */
export function objectFields(obj, names) {
  return Object.fromEntries(names.map(n => [n, { get: () => obj[n], set: v => { obj[n] = v } }]))
}

/**
 * @param {object}   opts
 * @param {object[]} opts.tables   uniform tables, searched in order
 * @param {object[]} [opts.rows]   param rows (shared/paramSchema.js)
 * @param {Record<string, {get: () => any, set: (v: any) => void}>} [opts.fields]
 * @param {{uniform: string, from: string[], fn: (read: (key: string) => any) => any}[]} [opts.derived]
 * @param {(cls: string) => void} [opts.onInvalidate]
 */
export function paramAccess({ tables, rows = [], fields = {}, derived = [], onInvalidate = () => {} }) {
  const entries = new Map()
  const held = new Map()
  const add = (key, entry) => {
    if (entries.has(key)) throw new Error(`paramAccess: key "${key}" is mapped twice`)
    if (entry.encodeName && !ENCODES.includes(entry.encodeName)) {
      throw new Error(`paramAccess: unknown encode "${entry.encodeName}" for "${key}"`)
    }
    entries.set(key, {
      bounds: entry.row ? clampBounds(entry.row) : null,
      encode: ENCODE[entry.encodeName] || (v => v),
      decode: DECODE[entry.encodeName] || (v => v),
      ...entry,
    })
  }

  for (const r of rows) {
    const base = { encodeName: r.encode, row: r }
    if (Object.hasOwn(fields, r.key)) {
      if (r.uniform) throw new Error(`paramAccess: "${r.key}" names a uniform and a field`)
      add(r.key, { ...base, field: fields[r.key] })
    } else if (r.uniform) {
      add(r.key, { ...base, uniform: r.uniform, index: r.index })
    } else {
      add(r.key, { ...base, held: true })
      held.set(r.key, r.value)
    }
  }
  for (const key of Object.keys(fields)) {
    if (!entries.has(key)) throw new Error(`paramAccess: field "${key}" has no row`)
  }

  const findUniform = name => {
    for (const t of tables) if (Object.hasOwn(t, name)) return t[name]
    return null
  }
  // The { value } a uniform entry reads and writes, or null.
  const slot = e => {
    const u = findUniform(e.uniform)
    if (!u) return null
    return e.index === undefined ? u : element(u, e.index)
  }
  const read = e => {
    if (e.field) return e.field.get()
    if (e.held) return held.get(e.row.key)
    const s = slot(e)
    return s ? s.value : null
  }

  // Derived uniforms, by the keys that feed them.
  const rowUniforms = new Set(rows.map(r => r.uniform).filter(Boolean))
  const derivedBy = new Map()
  for (const d of derived) {
    if (rowUniforms.has(d.uniform)) throw new Error(`paramAccess: derived ${d.uniform} is also a row's uniform`)
    if (!findUniform(d.uniform)) throw new Error(`paramAccess: derived ${d.uniform} is in no table`)
    for (const k of d.from) {
      if (!entries.has(k)) throw new Error(`paramAccess: derived ${d.uniform} reads unknown key "${k}"`)
      if (!derivedBy.has(k)) derivedBy.set(k, [])
      derivedBy.get(k).push(d)
    }
  }

  const listeners = new Map()
  const anyListeners = new Set()
  const subscribe = (set, fn) => { set.add(fn); return () => set.delete(fn) }

  const api = {
    has(key) { return entries.has(key) },
    /** Every key, in row order. */
    keys() { return [...entries.keys()] },
    get(key) {
      const e = entries.get(key)
      if (!e) return null
      const v = read(e)
      return v === null ? null : e.decode(v)
    },
    set(key, v) {
      const e = entries.get(key)
      if (!e) return false
      let next = e.encode(v)
      if (e.bounds && typeof next === 'number') next = clamp(next, e.bounds[0], e.bounds[1])
      if (same(read(e), next)) return true
      if (e.row && e.row.pair) keepOrder(e.row.pair, next)
      if (!write(e, next)) return false
      for (const d of derivedBy.get(key) || []) recompute(d)
      for (const cls of [].concat(e.row?.invalidates ?? [])) onInvalidate(cls)
      api.notify(key)
      return true
    },
    /** Tell the listeners of `key` its value is now what `get` returns, for a value that changed without `set`. */
    notify(key) {
      if (!entries.has(key)) return
      const out = api.get(key)
      for (const fn of listeners.get(key) || []) fn(out)
      for (const fn of anyListeners) fn(key, out)
    },
    /**
     * The snapshot of this owner's rows: { key: json value } for every row that
     * has not said `persist: false`, in row order. Colours are '#rrggbb', a
     * vec2 is { x, y }, a 'float01' row a boolean.
     */
    export() {
      const out = {}
      for (const [key, e] of entries) {
        if (!e.row || e.row.persist === false) continue
        const v = api.get(key)
        if (v !== null) out[key] = jsonOf(v)
      }
      return out
    },
    /**
     * Restore an `export()` through `set`, so derived uniforms, invalidations
     * and change hooks fire as for any write. Rows are applied in row order
     * (a pair keeps its order whichever end comes first). A key that names no
     * row is `unknown`; a value the row's uniform refused is `rejected`; a key
     * of a `persist: false` row is ignored. Returns { applied, unknown, rejected }.
     */
    import(values) {
      const applied = [], unknown = [], rejected = []
      for (const key of Object.keys(values)) if (!entries.get(key)?.row) unknown.push(key)
      for (const [key, e] of entries) {
        if (!e.row || e.row.persist === false || !Object.hasOwn(values, key)) continue
        const ok = api.set(key, values[key])
        ;(ok ? applied : rejected).push(key)
      }
      return { applied, unknown, rejected }
    },
    /** Uniform names the rows write (a row's `uniform`). */
    rowUniforms() { return [...rowUniforms] },
    /** Uniform names a `derived` entry computes. */
    derivedUniforms() { return derived.map(d => d.uniform) },
    /** fn(value) after every changed set of `key`. Returns an unsubscribe. */
    onChange(key, fn) {
      if (!listeners.has(key)) listeners.set(key, new Set())
      return subscribe(listeners.get(key), fn)
    },
    /** fn(key, value) after every changed set of any key. Returns an unsubscribe. */
    onAnyChange(fn) { return subscribe(anyListeners, fn) },
  }

  function write(e, next) {
    if (e.field) { e.field.set(next); return true }
    if (e.held) { held.set(e.row.key, next); return true }
    const s = slot(e)
    return s ? writeUniformValue(s, next) : false
  }
  function recompute(d) {
    writeUniformValue(findUniform(d.uniform), d.fn(api.get))
  }
  // Move the partner first when `next` would cross it.
  function keepOrder({ with: partner, order }, next) {
    const other = api.get(partner)
    if (order === 'lo' ? next > other : next < other) api.set(partner, next)
  }

  for (const d of derived) recompute(d)
  return api
}
