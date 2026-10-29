import * as THREE from 'three'
import { PICK_N } from './artPassMaterials.js'
import { latticeTableSize, dirtyBlocks } from './artPassMath.js'

/**
 * artPassTargets.js — every render target the art pass draws into.
 *
 * Mechanism only: it allocates and disposes, and decides nothing. Whether a
 * resize is needed and which size-dependent uniforms follow it are artPass.js's
 * setSize. The pixel formats are the load-bearing part; the reasoning for each
 * is on its allocation.
 */

/** Free a previously-allocated set. Tolerates nulls and arrays. */
export function disposeArtTargets(targets) {
  if (!targets) return
  for (const t of Object.values(targets)) {
    if (!t || typeof t === 'number') continue
    if (Array.isArray(t)) { for (const r of t) r?.dispose?.() } else t.dispose?.()
  }
}

/**
 * Allocate the full-resolution and prepass-resolution targets.
 *
 * The pick target is deliberately NOT here: it is a fixed-size reduction of the
 * frame that survives every resize, so the pass allocates it once and keeps it.
 *
 * @param {number} width   full output width, already rounded and floored at 1
 * @param {number} height  full output height, same
 * @param {{width:number,height:number}} prepass  the reduced size (prepassSize)
 */
export function allocateArtTargets(width, height, prepass) {
  const p = prepass

  // RGBA8 and NEAREST throughout the edge chain. These targets hold pixel
  // COORDINATES split across byte pairs, and interpolating the bytes
  // independently is meaningless: halfway between high bytes 0 and 1 is 0.5,
  // which decodes to 128 pixels away, not to half a pixel.
  const byteRt = () => new THREE.WebGLRenderTarget(p.width, p.height, {
    minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false,
  })
  // The ground is a colour and IS interpolated — it is sampled at full
  // resolution from a target built at a fraction of it, so linear filtering is
  // what makes the upsample invisible rather than blocky.
  const groundRt = () => new THREE.WebGLRenderTarget(p.width, p.height, {
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false,
  })
  // Half-float, because the alpha channel carries accumulated paint thickness
  // and this buffer exists in order to be DIFFERENTIATED. An 8-bit height
  // differentiates into visible terracing — stair-stepped relief across every
  // stroke — which is precisely what the finish pass would then light. The
  // composer's own targets are already half-float, so this asks for nothing the
  // app did not already require.
  const paintTarget = () => new THREE.WebGLRenderTarget(width, height, {
    type: THREE.HalfFloatType,
    minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false,
  })

  return {
    edgeRt: [byteRt(), byteRt()],
    tangentRt: byteRt(),
    groundRt: [groundRt(), groundRt()],
    // Colour AND score both benefit from smooth interpolation between cells —
    // unlike the edge chain's packed pixel coordinates, nothing here is split
    // across bytes in a way interpolation would corrupt.
    growthRt: [groundRt(), groundRt()],
    // Two attachments, written by the compose pass: RGBA colour+height (.texture
    // / .textures[0]) and a second carrying which stroke owns each pixel and
    // where it was anchored — see artCompose.frag. Only the LIVE target needs
    // both; everything downstream only needs a frozen COPY of the id.
    paintRt: new THREE.WebGLRenderTarget(width, height, {
      type: THREE.HalfFloatType,
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false,
      count: 2,
    }),
    // The strokes alone, over no ground: the same two half-float attachments as
    // the paint target (artPaint.frag's outputs). Kept between frames and drawn
    // into without clearing during an entrance, so it is the one target whose
    // old contents matter.
    strokeRt: new THREE.WebGLRenderTarget(width, height, {
      type: THREE.HalfFloatType,
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false,
      count: 2,
    }),
    // Where the picture is HELD once it is finished: the lattice itself, the
    // frame it was painted from (which the exit measures drift against), and
    // which stroke owns each pixel. Same format as the paint target — the held
    // lattice IS a paint buffer, and the held frame comes from a half-float
    // composer target.
    heldPaintRt: paintTarget(),
    heldBeautyRt: paintTarget(),
    heldIdRt: paintTarget(),
    // The dissolve's own per-frame output. NOT paintRt: that one is MRT
    // (count: 2) for the paint material's two attachments, and the dissolve
    // material writes one. A single-output material drawn into a 2-attachment
    // target leaves the second attachment's draw-buffer state interfering with
    // the write, and the dissolved picture silently stops updating.
    dissolveOutRt: paintTarget(),
    // The exit's memory of what it has already taken away (the ratchet in
    // artDissolve.frag; seeded by ArtHold.freeze, refreshed by ArtHold.dissolve). Same
    // format: it holds a copy of the paint buffer, one frame further along.
    dissolvePrevRt: paintTarget(),
  }
}

/**
 * The lattice tables and the dirty mask, sized for a frame and a stroke size.
 *
 * Each table (artBirth.frag) holds one cell per texel: its birth time and its
 * anchor in pixels, which can be 1920 and so need full floats. The dirty mask
 * (artDirty.frag) is one texel per block of `cellPx` pixels. Both are small
 * (a few thousand texels at the default stroke size), and their size follows
 * the stroke size, so the stroke driver reallocates them when that changes.
 *
 * @param {number} width   full output width
 * @param {number} height  full output height
 * @param {number} cellPx  the lattice spacing
 */
export function allocateLatticeTargets(width, height, cellPx) {
  const exact = (w, h, type) => new THREE.WebGLRenderTarget(w, h, {
    type, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false,
  })
  const table = scale => exact(
    latticeTableSize(width, cellPx * scale), latticeTableSize(height, cellPx * scale), THREE.FloatType)
  return {
    birthBase: table(1),
    // The depth in-fill: the same strokes on a lattice at half the spacing.
    birthFill: table(0.5),
    birthLayer2: table(1),
    dirtyRt: exact(dirtyBlocks(width, cellPx), dirtyBlocks(height, cellPx), THREE.UnsignedByteType),
  }
}

/**
 * The fixed-size seed-picking target, plus the buffer its readback lands in.
 *
 * Fixed size deliberately: this is a REDUCTION of the frame, so how many cells
 * it has is a property of how coarse a patch the seed should land in, not of
 * how big the window is — which is why it outlives every resize.
 */
export function allocatePickTarget() {
  return {
    pickRt: new THREE.WebGLRenderTarget(PICK_N, PICK_N, {
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false,
    }),
    pickBuf: new Uint8Array(PICK_N * PICK_N * 4),
  }
}
