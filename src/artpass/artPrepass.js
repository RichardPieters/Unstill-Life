import { jfaSteps, darkestCell } from './artPassMath.js'
import { PICK_N } from './artPassMaterials.js'
import { allocatePickTarget } from './artPassTargets.js'

/**
 * artPrepass.js — the passes that prepare what the stroke stage reads, each a
 * function of the frame and the G-buffer alone.
 *
 *   edge field    occlusion boundaries, a distance field to them, a tangent fit
 *                 (artEdgeJfa seeds and floods, artEdgeTangent): strokes align to it
 *   ground        the blurred or flat-segment surface under the paint (artGround)
 *   growth field  the reveal's arrival order (artGrowthPick, Seed, Relax)
 *
 * All three run at a FRACTION of full resolution (the `prepass resolution`
 * slider): the edge field is only read through a smoothstep across a
 * stroke-radius band, the ground is a blur several pixels wide, and the growth
 * field is read back as a smoothly varying birth time. Cost is quadratic in the
 * scale.
 *
 * Mechanism only: ArtPass decides WHEN each is stale and rebuilds it. The
 * results are published in the shared uniforms (artPassMaterials.js), which
 * every program that reads them mounts.
 */
export class ArtPrepass {
  /**
   * @param {object} deps
   * @param {(renderer, material, target) => void} deps.draw  fullscreen draw
   * @param {object} deps.materials  jfaMat, tangentMat, groundMat, growthPickMat,
   *   growthMat
   * @param {object} deps.shared     uEdgeField, uGround, uGrowthField, uEdgeFieldScale
   */
  constructor({ draw, materials, shared }) {
    this._draw = draw
    this._m = materials
    this._shared = shared
    // The pick target is a fixed-size reduction of the frame, so it outlives
    // every resize (allocatePickTarget).
    const pick = allocatePickTarget()
    this._pickRt = pick.pickRt
    this._pickBuf = pick.pickBuf
  }

  /**
   * Adopt freshly allocated targets for a new frame size.
   * @param {object} targets  edgeRt[2], tangentRt, groundRt[2], growthRt[2]
   * @param {{width:number,height:number}} prepass  their size
   * @param {number} fullWidth  the frame's width, which the edge field's
   *   distances are scaled back to
   */
  resize(targets, prepass, fullWidth) {
    this._t = targets
    this._size = prepass
    const m = this._m
    for (const mat of [m.groundMat, m.jfaMat, m.tangentMat]) {
      mat.uniforms.uRes.value.set(prepass.width, prepass.height)
    }
    // The edge field stores distances in ITS pixels; without this the reach of
    // every alignment would silently scale with the prepass resolution.
    this._shared.uEdgeFieldScale.value = prepass.width / fullWidth
  }

  /** The edge field and the ground: what the stroke stage reads that follows
   *  the frame. */
  refresh(renderer, groundMode) {
    this.buildEdgeField(renderer)
    this.buildGround(renderer, groundMode)
  }

  /**
   * Seed the occlusion edges, then jump-flood them into a distance field, then
   * fit a tangent to it.
   *
   * The flood's step sequence starts at half the larger axis and halves to 1,
   * which is what makes this O(log N) passes rather than O(N): a seed can
   * travel the whole frame because the first hop is frame-sized.
   */
  buildEdgeField(renderer) {
    const { jfaMat, tangentMat } = this._m
    const edgeRt = this._t.edgeRt
    // The seeding draw reads no previous field, but the sampler is still bound:
    // left pointing at edgeRt[0] by the last flood it would form a feedback loop
    // with the target, WebGL would drop the draw, and the flood would spread the
    // PREVIOUS frame's edges. Whether it does depends on the step count's parity,
    // i.e. on the prepass resolution.
    jfaMat.uniforms.uSeed.value = null
    jfaMat.uniforms.uEdgeSeeding.value = 1
    this._draw(renderer, jfaMat, edgeRt[0])
    jfaMat.uniforms.uEdgeSeeding.value = 0

    let src = 0
    for (const step of jfaSteps(this._size.width, this._size.height)) {
      const dst = 1 - src
      jfaMat.uniforms.uSeed.value = edgeRt[src].texture
      jfaMat.uniforms.uStep.value = step
      this._draw(renderer, jfaMat, edgeRt[dst])
      src = dst
    }

    // Fit a smooth tangent to the seeds. Downstream then needs one fetch
    // instead of a search, and — more importantly — a direction that is not
    // quantised to the handful of integer offsets available at short range.
    tangentMat.uniforms.uSeed.value = edgeRt[src].texture
    this._draw(renderer, tangentMat, this._t.tangentRt)
    this._shared.uEdgeField.value = this._t.tangentRt.texture
  }

  /**
   * Build the ground the strokes are painted over, as two separable passes.
   *
   * Only the two gathered modes need this — `source` is the frame itself and
   * `solid` is one constant, both of which the compose pass produces without
   * help. Skipping it in those modes is most of the pass's cost, not a detail.
   */
  buildGround(renderer, groundMode) {
    if (groundMode !== 1 && groundMode !== 3) {
      this._shared.uGround.value = null
      return
    }
    const { groundMat } = this._m
    const groundRt = this._t.groundRt
    for (const [pass, ax] of [[0, [1, 0]], [1, [0, 1]]]) {
      groundMat.uniforms.uAxis.value.set(ax[0], ax[1])
      groundMat.uniforms.uFirstPass.value = pass === 0 ? 1 : 0
      groundMat.uniforms.uPrev.value = pass === 1 ? groundRt[0].texture : null
      this._draw(renderer, groundMat, groundRt[pass])
    }
    this._shared.uGround.value = groundRt[1].texture
  }

  /**
   * Bake the reveal's growth field: one seed in the frame's darkest block
   * (pickSeedUv), relaxed outward across the same halving sequence the edge
   * field uses, discounted more where the colour changes than where it stays
   * similar. See artGrowthRelax.frag for the maths.
   *
   * Runs at prepass resolution, same as the edge field — for the same reason:
   * it is read back through 1 - alpha as a smoothly varying birth time, not at
   * pixel precision, so the resolution it is solved at cannot show.
   */
  buildGrowthField(renderer) {
    const { growthMat } = this._m
    const growthRt = this._t.growthRt
    const p = this._size
    const seed = this.pickSeedUv(renderer)
    growthMat.uniforms.uRes.value.set(p.width, p.height)
    growthMat.uniforms.uSeedPx.value.set(seed.u * p.width, seed.v * p.height)

    // Same guard as the edge field's seeding: no stale sampler on the target.
    growthMat.uniforms.uPrev.value = null
    growthMat.uniforms.uGrowthSeeding.value = 1
    this._draw(renderer, growthMat, growthRt[0])
    growthMat.uniforms.uGrowthSeeding.value = 0

    // The halving step sequence run ONCE, the way the edge field uses it, is
    // wrong here in a way it is not there. Nearest-SEED-identity is exact
    // under a single large-then-small hop sequence: whichever seed a giant
    // first hop reaches is still the truth, later smaller hops only refine
    // WHICH seed, never invent a wrong one. Accumulated colour-weighted COST
    // has no such guarantee — a giant first hop compares only the colour at
    // its two endpoints, never what lies between them, so a distant patch
    // that merely happens to share the seed's colour can score as "reached"
    // in one jump, regardless of what separates them.
    //
    // Repeating the whole sequence several times is the standard fix (the
    // "JFA+k" refinement): each further round lets a cell reconsider its
    // neighbours' by-then-more-accurate scores, so a falsely high score
    // earned by skipping over an intervening colour boundary gets pulled back
    // down once its neighbours on the near side of that boundary have
    // properly low scores of their own to compare against. Three rounds is
    // the standard number quoted for this refinement; the whole chain still
    // costs a few dozen passes at prepass resolution, in the noise next to
    // the stroke pass itself.
    const steps = jfaSteps(p.width, p.height)
    let src = 0
    for (let round = 0; round < 3; round++) {
      for (const step of steps) {
        const dst = 1 - src
        growthMat.uniforms.uPrev.value = growthRt[src].texture
        growthMat.uniforms.uStep.value = step
        this._draw(renderer, growthMat, growthRt[dst])
        src = dst
      }
    }
    this._shared.uGrowthField.value = growthRt[src].texture
  }

  /**
   * Where the growth starts: the darkest BLOCK of the frame.
   *
   * A painter blocks the darks in first, so that is where the first mark goes.
   * The frame is reduced to a PICK_N x PICK_N grid of block means
   * (artGrowthPick.frag) and the darkest cell wins — a block mean rather than
   * a pixel, because the darkest single pixel is very often an isolated speck
   * with nothing around it to grow into.
   *
   * The readback is synchronous, which stalls the pipeline. That is acceptable
   * here and nowhere near the render loop's hot path: it happens ONCE per
   * playReveal(), on a target of a few hundred bytes, at a moment when the
   * pass is starting a multi-second animation anyway.
   */
  pickSeedUv(renderer) {
    this._draw(renderer, this._m.growthPickMat, this._pickRt)
    renderer.readRenderTargetPixels(this._pickRt, 0, 0, PICK_N, PICK_N, this._pickBuf)
    return darkestCell(this._pickBuf, PICK_N, PICK_N)
  }

  dispose() { this._pickRt.dispose() }
}
