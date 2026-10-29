import * as THREE from 'three'
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js'
import { STATE_FORMAT } from '../shared/uniformSerialize.js'
import { paramAccess } from '../shared/paramAccess.js'
import { uniformsFor } from '../shared/paramSchema.js'
import { writeUniformValue } from '../shared/uniformValue.js'
import { buildLut } from './artPigments.js'
import { ART_ROWS, ART_DEBUG_VIEWS, ART_ENABLED_DEFAULT } from './artPassParams.js'
import { reliefScale, sigmaForMipLevel, prepassSize, paintScale, prepassFraction, texelScale, MIN_CELL_PX } from './artPassMath.js'
import { RevealDirector } from './artPassReveal.js'
import { buildArtMaterials } from './artPassMaterials.js'
import { allocateArtTargets, disposeArtTargets } from './artPassTargets.js'
import { ArtPrepass } from './artPrepass.js'
import { ArtStrokes } from './artStrokes.js'
import { ArtHold } from './artHold.js'

/**
 * artPass.js — the divisionist post-process. Composer pass, appended last.
 *
 * Turns the composited frame into a neo-impressionist painting: the image is
 * rebuilt out of discrete brush marks on a jittered lattice, each carrying one
 * colour drawn from a pigment palette whose weighted mean returns the target
 * exactly, with the surface of the paint itself lit by a lamp fixed to the
 * canvas.
 *
 * STAGES, in order:
 *
 *   prepass   edge field (seed, jump flood, tangent fit) and ground blur, at a
 *             fraction of full resolution so the stroke stage does not redo
 *             their work for every candidate stroke at every pixel; and, once
 *             per entrance, the growth field that orders the strokes' arrival
 *   strokes   a table of every stroke's birth time and anchor (artBirth), the
 *             strokes alone (artPaint, redrawn only where strokes arrived), and
 *             the ground laid underneath them (artCompose)
 *   finish    differentiate the thickness into a normal and light it
 *
 * COST. The stroke pass dominates: every pixel searches 25 candidate strokes at
 * the shipped defaults (9 at reach 1, up to 81), and the second sitting is one
 * more search. It is also the stage that can skip work: during an entrance a
 * frame redraws only the canvas around the strokes that just arrived
 * (artStrokes.js), and a finished picture is held and not redrawn at all.
 *
 * FILES. This one is the orchestrator: the Pass contract, the per-frame render
 * order, the param accessor and the scene snapshot.
 *
 *   artPrepass.js        edge field, ground and growth field builds
 *   artStrokes.js        the stroke target: incremental redraw, ground compose
 *   artHold.js           the held picture and the exit dissolve
 *   artPassReveal.js     entrance/exit state machine; no THREE, injected clock
 *   artPassMaterials.js  the ShaderMaterials and their uniform objects
 *   artPassTargets.js    render-target allocation and pixel formats
 *   artPassMath.js       pure arithmetic: progress curves, jump-flood steps,
 *                        prepass sizing, the redraw decision
 *   artPassParams.js     the slider table the debug panel and this file share
 *   artPigments.js       the pigment palette and the CPU weight-solve LUT
 *   artGBuffer.js        the scene data (depth, normal, water flag) painted from
 *
 * SETTINGS. `artPass.params` (shared/paramAccess.js) over every row of
 * artPassParams.js: `params.set(key, v)` / `params.get(key)`. A row writes its
 * uniform, or is held there (JS-only: durations, the mixture, the ground
 * blur); ART_DERIVED below computes the uniforms that follow from several
 * params; a row's `invalidates` class says what a change makes stale
 * (_invalidate). A colour is '#rrggbb'.
 *
 * PASS CONTRACT. `enabled` starts true (ART_ENABLED_DEFAULT). Assigning it
 * directly snaps to the fully painted state (tests, snapshot restore); only
 * playReveal() / playExit() animate. How the pass and dynamics relate (hold,
 * wake, scene-static) is decided in scene/frameLogic.js.
 *
 * RENDER ORDER, per frame: setSize → reveal.tick → scene uniforms → repaint
 * unless the picture is HELD (prepasses, growth field on an entrance's first
 * frame, strokes, compose, freeze when due) → dissolve while exiting → finish →
 * switch off after an exit's last frame.
 */
export class ArtPass extends Pass {
  /**
   * @param {import('./artGBuffer.js').ArtGBuffer} gbuffer
   * @param {object} [opts]
   * @param {import('../shared/sceneUniforms.js').SceneUniforms} opts.sceneUniforms
   *   the scene-wide set; this pass reads its fog range
   */
  constructor(gbuffer, camera, { sceneUniforms }) {
    super()
    this.enabled = ART_ENABLED_DEFAULT
    this.needsSwap = true

    this._gbuffer = gbuffer
    this._camera = camera
    this._sceneStatic = false
    this._prepassNeedsBuild = true
    this._sizedFor = null
    this._paintScalePin = null   // test hook, see pinPaintScale
    // Optional: called with the program's name (artPassMaterials.js: 'paint',
    // 'dirty', 'birth', …) before each fullscreen draw, so a test can observe
    // which stages ran in a frame.
    this.onDraw = null

    this._buildTextures()
    this._buildMaterials(sceneUniforms)
    // Every setting, by its artPassParams.js key: `artPass.params.set(key, v)`.
    // A row's uniform is one object in every program that reads it, so the
    // first table that has it is the right one to write. The uniforms already
    // hold the rows' defaults (_buildMaterials) and the derived ones are
    // computed here, so nothing is pushed after construction.
    this.params = paramAccess({
      tables:  this._materials.map(m => m.uniforms),
      rows:    ART_ROWS,
      derived: ART_DERIVED,
      onInvalidate: cls => this._invalidate(cls),
    })
    this._rebuildLut()

    this._quad = new FullScreenQuad(null)
    const draw = (renderer, material, target) => this._draw(renderer, material, target)
    const m = this._m
    this._prepass = new ArtPrepass({
      draw, shared: m.shared,
      materials: {
        jfaMat: m.jfaMat, tangentMat: m.tangentMat, groundMat: m.groundMat,
        growthPickMat: m.growthPickMat, growthMat: m.growthMat,
      },
    })
    this._strokes = new ArtStrokes({
      draw, shared: m.shared, getEvenPace: () => this.params.get('revealEvenPace'),
      materials: { paintMat: m.paintMat, birthMat: m.birthMat, dirtyMat: m.dirtyMat, composeMat: m.composeMat },
    })
    this._hold = new ArtHold({
      draw, shared: m.shared,
      materials: { copyMat: m.copyMat, dissolveMat: m.dissolveMat, exitCountMat: m.exitCountMat },
    })

    // The entrance/exit state machine (artPassReveal.js). It writes nothing: it
    // reads the same params as `state`, so the animation and the panel cannot
    // disagree about a duration, and `_applyReveal` copies its `values` into
    // the shared uniforms.
    const state = {}
    for (const key of this.params.keys()) {
      Object.defineProperty(state, key, { get: () => this.params.get(key), enumerable: true })
    }
    this._reveal = new RevealDirector({ getState: () => state })
    this._applyReveal()
  }

  /**
   * Whether the pass draws. Switching it on starts from strokes that may
   * describe a frame that has since passed (the scene can move while the pass
   * is off and never calls render), so they are redrawn.
   */
  get enabled() { return this._enabled }
  set enabled(on) {
    if (on && !this._enabled) this._strokes?.invalidate()
    this._enabled = on
  }

  /**
   * What a param change makes stale, by its row's `invalidates` class
   * (artPassParams.js).
   */
  _invalidate(cls) {
    switch (cls) {
      // A setting that shapes a stroke: the strokes are redrawn whole.
      case 'thaw':    this._thaw(); break
      // A setting only the ground and the surface read: the strokes stand.
      case 'compose': this._thawCompose(); break
      case 'lut':     this._rebuildLut(); break
      // The prepass targets are sized by the scale: reallocate on the next frame.
      case 'resize':  this._sizedFor = null; break
      default: throw new Error(`artPass: unknown invalidation "${cls}"`)
    }
  }

  // ─── reveal and exit ───────────────────────────────────────────────────────
  // The state machine lives in artPassReveal.js; these delegate, because the
  // render loop and the debug panel talk to the pass, not to the director.

  /**
   * Play the entrance animation: the picture is gradually painted rather than
   * appearing all at once. The ONLY path that animates the entrance; see the
   * PASS CONTRACT in the header.
   */
  playReveal() {
    this._reveal.playReveal()
    this._applyReveal()
    this.enabled = true
  }

  /**
   * Play the exit: the painting comes apart as the landscape resumes. The ONLY
   * path that animates the exit; `.enabled = false` anywhere else still snaps
   * the pass off instantly.
   */
  playExit() {
    if (!this.enabled) return
    this._reveal.playExit()
    this._applyReveal()
  }

  /** Whether the entrance animation is currently mid-flight. The render loop
   *  reads this to keep drawing new frames even while the SIMULATION itself is
   *  paused — the landscape can hold still while its own portrait is painted —
   *  and to keep dynamics from waking the scene until the painting is complete.
   *  A pass switched off draws nothing, so its reveal is over whatever the
   *  director still remembers. */
  isRevealPlaying() { return this.enabled && this._reveal.isRevealPlaying() }

  /** Whether the exit animation is mid-flight. Read by the render loop for the
   *  same reason as isRevealPlaying: an animation this pass drives off a wall
   *  clock needs frames to keep coming, whatever the simulation is doing. */
  isExitPlaying() { return this._reveal.isExitPlaying() }

  /** How far the canvas toning has arrived, [0,1]. */
  getPrimeProgress() { return this._reveal.getPrimeProgress() }

  /** How far the marks have arrived, [0,1] — 0 throughout priming. */
  getRevealProgress() { return this._reveal.getRevealProgress() }

  /**
   * The share of the painting's strokes on screen right now, [0,1]. Unlike the
   * reveal's clock progress it follows the bursts of the arrival order (evened
   * by `even pace`), so the sound can match the picture. Falls back to the
   * clock progress when no entrance has baked its arrival times.
   */
  getPaintedFraction() {
    const p = this._reveal.getRevealProgress()
    return this._strokes.paintedFraction(p) ?? p
  }

  /** The share of the painting's strokes that have left, [0,1], 0 outside an
   *  exit. Follows the strokes actually going, which the drift rule makes
   *  uneven, so the sound can match what is seen. */
  getRemovedFraction() { return this._reveal.isExitPlaying() ? this._hold.removed : 0 }

  /** How far the dissolve has run, [0,1]. 0 when no exit is in flight. */
  getExitProgress() { return this._reveal.getExitProgress() }

  /**
   * Whether the scene should be held still right now on the pass's account.
   *
   * True while a RANDOM exit plays: the paint is meant to be gone before the
   * landscape starts moving again, so the picture empties over a scene that is
   * still holding its pose and only then does the world resume. The drift exit
   * is the exact opposite — it has nothing to measure unless the landscape is
   * moving underneath it — so it never asks for this.
   */
  holdsSceneStill() { return this._reveal.isExitPlaying() && this.params.get('exitRandom') }

  // ─── per-frame inputs ──────────────────────────────────────────────────────

  setSize(width, height) {
    const w = Math.max(1, Math.round(width))
    const h = Math.max(1, Math.round(height))
    const scale = this.params.get('prepassScale')
    const key = `${w}x${h}@${scale}`
    if (this._sizedFor === key) return
    this._sizedFor = key

    // The pixel-valued settings follow the buffer (artPassMath.js paintScale).
    this.params.set('paintScale', this._paintScalePin ?? paintScale(w, h))
    const p = prepassSize(w, h, prepassFraction(scale, this.params.get('paintScale')))
    disposeArtTargets(this._targets)
    this._targets = allocateArtTargets(w, h, p)
    // Named handles for the render path, which reads these on every frame.
    this._paintRt = this._targets.paintRt

    this._prepass.resize(this._targets, p, w)
    this._strokes.resize(this._targets.strokeRt, w, h)
    this._hold.resize(this._targets, w, h)
    this._finishMat.uniforms.uRes.value.set(w, h)

    // A resize invalidates whatever was baked at the old resolution. Rebuilt
    // lazily in render(), and only ever while a reveal actually needs it.
    this._reveal.markGrowthStale()
    this._prepassNeedsBuild = true
    // …and throws away whatever was held at the old size, so the picture goes
    // back to being painted live rather than stretched.
    this._reveal.dropHold()
  }

  /**
   * Tell the pass whether the scene behind it is holding still.
   *
   * The edge field, the ground and the strokes are functions of the frame and
   * the G-buffer alone, so while neither is changing they can be built once and
   * reused — which is most of this pass's work. It matters most during the
   * entrance, which plays over a frozen scene whose only moving part is the
   * set of strokes that have arrived.
   *
   * The pass sees a texture, not whether the world behind it moved, so
   * main.js, which knows, says so.
   */
  setSceneStatic(isStatic) {
    if (isStatic === this._sceneStatic) return
    this._sceneStatic = isStatic
    // Coming back to life has to rebuild: whatever is cached describes a
    // moment that has now passed.
    if (!isStatic) {
      this._prepassNeedsBuild = true
      this._strokes.invalidate()
    }
  }

  // ─── render ────────────────────────────────────────────────────────────────

  render(renderer, writeBuffer, readBuffer) {
    this.setSize(readBuffer.width, readBuffer.height)
    this._reveal.tick()
    this._applyReveal()
    this.pushSceneUniforms(readBuffer)

    if (!this._reveal.isHeld()) this._repaint(renderer, readBuffer)

    const paint = this._reveal.isExitPlaying()
      ? this._dissolveAndCount(renderer)
      : (this._reveal.isHeld() ? this._hold.paint : this._paintRt.texture)

    this._finishMat.uniforms.uPaint.value = paint
    this._draw(renderer, this._finishMat, this.renderToScreen ? null : writeBuffer)

    // The exit's last frame has now been drawn, fully dissolved — which is the
    // live landscape and nothing else — so the pass has no more work to do.
    if (this._reveal.isFinished()) {
      this.enabled = false
      this._resetReveal()
    }
  }

  /** One frame of the exit: the picture thinned, and the strokes that have gone
   *  counted for the sound. */
  _dissolveAndCount(renderer) {
    this._hold.countRemoved(renderer, this._strokes.anchorTable())
    return this._hold.dissolve(renderer)
  }

  // ─── inspection ──────────────────────────────────────────────────────────
  // What tests and probes read, so they depend on these names and not on how
  // the pass is put together inside.

  /** The pass's stages, for probes that drive one directly:
   *  { prepass: ArtPrepass, strokes: ArtStrokes, hold: ArtHold }. */
  get stages() { return { prepass: this._prepass, strokes: this._strokes, hold: this._hold } }

  /** The current value of a uniform, by name, in whichever program holds it. */
  uniformValue(name) {
    const m = this._materials.find(mat => name in mat.uniforms)
    return m ? m.uniforms[name].value : undefined
  }

  /** Every program's uniform table, for the snapshot and sharing checks. */
  uniformTables() { return this._materials.map(m => m.uniforms) }

  /** Whether the finished picture is held (served from its copy). */
  isHeld() { return this._reveal.isHeld() }

  /** The finished paint buffer: two attachments, colour with thickness and the
   *  stroke ids. Undefined before the first setSize. */
  get paintTarget() { return this._paintRt }

  /** Blit `texture` into `target` through the pass's own copy program. */
  copyTexture(renderer, texture, target) {
    this._copyMat.uniforms.uSrc.value = texture
    this._draw(renderer, this._copyMat, target)
  }

  /** Replace the clock the entrance and exit run on, `now: () => ms`, for tests
   *  that step time by hand. */
  setClock(now) { this._reveal.setClock(now) }

  /** Use this paint scale in place of the one the buffer size gives
   *  (`null` returns to it), for tests that were tuned at a fixed stroke
   *  density whatever size their window is. Takes effect on the next frame. */
  pinPaintScale(scale) {
    this._paintScalePin = scale
    this._sizedFor = null
  }

  // ─── snapshot ──────────────────────────────────────────────────────────────

  /**
   * { format, params, enabled }: every row by key (the sliders, the colours as
   * '#rrggbb', the radio choices, the toggles, and the held ones: beta, cull,
   * the reveal and exit timings, the ground blur, the edge hold, the prepass
   * scale and the relief height), and the pass's own switch. No uniform is
   * integrated: the reveal's uniforms are rewritten every frame (a snapshot is
   * a still image, restored at rest) and the derived ones follow the rows.
   */
  exportState() {
    return { format: STATE_FORMAT, params: this.params.export(), enabled: this.enabled }
  }

  /**
   * Restore exportState(). Returns { unknown, rejected }.
   */
  importState(state) {
    if (state.format !== STATE_FORMAT) return { unknown: [`artPass.format ${state.format}`], rejected: [] }
    const report = this.params.import(state.params || {})
    if (state.enabled != null) this.enabled = state.enabled
    // Writes the rows did not announce (the prepasses read the uniforms without
    // going through the accessor) leave the cache stale whatever changed.
    this._thaw()
    // A snapshot is a still image, never mid-flight: a reveal uniform from a
    // snapshot taken mid-animation would leave the pass permanently
    // half-painted with no timer left to finish the job. Always land on "fully
    // painted, at rest".
    this._resetReveal()
    return { unknown: report.unknown, rejected: report.rejected }
  }

  dispose() {
    // The sized set goes through the same disposer that allocated it, so a
    // target added there can never be forgotten here.
    disposeArtTargets(this._targets)
    this._prepass.dispose()
    this._hold.dispose()
    this._strokes.dispose()
    for (const m of this._materials) m.dispose()
    this._quad.dispose()
  }

  // ─── construction ──────────────────────────────────────────────────────────

  _buildTextures() {
    const mk = () => {
      const t = new THREE.DataTexture(new Uint8Array(4), 1, 1, THREE.RGBAFormat)
      t.minFilter = t.magFilter = THREE.NearestFilter
      return t
    }
    // NEAREST is not a preference. These hold pigment INDICES, which cannot be
    // interpolated — halfway between pigment 3 and pigment 7 is pigment 5, a
    // different colour entirely, not a blend of the two.
    this._lutIdx = mk()
    this._lutWts = mk()
  }

  /**
   * Build every material (artPassMaterials.js) and keep the handles this class
   * draws with. The scene uniforms come back because render() writes camera and
   * fog into them each frame, and every material shares those objects BY
   * REFERENCE — one write reaches all of them. The fog range among them is the
   * scene-wide one, which the depth normalisation is measured in. The
   * row-backed uniforms are built here from the rows, so they start at the
   * rows' defaults; a colour is a raw Vector3 ('rawRgb').
   */
  _buildMaterials(sceneUniforms) {
    const rawRgb = hex => {
      const u = { value: new THREE.Vector3() }
      writeUniformValue(u, hex)
      return u.value
    }
    const rows = uniformsFor(ART_ROWS, () => true, { rawRgb })
    const m = buildArtMaterials(this._lutIdx, this._lutWts, sceneUniforms.mount(['uFogNear', 'uFogFar']), rows)
    this._m = m
    this._sceneUniforms = m.sceneUniforms
    this._paintMat = m.paintMat
    this._finishMat = m.finishMat
    this._copyMat = m.copyMat
    this._dissolveMat = m.dissolveMat
    this._materials = m.all
  }

  // ─── private: uniforms and derived settings ────────────────────────────────

  /** Hand the animation's current values (RevealDirector.values) to the
   *  programs that read them. The one place the reveal reaches the GPU. */
  _applyReveal() {
    const v = this._reveal.values
    const u = this._m.shared
    u.uRevealSpawn.value = v.spawn
    u.uRevealGround.value = v.ground
    u.uRevealWeave.value = v.weave
    u.uRevealLighten.value = v.lighten
    u.uRevealRelief.value = v.relief
    u.uExitFade.value = v.exitFade
    u.uExitProgress.value = v.exitProgress
  }

  _rebuildLut() {
    const { idx, wts, width, height } = buildLut({ beta: this.params.get('beta'), cull: this.params.get('cull') })
    for (const [tex, data] of [[this._lutIdx, idx], [this._lutWts, wts]]) {
      tex.image = { data, width, height }
      tex.needsUpdate = true
    }
  }

  /** Force every reveal-driven uniform back to "fully painted" and stop any
   *  animation in flight. Construction, importState and a finished exit all
   *  arrive here rather than duplicating the writes. */
  _resetReveal() {
    this._reveal.reset()
    this._applyReveal()
  }

  /**
   * Go back to painting live, because a setting that shapes the strokes
   * changed: they are redrawn whole.
   *
   * Any control that changes what the picture LOOKS like has to land here or in
   * _thawCompose, or the panel would appear dead while the pass sits on a held
   * frame: dragging `stroke size` would move a slider and change nothing on
   * screen. The next frame repaints and, since the reveal is over, immediately
   * holds again — so the painting stays a still image and stays editable at
   * the same time.
   */
  _thaw() {
    this._strokes.invalidate()
    this._thawCompose()
  }

  /** The same for a setting only the ground and the surface read (the colours
   *  the weather drifts, the weave): the held picture is repainted, but the
   *  strokes it is made of stand. */
  _thawCompose() {
    // Unconditional: a control can change the edge field or the ground while
    // the picture is not held at all (the pass simply switched on over a still
    // scene), and the cache has to hear about it either way.
    this._prepassNeedsBuild = true
    this._reveal.thaw()
  }

  // ─── private: render steps ─────────────────────────────────────────────────

  /**
   * Camera and the frame being painted, pushed every frame rather than on
   * change: the camera planes are scene-owned and can move without this pass
   * hearing about it, and one shared uniform object means one write reaches
   * every material that reconstructs depth. (The fog range needs no push: it
   * is the scene-wide object itself.)
   *
   * Called by render(); public so a probe can set a frame up without one.
   */
  pushSceneUniforms(readBuffer) {
    const cam = this._camera
    this._sceneUniforms.uCameraNear.value = cam.near
    this._sceneUniforms.uCameraFar.value = cam.far
    this._sceneUniforms.uGBuffer.value = this._gbuffer.texture
    this._sceneUniforms.uDepth.value = this._gbuffer.depthTexture
    this._m.shared.uBeauty.value = readBuffer.texture
  }

  /**
   * Paint the picture for this frame: prepasses where stale, the strokes
   * brought up to date, the ground laid under them.
   *
   * Only reached while the picture is NOT held. Holding is the whole mechanism
   * behind the exit: a held lattice cannot track a landscape that has started
   * moving again, because nothing is recomputing it. It also means this pass's
   * dominant cost stops being paid every frame while the painting simply sits
   * there.
   */
  _repaint(renderer, readBuffer) {
    const groundMode = this.params.get('groundMode')
    if (this._reveal.needsGrowthBuild()) {
      // The growth field seeds off the edge field, so that has to be current
      // for this frame before the growth can be solved against it.
      this._refreshPrepasses(renderer, groundMode)
      this._prepass.buildGrowthField(renderer)
      this._reveal.onGrowthBuilt()
      // A new arrival order: the strokes' birth times are new.
      this._strokes.invalidate()
    } else if (this._prepassNeedsBuild || !this._sceneStatic) {
      this._refreshPrepasses(renderer, groundMode)
    }
    // A moving scene moves the strokes with it.
    if (!this._sceneStatic) this._strokes.invalidate()

    this._strokes.update(renderer, this._reveal.values.spawn, this._reveal.gatesBirths())
    this._strokes.compose(renderer, this._paintRt)
    if (this._reveal.needsFreeze()) this._freeze(renderer, readBuffer)
  }

  _refreshPrepasses(renderer, groundMode) {
    this._prepass.refresh(renderer, groundMode)
    this._prepassNeedsBuild = false
  }

  _freeze(renderer, readBuffer) {
    this._hold.freeze(renderer, this._paintRt, readBuffer.texture)
    this._reveal.onFrozen()
  }

  /** One fullscreen draw. Every program of this pass writes each pixel of its
   *  target or discards it on purpose, so nothing is cleared: clearing is
   *  wasted work, it would erase the strokes an incremental redraw builds on,
   *  and on the default framebuffer it would throw away what the composer put
   *  there. */
  _draw(renderer, material, target) {
    this.onDraw?.(material.name)
    const autoClear = renderer.autoClear
    renderer.autoClear = false
    this._quad.material = material
    renderer.setRenderTarget(target)
    try {
      this._quad.render(renderer)
    } finally {
      renderer.autoClear = autoClear
    }
  }
}

// ─── derived uniforms ────────────────────────────────────────────────────────

const ART_DEBUG_VIEWS_BY_VALUE = Object.fromEntries(ART_DEBUG_VIEWS.map(v => [v.value, v]))
const viewOf = read => ART_DEBUG_VIEWS_BY_VALUE[read('debugView')] || ART_DEBUG_VIEWS_BY_VALUE[0]

/**
 * Uniforms computed from params, never set directly (paramAccess `derived`):
 * recomputed whenever a key they read from changes.
 *
 *   uHeightScale   relief height tracks the stroke size: the slider names the
 *                  value at the reference cell and reliefScale derives the
 *                  rest, so dragging `stroke size` does not flatten or
 *                  over-emboss the paint as a side effect.
 *   uCellPx, uWeaveScale, uNormalRadius   the stroke size, weave scale and
 *                  relief detail, which the sliders name at the design size
 *                  (artPassMath.js paintScale), times the buffer's paint scale.
 *   uFitRadius, uRevealGrowthReach   prepass-texel quantities, scaled by how
 *                  many texels a design pixel spans (texelScale).
 *   uGroundSigma   the blur slider names a MIP LEVEL; sigmaForMipLevel turns
 *                  it into the gather's Gaussian sigma in buffer pixels, which
 *                  the paint scale and the prepass share then convert to
 *                  prepass texels (the gather runs in its own pixels).
 *   uRespectEdges  mode 1 must not blur across an occlusion edge; mode 3 exists
 *                  in order to. Zeroed here rather than in the shader so the
 *                  slider reads as "how hard the blur is held back" in the one
 *                  mode where that is a question, instead of silently doing
 *                  nothing in the other three.
 *   uDebugView, uOrientMode, uDebug   one Inspect choice (ART_DEBUG_VIEWS);
 *                  an unknown view shows the painting.
 */
const ART_DERIVED = [
  { uniform: 'uHeightScale', from: ['heightScale', 'cell'],
    fn: read => read('heightScale') * reliefScale(read('cell')) },
  { uniform: 'uCellPx', from: ['cell', 'paintScale'],
    fn: read => Math.max(read('cell') * read('paintScale'), MIN_CELL_PX) },
  { uniform: 'uWeaveScale', from: ['weaveScale', 'paintScale'],
    fn: read => read('weaveScale') * read('paintScale') },
  { uniform: 'uNormalRadius', from: ['normalRadius', 'paintScale'],
    fn: read => read('normalRadius') * read('paintScale') },
  { uniform: 'uFitRadius', from: ['edgeFit', 'prepassScale', 'paintScale'],
    fn: read => read('edgeFit') * texelScale(read('prepassScale'), read('paintScale')) },
  { uniform: 'uRevealGrowthReach', from: ['revealGrowthReach', 'prepassScale', 'paintScale'],
    fn: read => read('revealGrowthReach') * texelScale(read('prepassScale'), read('paintScale')) },
  { uniform: 'uGroundSigma', from: ['groundBlur', 'prepassScale', 'paintScale'],
    fn: read => sigmaForMipLevel(read('groundBlur')) * read('paintScale')
      * prepassFraction(read('prepassScale'), read('paintScale')) },
  { uniform: 'uRespectEdges', from: ['keepEdges', 'groundMode'],
    fn: read => (read('groundMode') === 1 ? read('keepEdges') : 0) },
  { uniform: 'uDebugView',  from: ['debugView'], fn: read => viewOf(read).shader },
  { uniform: 'uOrientMode', from: ['debugView'], fn: read => viewOf(read).orient },
  { uniform: 'uDebug',      from: ['debugView'], fn: read => (viewOf(read).shader > 0 ? 1 : 0) },
]
