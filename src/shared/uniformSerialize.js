/**
 * uniformSerialize.js — the uniforms of a snapshot, by classification.
 *
 * Every uniform of an owner is exactly one of (classes in each owner's
 * *Params.js, `UNIFORM_CLASSES`; tests/unit/uniformClasses.test.js fails on one
 * that is none):
 *   row         a param row writes it: captured by `params.export()` under the
 *               row's key (paramAccess.js)
 *   derived     computed from rows and owner state: never captured, recomputed
 *               by the restore (a paramAccess `derived` entry, or the owner's
 *               own step, named in UNIFORM_CLASSES)
 *   frame       rewritten from scratch every frame or pass (camera matrices,
 *               textures, resolution, a pass's per-draw inputs): never captured
 *   constant    written once at construction and never again: never captured
 *   shared      lives in the scene-wide set (sceneUniforms.js), which
 *               snapshots its own authored values
 *   integrated  accumulated over time (drift offsets, wind offsets, the clock)
 *               or the last output of a tick that reads input no snapshot
 *               holds (the foam width a momentum scaled): cannot be recomputed,
 *               so it is captured here BY NAME
 * UNIFORM_CLASSES lists the names that are none of the first, shared or
 * derived-by-accessor: { uName: 'integrated' | 'derived' | 'frame' | 'constant'
 * | 'row:<key>' }. 'row:<key>' says the uniform is written by that row's
 * field (octaves: one row, two uniforms), so the row carries it.
 *
 * A NEW UNIFORM must be classified before the build is green: give it a row,
 * or list it in the owner's UNIFORM_CLASSES. The completeness test
 * (tests/unit/uniformClasses.test.js) fails on an unclassified one and on a
 * listed name that no longer exists, so none can silently drop out of snapshots.
 *
 * ENCODING  number, bool → as is · THREE.Color → '#rrggbb' · Vector2 → {x, y}.
 *           `captureUniforms` throws on anything else (texture, matrix,
 *           Vector3, typed array): no integrated uniform is one.
 * RESTORE   through uniformValue.js's writer, by the live uniform's kind: a
 *           Color or Vector2 is mutated, never replaced, so uniforms shared by
 *           reference between materials stay shared; a value of the wrong kind
 *           is rejected, not written.
 */

import * as THREE from 'three'
import { writeUniformValue } from './uniformValue.js'

/** The `format` an owner's exportState stamps and its importState checks; any other is rejected. */
export const STATE_FORMAT = 2

// Encode one uniform value to JSON, or undefined if not serializable.
function encodeValue(v) {
  if (typeof v === 'number' || typeof v === 'boolean') return v
  if (v instanceof THREE.Color)   return '#' + v.getHexString()
  if (v instanceof THREE.Vector2) return { x: v.x, y: v.y }
  return undefined
}

/** The names a class table gives one class, in table order. */
export function namesOfClass(classes, cls) {
  return Object.keys(classes).filter(n => classes[n] === cls)
}

/**
 * { name: json } for the named uniforms, each from the first table that has it.
 * A name no table holds, or whose value is not serialisable, throws: a
 * classification that names a uniform it cannot capture is a bug, not a gap
 * to skip.
 */
export function captureUniforms(tables, names) {
  const out = {}
  for (const name of names) {
    const table = tables.find(t => Object.hasOwn(t, name))
    const enc = table && encodeValue(table[name].value)
    if (enc === undefined) throw new Error(`captureUniforms: ${name} is not a serialisable uniform of any table`)
    out[name] = enc
  }
  return out
}

/**
 * Write { name: json } back into the live uniforms, each into the first table
 * that has it. Returns { applied, unknown, rejected }: `unknown` names matched
 * no live uniform (renamed or removed since capture), `rejected` names whose
 * value did not fit the live uniform's kind, so the caller can warn about
 * both. A silently wrong reproduction is the one failure a debug tool cannot
 * have.
 */
export function applyUniforms(tables, data) {
  const applied = [], unknown = [], rejected = []
  for (const key in data) {
    const target = tables.find(t => Object.hasOwn(t, key))
    if (!target) unknown.push(key)
    else if (writeUniformValue(target[key], data[key])) applied.push(key)
    else rejected.push(key)
  }
  return { applied, unknown, rejected }
}
