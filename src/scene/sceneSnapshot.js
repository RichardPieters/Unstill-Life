/**
 * sceneSnapshot.js — capture and restore the exact visual state of a frame as
 * plain JSON, so a rendering bug can be reproduced, and re-checked after a
 * fix, headlessly.
 *
 * STRATEGY  Snapshot the LEAF state (each owner's param rows, its integrated
 *   uniforms, non-uniform module state, camera) and reproduce by pause →
 *   restore → let the render loop redraw. Not by replaying the sim: some state,
 *   such as the accumulated drift offsets, cannot be reached by replay.
 *
 * COMPLETENESS  Each shader owner captures by classification: its rows by key
 *   (paramAccess `export`), its integrated uniforms by name, its other state.
 *   Derived, frame and constant uniforms are not captured; the restore
 *   recomputes the derived ones. Every uniform must be classified
 *   (uniformSerialize.js; tests/unit/uniformClasses.test.js fails otherwise),
 *   so a new one cannot silently drop out. Each entry of SCENE_MODULES
 *   (sceneModules.js) supplies its own exportState/importState; that list is
 *   the only place a module is named.
 *
 * FORMAT  { version, <module key>: <its state>…, camera, scene: { horizonHex },
 *   render: { w, h, dpr } }. Keys are never renamed: saved snapshots must load.
 *   A shader owner's state carries `format: 2` and rejects any other. The
 *   scene-wide fog, light and cloud-shadow values ride in terrain's entry
 *   (`scene`).
 *   `render` lets the probe pin its canvas size; a live import does not resize
 *   the user's window.
 *
 * Reproduction is TOLERANCE-based, not pixel-exact: float rounding differs
 * across GPUs (dev vs the headless probe's software renderer), so compare raw
 * signals within an epsilon, never against a committed pixel snapshot.
 */

import * as THREE from 'three'
import { SCENE_MODULES } from './sceneModules.js'

export const SNAPSHOT_VERSION = 1

/** Capture the full scene visual state → a JSON-serialisable object. */
export function captureScene(deps) {
  const size = deps.renderer.getSize(new THREE.Vector2())
  const out = { version: SNAPSHOT_VERSION }
  for (const { key, required } of SCENE_MODULES) {
    const mod = deps[key]
    if (required || mod) out[key] = mod.exportState()
  }
  out.camera = deps.flyCamera.getPose()
  out.scene  = { horizonHex: '#' + deps.sky.params.get('horizonHex').toString(16).padStart(6, '0') }
  // The ratio actually rendered at (capped — see pixelRatio.js), not the screen's.
  out.render = { w: size.x, h: size.y, dpr: deps.renderer.getPixelRatio() }
  return out
}

/**
 * Restore a scene from a snapshot (object or JSON string). Pauses FIRST: any
 * tick after a write would re-stamp uTime and drift over the restore. Then
 * writes the horizon, every module's state and the camera, warns on unknown
 * uniform keys and on rejected values, and re-renders the data map. Returns
 * { unknown, rejected } for the caller or probe to assert coverage.
 */
export function applyScene(deps, snapshot) {
  const snap = typeof snapshot === 'string' ? JSON.parse(snapshot) : snapshot
  if (snap.version !== SNAPSHOT_VERSION) {
    console.warn(`[snapshot] version ${snap.version} ≠ current ${SNAPSHOT_VERSION} — applying leniently`)
  }
  deps.setPaused(true)

  // ORDER IS LOAD-BEARING: horizon BEFORE the module loop. atmosphere's
  // importState pushes the sky colour together with the other weather-driven
  // values; a horizon write after it would move the sky alone, leaving it
  // disagreeing with the light and fog until the next walk step jumped it back.
  // Written first, it is the value the weather's restore then keeps (weather
  // off) or blends from (weather on).
  if (snap.scene && snap.scene.horizonHex) {
    deps.applyHorizon(parseInt(snap.scene.horizonHex.slice(1), 16))
  }

  const unknown = [], rejected = []
  for (const { key, required } of SCENE_MODULES) {
    if (!snap[key]) continue
    const mod = deps[key]
    if (!required && !mod) continue
    const report = mod.importState(snap[key])
    if (report && report.unknown) unknown.push(...report.unknown)
    if (report && report.rejected) rejected.push(...report.rejected)
  }
  deps.forgetHorizon()   // the restore moved some horizon targets behind its back
  if (snap.camera)  deps.flyCamera.setPose(snap.camera)
  if (unknown.length) {
    console.warn(`[snapshot] ${unknown.length} unknown key(s) dropped (a row or uniform renamed/removed):`, unknown)
  }
  if (rejected.length) {
    console.warn(`[snapshot] ${rejected.length} value(s) dropped (wrong kind for the live row or uniform):`, rejected)
  }
  deps.terrain.renderDataMap()   // rebuild RT_A/RT_B from the restored uniforms
  return { unknown, rejected }
}
