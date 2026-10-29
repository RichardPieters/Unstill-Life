/**
 * paramSchema.js — the one shape of a param row, and the checks every row
 * table passes.
 *
 * A param is one tunable value: a panel control, or a value a driver writes.
 * Each owner declares its rows (terrain/terrainParams.js, water/waterParams.js,
 * …), seeds its uniforms from them (uniformsFor) and builds its accessor from
 * them (shared/paramAccess.js); panel/panelRows.js concatenates them for the
 * panel.
 *
 * FIELDS
 *   id        DOM id of the panel control (its label is `${id}-val`); tooltips
 *             and browser specs key on it. A 'hidden' row's id is `owner.key`.
 *   owner     whose state it is: 'terrain' | 'water' | 'clouds' | 'godrays' |
 *             'artPass' | 'audio' | 'interaction' | 'flyCamera'
 *   key       the owner's name for it, unique within the owner
 *   kind      'slider' | 'toggle' | 'colour' | 'radio' | 'hidden' (no control)
 *   uniform   the uniform it writes; absent for state no shader reads
 *   value     THE default; the uniform is seeded from it (uniformsFor)
 *   min max step   a slider's range and grid
 *   digits    toFixed digits of the slider's label
 *   encode    what the value is, never inferred from the default's type:
 *               'float'    a number, a GLSL float uniform
 *               'int'      a whole number (GLSL int, or a float holding whole numbers)
 *               'bool'     true/false (GLSL bool, or JS-only state)
 *               'float01'  true/false written as 1/0 into a float uniform
 *               'rawRgb'   '#rrggbb' as three 0..1 bytes, no colour management (art pass)
 *               'srgb'     '#rrggbb' into a colour-managed THREE.Color
 *               'vec2'     [x, y]
 *   label     the text beside the control
 *   group     the panel sub-section (the art pass's groups)
 *   drivenBy  'form' | 'weather': a driver writes it, so `value` is only
 *             its construction value and may sit off the step grid
 *   rebuild   art pass: the prepass a change invalidates, 'edge' | 'ground' |
 *             'lut' (documentation only, no code reads it)
 *   index     the element of an array uniform the row writes (per-species
 *             values); the owner builds the array, uniformsFor skips the row
 *   pair      { with: key, order: 'lo' | 'hi' }: one end of an ordered pair,
 *             declared from both ends; paramAccess keeps lo ≤ hi
 *   invalidates  a dirty class (or list) the owner is told about on a change
 *   clamp     true: clamp to [min, max]; [lo, hi]: to those bounds (±Infinity
 *             for an open end). Applied after `encode`; NaN lands on the lower bound
 *   persist   false: not scene state (a test switch, a per-frame input);
 *             snapshots skip it
 *   displayScale  the panel shows value × this (mic delay: seconds stored, ms
 *             shown); every other number of the row stays in stored units
 *   live      the value also changes outside the panel (a key shortcut), so
 *             the panel re-reads it every frame
 *   options   a radio's choices [{ value, label }], one radio per entry
 *             ('radio' names the radios' shared `name`)
 *   mirrorOf  'owner.key' of another owner's param this row stands in for (the
 *             weather's clear rows); the row's owner decides per read and write
 *             which of the two is the truth
 *
 * Where a row sits in the panel is panel/panelLayout.js's, not the row's.
 */

export const KINDS = ['slider', 'toggle', 'colour', 'radio', 'hidden']
export const ENCODES = ['float', 'int', 'bool', 'float01', 'rawRgb', 'srgb', 'vec2']
export const DRIVERS = ['form', 'weather']
const REBUILDS = ['edge', 'ground', 'lut']

const FIELDS = new Set([
  'id', 'owner', 'key', 'kind', 'uniform', 'value', 'min', 'max', 'step', 'digits',
  'encode', 'label', 'group', 'drivenBy', 'rebuild', 'index', 'pair', 'invalidates', 'persist', 'clamp',
  'displayScale', 'live', 'options', 'mirrorOf',
])

const HEX = /^#[0-9a-f]{6}$/i
const VALUE_OK = {
  float:   v => Number.isFinite(v),
  int:     v => Number.isInteger(v),
  bool:    v => typeof v === 'boolean',
  float01: v => typeof v === 'boolean',
  rawRgb:  v => typeof v === 'string' && HEX.test(v),
  srgb:    v => typeof v === 'string' && HEX.test(v),
  vec2:    v => Array.isArray(v) && v.length === 2 && v.every(Number.isFinite),
}

/** The [lo, hi] a row's `clamp` names, or null if it has none. */
export function clampBounds(r) {
  if (!('clamp' in r)) return null
  return r.clamp === true ? [r.min, r.max] : r.clamp
}

/** A stored value as the panel shows it (× the row's displayScale, 1 if none). */
export function toDisplay(r, v) {
  return 'displayScale' in r ? v * r.displayScale : v
}

/** What the panel shows, back to the stored value. */
export function fromDisplay(r, v) {
  return 'displayScale' in r ? v / r.displayScale : v
}

/**
 * Every problem in a set of rows, as readable strings; [] when all is well.
 * Checks the shape of each row and, across the set, that ids are unique and
 * keys are unique within an owner. The step grid is left to the caller,
 * since a driven default legitimately sits off it.
 */
export function validateRows(rows) {
  const problems = []
  const ids = new Set()
  const keys = new Set()
  for (const r of rows) {
    const at = r.id || `${r.owner}.${r.key}`
    const bad = msg => problems.push(`${at}: ${msg}`)
    for (const f of Object.keys(r)) {
      if (!FIELDS.has(f)) bad(`unknown field "${f}"`)
    }
    for (const f of ['id', 'owner', 'key']) {
      if (typeof r[f] !== 'string' || !r[f]) bad(`${f} must be a non-empty string`)
    }
    if (!KINDS.includes(r.kind)) bad(`unknown kind "${r.kind}"`)
    if (!ENCODES.includes(r.encode)) bad(`unknown encode "${r.encode}"`)
    else if (!VALUE_OK[r.encode](r.value)) bad(`value ${JSON.stringify(r.value)} is not a valid ${r.encode}`)
    if ('uniform' in r && !/^u[A-Z]\w*$/.test(r.uniform)) bad(`uniform "${r.uniform}" does not look like one`)
    if ('drivenBy' in r && !DRIVERS.includes(r.drivenBy)) bad(`unknown drivenBy "${r.drivenBy}"`)
    if ('rebuild' in r && !REBUILDS.includes(r.rebuild)) bad(`unknown rebuild "${r.rebuild}"`)
    if ('index' in r && !(Number.isInteger(r.index) && r.index >= 0 && r.uniform)) bad('index needs a whole number and a uniform')
    if ('pair' in r && !(r.pair && typeof r.pair.with === 'string' && ['lo', 'hi'].includes(r.pair.order))) {
      bad('pair must be { with: key, order: "lo" | "hi" }')
    }
    if ('invalidates' in r && ![].concat(r.invalidates).every(c => typeof c === 'string' && c)) bad('invalidates must name a class')
    if ('persist' in r && typeof r.persist !== 'boolean') bad('persist must be true or false')
    if ('options' in r && !(r.kind === 'radio' && Array.isArray(r.options) && r.options.length && r.options.every(o => o && Number.isFinite(o.value) && typeof o.label === 'string'))) {
      bad('options must be a non-empty list of { value, label } on a radio')
    }
    if (r.kind === 'radio' && !('options' in r)) bad('a radio needs options')
    if ('live' in r && typeof r.live !== 'boolean') bad('live must be true or false')
    if ('mirrorOf' in r && !/^\w+\.\w+$/.test(r.mirrorOf ?? '')) bad('mirrorOf must be "owner.key"')
    if ('displayScale' in r && !(Number.isFinite(r.displayScale) && r.displayScale > 0)) bad('displayScale must be a positive number')
    if ('clamp' in r) {
      const b = clampBounds(r)
      if (!Array.isArray(b) || b.length !== 2 || !b.every(n => typeof n === 'number' && !Number.isNaN(n)) || !(b[0] <= b[1])) {
        bad('clamp must be true (with numeric min and max) or [lo, hi]')
      } else if (typeof r.value === 'number' && (r.value < b[0] || r.value > b[1])) {
        bad(`value ${r.value} is outside its clamp [${b[0]}, ${b[1]}]`)
      }
    }
    if (r.kind === 'slider') {
      if (![r.min, r.max, r.step].every(Number.isFinite)) bad('a slider needs numeric min, max and step')
      else {
        if (!(r.min < r.max)) bad(`min ${r.min} is not below max ${r.max}`)
        if (!(r.step > 0)) bad(`step ${r.step} is not positive`)
        if (r.value < r.min || r.value > r.max) bad(`value ${r.value} is outside [${r.min}, ${r.max}]`)
      }
      if (!Number.isInteger(r.digits) || r.digits < 0) bad(`digits ${r.digits} is not a whole number`)
    }
    if (ids.has(r.id)) bad('id used twice')
    ids.add(r.id)
    const ok = `${r.owner}:${r.key}`
    if (keys.has(ok)) bad(`key "${r.key}" used twice in owner ${r.owner}`)
    keys.add(ok)
  }
  // A pair is declared from both ends, lo at one and hi at the other.
  const byKey = new Map(rows.map(r => [`${r.owner}:${r.key}`, r]))
  for (const r of rows) {
    if (!r.pair || typeof r.pair.with !== 'string') continue
    const p = byKey.get(`${r.owner}:${r.pair.with}`)
    if (!p || !p.pair || p.pair.with !== r.key || p.pair.order === r.pair.order) {
      problems.push(`${r.id}: pair partner "${r.pair.with}" does not declare the other end`)
    }
  }
  return problems
}

// A row's default as the uniform holds it. Colours and vectors are absent: they
// need a THREE object, which this module does not build, and no row-backed
// uniform of an owner seeded here is one.
const SEED = {
  float:   v => v,
  int:     v => v,
  bool:    v => v,
  float01: v => (v ? 1 : 0),
}

/**
 * The { value } objects of the rows that name a uniform, keyed by uniform name
 * and seeded with each row's default: the one place an owner's uniform block
 * takes a row's default from. `pick` narrows the rows (e.g. to one table).
 * `make` builds the encodes this module cannot ({ srgb: hex => new
 * THREE.Color(hex) }); an encode with neither a seed nor a maker throws.
 * A row with an `index` is skipped: the owner builds that array.
 *
 * One object per name: rows naming the same uniform share it, and their
 * defaults must agree (else throws). An owner mounts each object into every
 * table that reads it, by reference, never a copy.
 */
export function uniformsFor(rows, pick = () => true, make = {}) {
  const out = {}
  const seededFrom = {}
  for (const r of rows) {
    if (!r.uniform || 'index' in r || !pick(r)) continue
    const seed = SEED[r.encode] || make[r.encode]
    if (!seed) throw new Error(`uniformsFor: ${r.id}: cannot seed a "${r.encode}" uniform`)
    if (Object.hasOwn(out, r.uniform)) {
      if (seededFrom[r.uniform] !== r.value) throw new Error(`uniformsFor: ${r.uniform} has two defaults`)
      continue
    }
    seededFrom[r.uniform] = r.value
    out[r.uniform] = { value: seed(r.value) }
  }
  return out
}

/** One owner's defaults as { key: value }. A key given twice throws. */
export function rowDefaults(rows) {
  const out = {}
  for (const r of rows) {
    if (Object.hasOwn(out, r.key)) throw new Error(`rowDefaults: key "${r.key}" used twice`)
    out[r.key] = r.value
  }
  return out
}
