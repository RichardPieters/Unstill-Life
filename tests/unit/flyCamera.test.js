import { describe, test, expect, vi } from 'vitest'
import * as THREE from 'three'
import { FlyCamera } from '../../src/scene/flyCamera.js'
import { CAM_POSITION } from '../../src/shared/sceneConfig.js'

// FlyCamera.update() and params.set('enabled', …) touch only THREE (position + quaternion) — no
// DOM — so they run under vitest's node env. attach() and the input handlers
// (window/document listeners) are the only DOM-bound parts and are not exercised
// here; we drive the held-key state directly, exactly as the handlers would.

function makeCam() {
  const cam = new THREE.PerspectiveCamera(45, 16 / 9, 0.1, 3000)
  cam.position.set(0, 0, 0)
  cam.lookAt(0, 0, -1)          // face -Z, the plane's default forward
  cam.updateMatrixWorld(true)   // getWorldDirection reads matrixWorld
  return cam
}

describe('FlyCamera.update', () => {
  test('disabled is a no-op (camera never moves)', () => {
    const cam = makeCam()
    const fc = new FlyCamera(cam)
    fc._keys.add('KeyW')
    fc.update(1)
    expect(cam.position.length()).toBe(0)
  })

  test('W drives forward along the facing (-Z) at MOVE_SPEED·dt', () => {
    const cam = makeCam()
    const fc = new FlyCamera(cam)
    fc.params.set('enabled', true)          // seeds yaw=0, pitch=0 from the -Z facing
    fc._keys.add('KeyW')
    fc.update(1)
    expect(cam.position.z).toBeLessThan(0)          // moved forward
    expect(cam.position.x).toBeCloseTo(0)           // no lateral drift
    expect(cam.position.y).toBeCloseTo(0)           // stayed level
    expect(cam.position.length()).toBeGreaterThan(1)
  })

  test('S is the exact opposite of W (symmetric magnitude)', () => {
    const fwd = makeCam(), back = makeCam()
    const f = new FlyCamera(fwd); f.params.set('enabled', true); f._keys.add('KeyW'); f.update(1)
    const b = new FlyCamera(back); b.params.set('enabled', true); b._keys.add('KeyS'); b.update(1)
    expect(back.position.z).toBeCloseTo(-fwd.position.z)
    expect(fwd.position.z).toBeLessThan(0)
  })

  test('Space rises and Shift descends along world-Y', () => {
    const up = makeCam(), down = makeCam()
    const u = new FlyCamera(up); u.params.set('enabled', true); u._keys.add('Space'); u.update(1)
    const d = new FlyCamera(down); d.params.set('enabled', true); d._keys.add('ShiftLeft'); d.update(1)
    expect(up.position.y).toBeGreaterThan(0)
    expect(down.position.y).toBeLessThan(0)
    expect(down.position.y).toBeCloseTo(-up.position.y)
  })

  test('Ctrl boost travels strictly farther than the same key alone', () => {
    const plain = makeCam(), boosted = makeCam()
    const p = new FlyCamera(plain); p.params.set('enabled', true); p._keys.add('KeyW'); p.update(1)
    const b = new FlyCamera(boosted); b.params.set('enabled', true)
    b._keys.add('KeyW'); b._keys.add('ControlLeft'); b.update(1)
    expect(boosted.position.length()).toBeGreaterThan(plain.position.length())
  })

  test('diagonal move is normalized — not faster than a single axis', () => {
    const one = makeCam(), diag = makeCam()
    const o = new FlyCamera(one); o.params.set('enabled', true); o._keys.add('KeyW'); o.update(1)
    const g = new FlyCamera(diag); g.params.set('enabled', true)
    g._keys.add('KeyW'); g._keys.add('KeyD'); g.update(1)
    expect(diag.position.length()).toBeCloseTo(one.position.length())
  })

  test('pitch is clamped below vertical (no gimbal flip)', () => {
    const cam = makeCam()
    const fc = new FlyCamera(cam)
    fc.params.set('enabled', true)
    fc._pitch = 100            // absurd look-up
    fc.update(0)
    expect(Math.abs(fc._pitch)).toBeLessThan(Math.PI / 2)
    const dir = new THREE.Vector3()
    cam.getWorldDirection(dir)
    expect(Number.isNaN(dir.y)).toBe(false)
  })

  test('pitch does not tilt travel — W stays horizontal when looking down', () => {
    const cam = makeCam()
    const fc = new FlyCamera(cam)
    fc.params.set('enabled', true)
    fc._pitch = -1.0            // look steeply down
    fc._keys.add('KeyW')
    fc.update(1)
    expect(cam.position.y).toBeCloseTo(0)            // no vertical drift
    expect(cam.position.z).toBeLessThan(0)           // still moved forward
  })

  test('yaw rotates the travel direction away from the -Z axis', () => {
    const cam = makeCam()
    const fc = new FlyCamera(cam)
    fc.params.set('enabled', true)
    fc._yaw = Math.PI / 2       // turn 90° — forward should become an X axis
    fc._keys.add('KeyW')
    fc.update(1)
    expect(Math.abs(cam.position.x)).toBeGreaterThan(Math.abs(cam.position.z))
  })

  test('disabling restores the authored framing', () => {
    const cam = makeCam()
    const fc = new FlyCamera(cam)
    fc.params.set('enabled', true)
    fc._keys.add('KeyW'); fc.update(1)
    expect(cam.position.length()).toBeGreaterThan(1)
    fc.params.set('enabled', false)
    expect(cam.position.x).toBeCloseTo(CAM_POSITION.x)
    expect(cam.position.y).toBeCloseTo(CAM_POSITION.y)
    expect(cam.position.z).toBeCloseTo(CAM_POSITION.z)
  })
})

describe('FlyCamera F key', () => {
  const press = (fc, code) => fc._onKeyDown({ code, preventDefault() {} })

  test('F toggles the camera on and off', () => {
    vi.stubGlobal('document', { activeElement: null })
    const fc = new FlyCamera(makeCam())
    press(fc, 'KeyF')
    expect(fc.params.get('enabled')).toBe(true)
    press(fc, 'KeyF')
    expect(fc.params.get('enabled')).toBe(false)
    vi.unstubAllGlobals()
  })

  test('F typed into a panel input does not toggle it', () => {
    vi.stubGlobal('document', { activeElement: { tagName: 'INPUT' } })
    const fc = new FlyCamera(makeCam())
    press(fc, 'KeyF')
    expect(fc.params.get('enabled')).toBe(false)
    vi.unstubAllGlobals()
  })
})
