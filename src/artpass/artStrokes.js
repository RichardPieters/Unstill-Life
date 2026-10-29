import * as THREE from 'three'
import { strokeRedraw, dirtyBlocks, inFrameBirths, shareAtOrBelow, evenPaced } from './artPassMath.js'
import { allocateLatticeTargets } from './artPassTargets.js'

/**
 * artStrokes.js — the stroke stage: keeps the strokes drawn and puts them over
 * the ground.
 *
 * THE STROKES. The picture is a lattice of strokes, each a pure function of its
 * cell and the frame, with a birth time during the entrance. `update` brings a
 * target of the strokes alone (artPaint.frag) to what a full redraw would draw
 * at the current reveal progress, and does the least work that gets there:
 *
 *   none         the target already shows this progress
 *   incremental  strokes were born since the last frame: redraw only the blocks
 *                of canvas those can touch (artDirty.frag), into the same
 *                target, leaving every other pixel as it was
 *   full         nothing valid to build on: bake the lattice tables
 *                (artBirth.frag) and redraw every pixel
 *
 * A reveal is therefore one full redraw at its start and then, per frame, the
 * few blocks around the strokes that just appeared. The redraw is exact, not an
 * approximation: a redrawn pixel is computed over every stroke born so far, so
 * the target equals the full redraw pixel for pixel (tests/visual/
 * art_pass_incremental.spec.js proves it against a full redraw).
 *
 * WHAT MAKES THE TARGET STALE. Anything a stroke is computed from: the frame
 * and G-buffer (the scene moving), the edge field, any setting that shapes a
 * stroke, a resize, a new growth field. The pass calls `invalidate()` for each;
 * the next `update` is a full redraw. The ground, the canvas weave and the
 * reveal's wash are NOT stroke inputs, which is the reason the ground is laid
 * under the strokes in a separate pass (`compose`): they change every frame of
 * an entrance without costing a stroke.
 *
 * Mechanism, not policy: ArtPass says when the target is stale.
 */
export class ArtStrokes {
  /**
   * @param {object} deps
   * @param {(renderer, material, target) => void} deps.draw  fullscreen draw
   * @param {object} deps.materials  paintMat, birthMat, dirtyMat, composeMat
   * @param {object} deps.shared     the lattice-table uniforms
   * @param {() => number} deps.getEvenPace  how far arrival times are evened out
   */
  constructor({ draw, materials, shared, getEvenPace }) {
    this._getEvenPace = getEvenPace
    this._paced = null
    // The sorted birth times of the strokes on screen, as the tables hold them;
    // null when no reveal is playing.
    this._births = null
    this._draw = draw
    this._m = materials
    this._shared = shared
    this._strokeRt = null
    this._lattice = null
    this._latticeKey = null
    this._size = { width: 1, height: 1 }
    // The reveal progress the stroke target shows; null when it shows nothing
    // valid. See strokeRedraw for the encoding.
    this._shown = null
  }

  /** The stroke target and the frame it is the size of. A new size is a new
   *  target, which shows nothing. */
  resize(strokeRt, width, height) {
    this._strokeRt = strokeRt
    this._size = { width, height }
    this._shown = null
    this._m.paintMat.uniforms.uRes.value.set(width, height)
    this._m.birthMat.uniforms.uRes.value.set(width, height)
    this._m.composeMat.uniforms.uRes.value.set(width, height)
  }

  /** The reveal progress the stroke target shows; null when it shows nothing
   *  valid (see strokeRedraw). */
  get shown() { return this._shown }

  /** The stroke target: premultiplied paint and stroke ids, no ground. */
  get strokeTarget() { return this._strokeRt }

  /** The target no longer shows what a redraw would draw: redraw it whole. */
  invalidate() { this._shown = null }

  /**
   * Bring the stroke target to reveal progress `spawn`.
   * @param {number} spawn   the reveal's progress; 1 at rest
   * @param {boolean} births whether a reveal is playing, so strokes have birth
   *   times. At rest every stroke is born, and the tables need not work them out.
   */
  update(renderer, spawn, births) {
    const plan = strokeRedraw(this._shown, spawn)
    if (plan.mode === 'none') return
    this._shared.uRevealSpawn.value = spawn
    const { paintMat, dirtyMat } = this._m

    if (plan.mode === 'full') {
      this._bakeTables(renderer, births)
      paintMat.uniforms.uAllDirty.value = 1
    } else {
      dirtyMat.uniforms.uPrevSpawn.value = this._shown
      this._draw(renderer, dirtyMat, this._lattice.dirtyRt)
      paintMat.uniforms.uDirty.value = this._lattice.dirtyRt.texture
      paintMat.uniforms.uAllDirty.value = 0
    }
    this._draw(renderer, paintMat, this._strokeRt)
    this._shown = plan.target
  }

  /**
   * The fraction of the strokes that are on screen at reveal progress `p`, or
   * null when no reveal has baked its arrival times. What the sound follows, so
   * it matches what is seen, burst for burst.
   */
  paintedFraction(p) {
    return this._births ? shareAtOrBelow(this._births, p) : null
  }

  /**
   * The base lattice's table, for what needs each stroke's anchor (the count of
   * strokes leaving in the exit): its texture and size, and the frame in cells.
   */
  anchorTable() {
    const t = this._shared.uBirthBase.value
    const cellPx = this._m.paintMat.uniforms.uCellPx.value
    return {
      texture: t, width: t.image.width, height: t.image.height,
      cellsX: dirtyBlocks(this._size.width, cellPx), cellsY: dirtyBlocks(this._size.height, cellPx),
    }
  }

  /** Lay the strokes over the ground into `target` (the paint target). */
  compose(renderer, target) {
    const u = this._m.composeMat.uniforms
    u.uStrokes.value = this._strokeRt.textures[0]
    u.uStrokeId.value = this._strokeRt.textures[1]
    this._draw(renderer, this._m.composeMat, target)
  }

  /** One table per lattice: the base one, the depth in-fill at half the
   *  spacing, the second sitting offset by half a cell with its own seed.
   *  These offsets are the ones artPaint.frag's main() gives each layer. */
  _bakeTables(renderer, births) {
    this._ensureLattice()
    const { birthMat } = this._m
    const cellPx = this._m.paintMat.uniforms.uCellPx.value
    const u = birthMat.uniforms
    u.uBirthGate.value = births ? 1 : 0
    const bake = (target, cell, gridOff, seedOff) => {
      u.uLayerCellPx.value = cell
      u.uGridOff.value.set(gridOff[0], gridOff[1])
      u.uSeedOff.value.set(seedOff[0], seedOff[1])
      this._draw(renderer, birthMat, target)
    }
    const l = this._lattice
    bake(l.birthBase, cellPx, [0, 0], [0, 0])
    bake(l.birthFill, cellPx * 0.5, [0, 0], [0, 0])
    bake(l.birthLayer2, cellPx, [0.5, 0.5], [9137, 4271])
    const textures = births ? this._evenOut(renderer) : [l.birthBase, l.birthFill, l.birthLayer2].map(t => t.texture)
    if (!births) this._births = null
    this._shared.uBirthBase.value = textures[0]
    this._shared.uBirthFill.value = textures[1]
    this._shared.uBirthLayer2.value = textures[2]
  }

  /**
   * Even out the arrival times of the baked tables (evenPaced), and record the
   * times the picture will actually follow. The distribution is the base
   * lattice's, applied to all three tables: the in-fill and second sitting draw
   * their strokes from the same picture.
   *
   * Reads the tables back (a few thousand texels) once per bake, which is once
   * per entrance. When the pace is raw (0) the baked tables are used as they are.
   */
  _evenOut(renderer) {
    const l = this._lattice
    const read = rt => {
      const buf = new Float32Array(rt.width * rt.height * 4)
      renderer.readRenderTargetPixels(rt, 0, 0, rt.width, rt.height, buf)
      return buf
    }
    const cellPx = this._m.paintMat.uniforms.uCellPx.value
    const cellsX = dirtyBlocks(this._size.width, cellPx)
    const cellsY = dirtyBlocks(this._size.height, cellPx)
    const base = read(l.birthBase)
    const sorted = inFrameBirths(base, l.birthBase.width, l.birthBase.height, cellsX, cellsY)
    const even = this._getEvenPace()
    // Evening is non-decreasing, so the sorted list stays sorted.
    this._births = sorted.map(b => evenPaced(b, sorted, even))
    if (even <= 0) return [l.birthBase, l.birthFill, l.birthLayer2].map(t => t.texture)

    this._disposePaced()
    this._paced = [[l.birthBase, base], [l.birthFill, null], [l.birthLayer2, null]].map(([rt, data]) => {
      const buf = data || read(rt)
      for (let i = 0; i < buf.length; i += 4) buf[i] = evenPaced(buf[i], sorted, even)
      const tex = new THREE.DataTexture(buf, rt.width, rt.height, THREE.RGBAFormat, THREE.FloatType)
      tex.minFilter = tex.magFilter = THREE.NearestFilter
      tex.needsUpdate = true
      return tex
    })
    return this._paced
  }

  _disposePaced() {
    for (const t of this._paced || []) t.dispose()
    this._paced = null
  }

  /** The tables' size follows the stroke size and the frame: reallocate when
   *  either changed. */
  _ensureLattice() {
    const { width, height } = this._size
    const cellPx = this._m.paintMat.uniforms.uCellPx.value
    const key = `${width}x${height}@${cellPx}`
    if (key === this._latticeKey) return
    this._disposeLattice()
    this._lattice = allocateLatticeTargets(width, height, cellPx)
    this._latticeKey = key
  }

  _disposeLattice() {
    if (!this._lattice) return
    for (const t of Object.values(this._lattice)) t.dispose()
    this._lattice = null
    this._latticeKey = null
  }

  dispose() { this._disposeLattice(); this._disposePaced() }
}
