/**
 * flyCamera.js — debug free-fly camera for inspecting the terrain. Never
 * touches the landscape; the finished piece always uses the authored view.
 *
 * CONTROLS  F toggles it; then WASD planar move, Space/Shift up/down, Ctrl ×4
 * boost, mouse-drag look. Movement follows yaw only, so looking up or down
 * never tilts travel.
 *
 * ENABLE / DISABLE  Off by default. On enable, yaw/pitch are seeded from the
 * camera's current facing so the view does not jump; on disable the authored
 * CAM_POSITION/CAM_LOOKAT is restored.
 *
 * SNAPSHOTS  getPose()/setPose() carry the pose for sceneSnapshot.js. A pose
 * is always restored through the fly-on path: the disabled path resets to the
 * authored camera, so it cannot hold an arbitrary pose.
 *
 * The only side effects are on the passed camera (position + quaternion), so
 * update() and `params.set('enabled', …)` run under unit tests; attach() wires the window
 * listeners (including the F toggle), the panel's checkbox sets `params`' enabled,
 * the render loop calls update(dt).
 */
import * as THREE from 'three'
import { paramAccess } from '../shared/paramAccess.js'
import { FLY_PARAMS } from './flyCameraParams.js'
import { CAM_POSITION, CAM_LOOKAT } from '../shared/sceneConfig.js'

const MOVE_SPEED   = 360   // world units / second (base)
const BOOST_FACTOR = 4     // Ctrl multiplier
const LOOK_SPEED   = 0.0025 // radians per pixel dragged
const PITCH_LIMIT  = THREE.MathUtils.degToRad(89)

export class FlyCamera {
  // ─── state ─────────────────────────────────────────────────────────────────

  /** @param {THREE.PerspectiveCamera} camera */
  constructor(camera) {
    this._camera  = camera
    this._enabled = false
    // `enabled` is the one row: the field's setter is _setEnabled.
    this.params = paramAccess({
      tables: [],
      rows: FLY_PARAMS,
      fields: { enabled: { get: () => this._enabled, set: on => this._setEnabled(on) } },
    })

    // Held movement keys (code strings, layout-independent).
    this._keys = new Set()
    // Look angles (radians). Euler YXZ: yaw about world-Y, then pitch about X.
    this._yaw   = 0
    this._pitch = 0
    // Drag-look state.
    this._dragging = false
    this._lastX = 0
    this._lastY = 0

    this._onKeyDown     = this._onKeyDown.bind(this)
    this._onKeyUp       = this._onKeyUp.bind(this)
    this._onPointerDown = this._onPointerDown.bind(this)
    this._onPointerMove = this._onPointerMove.bind(this)
    this._onPointerUp   = this._onPointerUp.bind(this)
  }

  // ─── snapshot (sceneSnapshot.js) ───────────────────────────────────────────

  /**
   * Resolved camera pose. Derives yaw/pitch from the live camera facing so it
   * is correct whether fly is on (authoritative _yaw/_pitch) or off (authored
   * lookAt) — one code path. `enabled` is informational; setPose always
   * restores through fly-on.
   */
  getPose() {
    const dir = new THREE.Vector3()
    this._camera.getWorldDirection(dir)
    return {
      pos: this._camera.position.toArray(),
      yaw: Math.atan2(-dir.x, -dir.z),
      pitch: Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1)),
      enabled: this._enabled,
    }
  }

  /**
   * Restore a captured pose: forces fly-on and writes yaw/pitch/position.
   * update() then re-derives the same quaternion each frame with no keys held.
   */
  setPose({ pos, yaw, pitch }) {
    this.params.set('enabled', true)
    this._camera.position.fromArray(pos)
    this._yaw = yaw
    this._pitch = pitch
    this._camera.quaternion.setFromEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ'))
  }

  // ─── lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Wire input listeners. They bind to `window`, not `domElement`: the canvas
   * has `pointer-events: none` (canvas CSS), so it never receives a
   * pointerdown. `_onPointerDown` ignores presses that land on the debug panel
   * so its sliders keep working while flying.
   */
  attach() {
    window.addEventListener('keydown', this._onKeyDown)
    window.addEventListener('keyup',   this._onKeyUp)
    window.addEventListener('pointerdown', this._onPointerDown)
    window.addEventListener('pointermove', this._onPointerMove)
    window.addEventListener('pointerup',   this._onPointerUp)
  }

  _setEnabled(on) {
    this._enabled = on
    this._keys.clear()
    this._dragging = false
    if (on) {
      // Seed yaw/pitch from the camera's current facing so the view holds.
      const dir = new THREE.Vector3()
      this._camera.getWorldDirection(dir)
      this._yaw   = Math.atan2(-dir.x, -dir.z)
      this._pitch = Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1))
    } else {
      // Restore the authored framing.
      this._camera.position.copy(CAM_POSITION)
      this._camera.up.set(0, 1, 0)
      this._camera.lookAt(CAM_LOOKAT)
    }
  }

  // ─── per frame ─────────────────────────────────────────────────────────────

  /** Advance the camera by `dt` seconds. No-op while disabled. */
  update(dt) {
    if (!this._enabled) return

    this._pitch = THREE.MathUtils.clamp(this._pitch, -PITCH_LIMIT, PITCH_LIMIT)
    this._camera.quaternion.setFromEuler(new THREE.Euler(this._pitch, this._yaw, 0, 'YXZ'))

    const move = this._moveVector()
    if (move.lengthSq() > 0) {
      const boost = this._keys.has('ControlLeft') || this._keys.has('ControlRight') ? BOOST_FACTOR : 1
      const dist  = MOVE_SPEED * boost * dt
      // Yaw-only (horizontal) axes, so WASD stays constant regardless of pitch.
      // Ascent is world-Y.
      const forward = new THREE.Vector3(-Math.sin(this._yaw), 0, -Math.cos(this._yaw))
      const right   = new THREE.Vector3( Math.cos(this._yaw), 0, -Math.sin(this._yaw))
      const delta = new THREE.Vector3()
      delta.addScaledVector(forward, move.z)
      delta.addScaledVector(right,   move.x)
      delta.y += move.y
      delta.normalize().multiplyScalar(dist)
      this._camera.position.add(delta)
    }
  }

  // ─── private ───────────────────────────────────────────────────────────────

  /** Local move intent from held keys: x=right, y=up, z=forward. */
  _moveVector() {
    const k = this._keys
    const v = new THREE.Vector3()
    if (k.has('KeyW')) v.z += 1
    if (k.has('KeyS')) v.z -= 1
    if (k.has('KeyD')) v.x += 1
    if (k.has('KeyA')) v.x -= 1
    if (k.has('Space'))      v.y += 1
    if (k.has('ShiftLeft') || k.has('ShiftRight')) v.y -= 1
    return v
  }

  _onKeyDown(e) {
    // Never eat keystrokes destined for a debug text/number/range input.
    const t = document.activeElement
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return
    if (e.code === 'KeyF') { this.params.set('enabled', !this._enabled); return }
    if (!this._enabled) return
    this._keys.add(e.code)
    // Prevent Space from scrolling / activating focused buttons.
    if (e.code === 'Space') e.preventDefault()
  }

  _onKeyUp(e) { this._keys.delete(e.code) }

  _onPointerDown(e) {
    if (!this._enabled) return
    // Let the debug panel (sliders, checkboxes) keep the press.
    if (e.target && e.target.closest && e.target.closest('#debug')) return
    this._dragging = true
    this._lastX = e.clientX
    this._lastY = e.clientY
  }

  _onPointerMove(e) {
    if (!this._enabled || !this._dragging) return
    const dx = e.clientX - this._lastX
    const dy = e.clientY - this._lastY
    this._lastX = e.clientX
    this._lastY = e.clientY
    this._yaw   -= dx * LOOK_SPEED
    this._pitch -= dy * LOOK_SPEED
  }

  _onPointerUp() { this._dragging = false }
}
