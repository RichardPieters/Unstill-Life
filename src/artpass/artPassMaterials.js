import * as THREE from 'three'
import { injectIncludes, mountUniforms } from '../shared/shaderCompose.js'
import { PIGMENTS, hexToLinear, LUT_N } from './artPigments.js'

import quadVert from './shaders/artQuad.vert?raw'
import paintFrag from './shaders/artPaint.frag?raw'
import birthFrag from './shaders/artBirth.frag?raw'
import dirtyFrag from './shaders/artDirty.frag?raw'
import composeFrag from './shaders/artCompose.frag?raw'
import finishFrag from './shaders/artFinish.frag?raw'
import groundFrag from './shaders/artGround.frag?raw'
import edgeJfaFrag from './shaders/artEdgeJfa.frag?raw'
import edgeTangentFrag from './shaders/artEdgeTangent.frag?raw'
import copyFrag from './shaders/artCopy.frag?raw'
import dissolveFrag from './shaders/artDissolve.frag?raw'
import exitCountFrag from './shaders/artExitCount.frag?raw'
import growthPickFrag from './shaders/artGrowthPick.frag?raw'
import growthRelaxFrag from './shaders/artGrowthRelax.frag?raw'
import hashGlsl from './shaders/includes/artHash.glsl?raw'
import colourGlsl from './shaders/includes/artColour.glsl?raw'
import noiseGlsl from './shaders/includes/artNoise.glsl?raw'
import sceneGlsl from './shaders/includes/artScene.glsl?raw'
import strokeGlsl from './shaders/includes/artStroke.glsl?raw'
import formatGlsl from './shaders/includes/artFormat.glsl?raw'
import latticeGlsl from './shaders/includes/artLattice.glsl?raw'
import exitGlsl from './shaders/includes/artExit.glsl?raw'
import frameGlsl from './shaders/includes/artFrame.glsl?raw'
import orientGlsl from './shaders/includes/artOrient.glsl?raw'

/** The GLSL includes, by the name a shader's `//#include name` marker uses. */
const INCLUDES = {
  hash: hashGlsl, colour: hashGlsl + '\n' + colourGlsl, format: formatGlsl, frame: frameGlsl, noise: noiseGlsl,
  scene: sceneGlsl, lattice: latticeGlsl, stroke: strokeGlsl, orient: orientGlsl, exit: exitGlsl,
}

/**
 * artPassMaterials.js — the ShaderMaterials the art pass draws with, and the
 * uniforms they start from.
 *
 * Construction ONLY. Nothing here reads a slider, allocates a render target or
 * draws.
 *
 * A program's source is the one statement of what it reads. Its `//#include`
 * markers say which GLSL it is built from, and its uniforms are then mounted by
 * name from four pools (shared/shaderCompose.js's mountUniforms): the scene
 * set, the param rows (already seeded from their rows, ArtPass builds them),
 * `shared` below, and the program's `own`. A uniform a shader declares that no
 * pool has, or two have, throws here.
 *
 * ONE OBJECT PER NAME. A write or a snapshot restore into any program must
 * reach every program that reads the name, so every pool but `own` is one
 * object per name, mounted in each program that declares it. `shared` holds the
 * frame-level inputs (the frame, the edge field, the ground, the growth field,
 * the lattice tables, the reveal's state); `own` only what is per program: the
 * resolution a pass draws at, the step of a jump flood, the ping-pong source,
 * and the placeholders for the derived uniforms (artPass.params computes them
 * on construction).
 */

/**
 * Cells per axis in the seed-picking reduction (artGrowthPick.frag).
 *
 * This is a coarseness, not a resolution: it sets how big the "darkest patch"
 * the growth starts in has to be. Far higher and the winner is a speck again;
 * far lower and the whole lower third of a landscape is one cell, which says
 * nothing about where in it to start.
 *
 * Declared here because the growth-pick material bakes it into its own uRes;
 * artPassTargets.js and artPrepass.js import it so the target they allocate and
 * read back cannot drift out of step with what the shader was told.
 */
export const PICK_N = 32

/** The palette as one flat vec3 array of linear colours (see artPigments.js). */
function pigmentArray() {
  const flat = new Float32Array(16 * 3)
  PIGMENTS.map(p => hexToLinear(p.h)).forEach((p, i) => flat.set(p, i * 3))
  return flat
}

/**
 * Build every material.
 *
 * @param {THREE.DataTexture} lutIdx  pigment-index LUT, filled by the pass
 * @param {THREE.DataTexture} lutWts  pigment-weight LUT, filled by the pass
 * @param {{uFogNear: object, uFogFar: object}} fog  the scene-wide fog range
 *   objects (shared/sceneUniforms.js), mounted, never copied
 * @param {Record<string, {value: any}>} params  the row-backed uniforms by
 *   name (uniformsFor over artPassParams.js's rows), mounted, never copied
 * @returns {{sceneUniforms: object, shared: object, all: THREE.ShaderMaterial[]}}
 *   plus one entry per material. `sceneUniforms` and `shared` are handed back
 *   because the pass writes into them every frame — see the by-reference note
 *   inside.
 */
export function buildArtMaterials(lutIdx, lutWts, fog, params) {
  const glsl = { glslVersion: THREE.GLSL3, depthTest: false, depthWrite: false }
  const vec2 = () => ({ value: new THREE.Vector2(1, 1) })

  // Camera and fog scalars, shared BY REFERENCE across every material that
  // reconstructs depth (guidelines §8). One write per frame then reaches all
  // of them; copying the values into each material's own uniform object is
  // the exact failure mode that invariant exists to prevent. The fog range is
  // the scene's own (the depth normalisation is measured in it), so it is the
  // scene-wide object terrain and water read, written by the scene set alone.
  const sceneUniforms = {
    uGBuffer:     { value: null },
    uDepth:       { value: null },
    uCameraNear:  { value: 0.1 },
    uCameraFar:   { value: 3000 },
    uFogNear:     fog.uFogNear,
    uFogFar:      fog.uFogFar,
  }

  // What the passes hand each other, one object per name. The textures are
  // rebound as the prepasses rebuild; the numbers are written by the reveal
  // (RevealDirector) and by the derived settings (artPass.js).
  const shared = {
    uBeauty:      { value: null },   // the frame being painted, or the live one in an exit
    uHeldBeauty:  { value: null },   // the frame the held picture was painted from
    uEdgeField:   { value: null },   // edge tangent + distance (jump flood)
    uEdgeFieldScale: { value: 1 },   // prepass resolution / full resolution
    uGround:      { value: null },   // the blurred ground, or null
    uGrowthField: { value: null },   // the reveal's growth field
    uBirthBase:   { value: null },   // the three lattice tables
    uBirthFill:   { value: null },
    uBirthLayer2: { value: null },
    // The entrance animation (playReveal): its rest state is fully painted (1,
    // Lighten 0). Spawn is read by the stroke pass and the dirty mask, Weave by
    // the ground and the finish, Ground and Lighten by the ground, Relief and
    // Fade (the exit's) by the finish.
    uRevealSpawn: { value: 0 }, uRevealGround: { value: 0 }, uRevealWeave: { value: 0 },
    uRevealLighten: { value: 0 }, uRevealRelief: { value: 0 }, uExitFade: { value: 0 },
    uExitProgress: { value: 0 },     // read by the dissolve and the count of what has gone
    // The pixel-valued settings at the buffer's scale (artPass.js ART_DERIVED):
    // the stroke size, weave scale and relief detail in buffer pixels, the
    // tangent smoothing and growth reach in prepass texels.
    uCellPx:      { value: 18 }, uWeaveScale: { value: 3 }, uNormalRadius: { value: 1.25 },
    uFitRadius:   { value: 8 },  uRevealGrowthReach: { value: 260 },
    // Derived from the debug view (artPass.js).
    uDebugView:   { value: 0 }, uOrientMode: { value: 0 },
  }

  /** One fullscreen program: the shader's includes spliced, its uniforms
   *  mounted from the pools by what it declares. */
  const program = (name, source, own = {}) => {
    const fragmentShader = injectIncludes(source, INCLUDES)
    const uniforms = mountUniforms(fragmentShader, { own, shared, scene: sceneUniforms, rows: params }, name)
    return new THREE.ShaderMaterial({ ...glsl, name, vertexShader: quadVert, fragmentShader, uniforms })
  }

  // The stroke pass: strokes only, over no ground (artPaint.frag).
  const paintMat = program('paint', paintFrag, {
    uLutIdx:       { value: lutIdx },
    uLutWts:       { value: lutWts },
    uPigment:      { value: pigmentArray() },
    uPigmentCount: { value: PIGMENTS.length },
    uLutN:         { value: LUT_N },
    uRes:          vec2(),
    // Written per draw: the blocks to redraw, and whether to ignore them.
    uDirty:        { value: null },
    uAllDirty:     { value: 1 },
  })

  // One lattice's table of strokes: birth time and anchor (artBirth.frag).
  // Drawn once per lattice, with that lattice's offset and seed.
  const birthMat = program('birth', birthFrag, {
    uRes:         vec2(),
    uLayerCellPx: { value: 1 },
    uGridOff:     vec2(),
    uSeedOff:     vec2(),
    uBirthGate:   { value: 0 },
  })

  // Which blocks of the canvas a newly arrived stroke can touch (artDirty.frag).
  const dirtyMat = program('dirty', dirtyFrag, { uPrevSpawn: { value: -1 } })

  // The ground under the strokes, the weave, and the diagnostic views
  // (artCompose.frag).
  const composeMat = program('compose', composeFrag, {
    uRes:      vec2(),
    uStrokes:  { value: null },
    uStrokeId: { value: null },
  })

  const finishMat = program('finish', finishFrag, {
    uPaint: { value: null },
    uRes:   vec2(),
    // Derived (artPass.js).
    uHeightScale: { value: 0 }, uDebug: { value: 0 },
  })

  const groundMat = program('ground', groundFrag, {
    uPrev:  { value: null },
    uRes:   vec2(),
    uAxis:  { value: new THREE.Vector2(1, 0) },
    // uGroundSigma and uRespectEdges are derived (artPass.js); the ground
    // build writes uFirstPass per draw.
    uGroundSigma: { value: 0 }, uRespectEdges: { value: 0 }, uFirstPass: { value: 0 },
  })

  // The edge field's first two steps in one program: seed the occlusion edges
  // (uEdgeSeeding 1), then flood them (uEdgeSeeding 0, once per halving step).
  const jfaMat = program('edgeFlood', edgeJfaFrag, {
    uSeed: { value: null }, uRes: vec2(), uStep: { value: 1 }, uEdgeSeeding: { value: 0 },
  })

  const tangentMat = program('edgeTangent', edgeTangentFrag, { uSeed: { value: null }, uRes: vec2() })

  // Where the reveal's growth starts: the darkest block of the frame, found by
  // reducing it to a PICK_N x PICK_N grid of block means and reading those back
  // once per playReveal(). See artGrowthPick.frag and ArtPrepass.
  const growthPickMat = program('growthPick', growthPickFrag, {
    uRes: { value: new THREE.Vector2(PICK_N, PICK_N) },
  })

  // Holding a frame (artCopy.frag) and taking it apart again
  // (artDissolve.frag). Both belong to the EXIT; see ArtHold.
  const copyMat = program('copy', copyFrag, { uSrc: { value: null } })

  const dissolveMat = program('dissolve', dissolveFrag, {
    uHeldPaint:     { value: null },
    // Held from the compose pass's second attachment: R the stroke id, GB its
    // anchor uv. See artPaint.frag's fragId.
    uHeldId:        { value: null },
    // The exit's own previous frame — the ratchet in artDissolve.frag that
    // keeps a gone stroke gone.
    uPrevDissolved: { value: null },
  })

  // Which strokes of the lattice have gone, one texel each, for the sound to
  // follow (artExitCount.frag). Asks the same rule as the dissolve.
  const exitCountMat = program('exitCount', exitCountFrag, {
    uRes:      vec2(),
    uPrevGone: { value: null },
    uHavePrev: { value: 0 },
  })

  // The reveal's growth field: seeded from one point (uGrowthSeeding 1), then
  // relaxed outward (uGrowthSeeding 0, once per halving step). Built once per
  // playReveal() (see ArtPrepass.buildGrowthField), not every frame.
  const growthMat = program('growth', growthRelaxFrag, {
    uPrev: { value: null }, uRes: vec2(), uStep: { value: 1 }, uGrowthSeeding: { value: 0 },
    uSeedPx: { value: new THREE.Vector2(0, 0) },
  })

  // Every material. artPass.params, ArtPass's by-name writes and the snapshot
  // sweep iterate this list; a material with no row-backed uniform is simply
  // not written to. Order does not matter: shared uniform objects hold the same
  // value in every table.
  const all = [paintMat, composeMat, birthMat, dirtyMat, finishMat, groundMat, jfaMat,
    tangentMat, growthPickMat, copyMat, dissolveMat, exitCountMat, growthMat]

  return {
    sceneUniforms, shared, all,
    paintMat, birthMat, dirtyMat, composeMat, finishMat, groundMat, jfaMat,
    tangentMat, growthPickMat, copyMat, dissolveMat, exitCountMat, growthMat,
  }
}
