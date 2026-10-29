/**
 * sceneModules.js — every scene module whose state a snapshot round-trips.
 *
 * This array IS what captureScene/applyScene (sceneSnapshot.js) loop over, not
 * a description beside them, so it cannot disagree with what is actually
 * captured. A stateful module is added here, once (plus main.js's
 * snapshotDeps), and nowhere else. tests/unit/sceneSnapshot.test.js proves
 * every listed module is exported and imported; a module never listed is
 * silently left out of every snapshot, which only scene_snapshot.spec.js's
 * per-module field checks would notice.
 *
 * ENTRY
 *   key       the deps property (main.js's snapshotDeps) AND the module's key
 *             in the snapshot JSON: one name for both. Never rename one, or
 *             saved snapshots stop restoring that module.
 *   required  true: always present (terrain, water), exported unconditionally.
 *             Otherwise optional, touched only when deps[key] exists, so a
 *             probe or test double that builds fewer modules still works.
 *
 * CONTRACT  exportState() returns a plain JSON-serialisable object.
 *   importState(state) applies it and MAY return { unknown: [...], rejected:
 *   [...] } naming keys it did not recognise and values it could not write (a
 *   row key or an integrated uniform name; paramAccess's `import` and
 *   uniformSerialize.js's reports); applyScene collects and warns on those.
 *   Nothing else is read off the result.
 *   The shader owners (terrain, water, clouds, godrays, artPass) stamp
 *   `format: 2` into their state and reject any other format.
 */
export const SCENE_MODULES = [
  { key: 'terrain', required: true },
  { key: 'water',   required: true },
  { key: 'formWalker' },
  { key: 'clouds' },
  { key: 'form' },
  { key: 'artPass' },
  { key: 'dynamics' },
  { key: 'animSpeed' },
  { key: 'atmosphere' },
  { key: 'godrays' },
  { key: 'audio' },
  { key: 'sky' },
]
