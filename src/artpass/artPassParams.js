/**
 * artPassParams.js — single source of truth for every art-pass control, as
 * param rows (shared/paramSchema.js has the shape and every field).
 *
 * Unlike the terrain, water and cloud rows, these are the only place a default
 * lives: the art pass is built FROM this table (its uniforms are seeded from
 * the rows, and `artPass.params` is the accessor over them).
 *
 * The panel generates every row's control from this list (paramPanel.js), so a
 * row's four numbers (min, max, step, value) exist once and cannot drift from
 * the uniform they drive.
 *
 * ART-SPECIFIC FIELDS
 *   group    which panel sub-section it renders under (ART_GROUPS below)
 *   rebuild  which prepass a change invalidates: 'edge' | 'ground' | 'lut'
 *            (absent = live, no prepass to redo). Documentation: the pass
 *            rebuilds both prepasses on every change instead of reading this.
 *
 * INVALIDATION (artPass.js's _invalidate)
 *   thaw     go back to painting live: the strokes are redrawn whole and the
 *            prepasses rebuilt. Every row that shapes a stroke, which is every
 *            row but the exit sliders (those shape the dissolve, which runs off
 *            the held picture, so they must not throw the hold away), the finish rows and the
 *            `compose` ones.
 *   compose  repaint the held picture but keep the strokes it is made of: the
 *            settings only the ground and the canvas surface read (their
 *            colours, which the weather drifts, the ground mode and blur, the
 *            weave). Redrawing every stroke for them would be wasted work.
 *   (none)   the exit sliders and the finish rows (relief height, detail and the
 *            lamp): the finish pass runs every frame over whatever paint is
 *            current, held or live, so nothing needs repainting.
 *   lut      rebuild the pigment lookup (beta, cull)
 *   resize   reallocate the prepass targets on the next frame (prepassScale)
 *
 * The defaults are the tuned lattice settings.
 */
import { rowDefaults } from '../shared/paramSchema.js'

// Every art uniform a slider writes is a GLSL float; colours are '#rrggbb'
// written to a vec3 without colour management (the 'rawRgb' encode).
const art = r => ({ owner: 'artPass', invalidates: 'thaw', ...r })
const slider = r => art({ kind: 'slider', encode: 'float', ...(r.group === 'exit' ? { invalidates: [] } : {}), ...r })
const colour = r => art({ kind: 'colour', encode: 'rawRgb', ...r })
const toggle = r => art({ kind: 'toggle', ...r })
const hidden = r => art({ kind: 'hidden', id: `artPass.${r.key}`, ...r })
const radio = r => art({ kind: 'radio', encode: 'int', ...r })

/** Panel sub-sections, in the order they are rendered. */
export const ART_GROUPS = [
  { id: 'stroke',    title: 'Stroke' },
  { id: 'shape',     title: 'Shape' },
  { id: 'thickness', title: 'Thickness' },
  { id: 'spread',    title: 'Spread' },
  { id: 'finish',    title: 'Finish' },
  { id: 'mixture',   title: 'Mixture' },
  { id: 'ground',    title: 'Ground' },
  { id: 'edges',     title: 'Edges' },
  { id: 'reveal',    title: 'Reveal animation' },
  { id: 'exit',      title: 'Exit animation' },
]

export const ART_PARAMS = [
  // How many drawing-buffer pixels one design pixel is (artPassMath.js's
  // paintScale), set by the pass from its size. The pixel-valued sliders below
  // keep their meaning at the design size; the uniforms the shaders read are
  // those values times this (ART_DERIVED in artPass.js). Not saved: a restore
  // on another window keeps the sliders and takes that window's scale.
  hidden({ key: 'paintScale', encode: 'float', value: 1, persist: false }),

  // ── Stroke — the lattice itself ──────────────────────────────────────────
  { id: 'art-cell', group: 'stroke', key: 'cell',
    label: 'stroke size', min: 3, max: 26, step: 1, value: 18, digits: 0 },
  // Coverage condition: see coverageFloor() in artPassMath.js. Below the floor
  // the lattice leaves holes, which read as flat patches of bare ground.
  { id: 'art-dot-scale', group: 'stroke', key: 'dotScale', uniform: 'uDotScale',
    label: 'dot fill', min: 0.2, max: 3.0, step: 0.01, value: 0.77, digits: 2 },
  { id: 'art-jitter', group: 'stroke', key: 'jitter', uniform: 'uJitter',
    label: 'placement jitter', min: 0, max: 1, step: 0.01, value: 0.56, digits: 2 },
  { id: 'art-aspect', group: 'stroke', key: 'aspect', uniform: 'uAspectRatio',
    label: 'elongation', min: 0.4, max: 4, step: 0.05, value: 1.35, digits: 2 },
  { id: 'art-ground-mix', group: 'stroke', key: 'groundMix', uniform: 'uGroundMix',
    label: 'bare ground', min: 0, max: 0.8, step: 0.01, value: 0.0, digits: 2 },
  { id: 'art-size-depth', group: 'stroke', key: 'sizeDepth', uniform: 'uSizeByDepth',
    label: 'size by depth', min: 0, max: 1, step: 0.05, value: 0.0, digits: 2 },
  { id: 'art-aerial', group: 'stroke', key: 'aerial', uniform: 'uAerial',
    label: 'aerial thinning', min: 0, max: 1, step: 0.05, value: 0.0, digits: 2 },
  { id: 'art-edge-align', group: 'stroke', key: 'edgeAlign', uniform: 'uEdgeAlign',
    label: 'edge alignment', min: 0, max: 1, step: 0.05, value: 1.0, digits: 2 },
  { id: 'art-edge-reach', group: 'stroke', key: 'edgeReach', uniform: 'uEdgeReach',
    label: 'alignment reach', min: 0.2, max: 4, step: 0.1, value: 1.9, digits: 1 },
  { id: 'art-flatten', group: 'stroke', key: 'flatten', uniform: 'uFlatten',
    label: 'flatten source', min: 0, max: 6, step: 0.1, value: 0.0, digits: 1 },
  // A second pass over the same lattice, offset half a cell, with its own
  // randomness: 0 paints none of it, 1 all of it.
  { id: 'art-layer2', group: 'stroke', key: 'layer2', uniform: 'uLayer2',
    label: 'second sitting', min: 0, max: 1, step: 0.01, value: 0.75, digits: 2 },

  // ── Shape — the references are not ellipses ──────────────────────────────
  { id: 'art-shape-n', group: 'shape', key: 'shapeN', uniform: 'uShapeN',
    label: 'roundness → tile', min: 1.2, max: 8, step: 0.1, value: 3.1, digits: 1 },
  { id: 'art-taper', group: 'shape', key: 'taper', uniform: 'uTaper',
    label: 'taper', min: 0, max: 0.9, step: 0.02, value: 0.14, digits: 2 },
  { id: 'art-warp-amp', group: 'shape', key: 'warpAmp', uniform: 'uWarpAmp',
    label: 'shape warp', min: 0, max: 1.2, step: 0.01, value: 0.46, digits: 2 },
  { id: 'art-warp-scale', group: 'shape', key: 'warpScale', uniform: 'uWarpScale',
    label: 'warp scale', min: 0.1, max: 2, step: 0.05, value: 0.9, digits: 2 },
  { id: 'art-ragged', group: 'shape', key: 'ragged', uniform: 'uRagged',
    label: 'ragged rim', min: 0, max: 1.2, step: 0.02, value: 0.28, digits: 2 },
  { id: 'art-ragged-freq', group: 'shape', key: 'raggedFreq', uniform: 'uRaggedFreq',
    label: 'rim lobes', min: 0, max: 2, step: 0.05, value: 1.55, digits: 2 },

  // ── Thickness — height accumulates over every stroke reaching a pixel ────
  { id: 'art-thick-base', group: 'thickness', key: 'thickBase', uniform: 'uThickBase',
    label: 'paint thickness', min: 0, max: 2, step: 0.02, value: 0.72, digits: 2 },
  { id: 'art-thick-var', group: 'thickness', key: 'thickVar', uniform: 'uThickVar',
    label: 'thick / thin spread', min: 0, max: 1, step: 0.01, value: 0.38, digits: 2 },
  { id: 'art-rim', group: 'thickness', key: 'rim', uniform: 'uRim',
    label: 'edge rim', min: 0, max: 1.5, step: 0.01, value: 0.74, digits: 2 },
  { id: 'art-dip', group: 'thickness', key: 'dip', uniform: 'uDip',
    label: 'scooped centre', min: 0, max: 1, step: 0.01, value: 0.5, digits: 2 },
  { id: 'art-groove', group: 'thickness', key: 'groove', uniform: 'uGroove',
    label: 'bristle grooves', min: 0, max: 1, step: 0.01, value: 0.59, digits: 2 },
  { id: 'art-groove-freq', group: 'thickness', key: 'grooveFreq', uniform: 'uGrooveFreq',
    label: 'groove count', min: 1, max: 12, step: 0.5, value: 5.5, digits: 1 },

  // ── Spread — one k cannot serve sky and land at once ─────────────────────
  { id: 'art-k-sky', group: 'spread', key: 'kSky', uniform: 'uKSky',
    label: 'sky spread', min: 0, max: 1.2, step: 0.02, value: 0.18, digits: 2 },
  { id: 'art-k-water', group: 'spread', key: 'kWater', uniform: 'uKWater',
    label: 'water spread', min: 0, max: 1.2, step: 0.02, value: 0.16, digits: 2 },
  // Land blends from its near value to its far one by distance (0 at the fog's
  // near plane, 1 at its far plane).
  { id: 'art-k-land-near', group: 'spread', key: 'kLandNear', uniform: 'uKLandNear',
    label: 'land spread near', min: 0, max: 1.2, step: 0.01, value: 0.35, digits: 2 },
  { id: 'art-k-land-far', group: 'spread', key: 'kLandFar', uniform: 'uKLandFar',
    label: 'land spread far', min: 0, max: 1.2, step: 0.01, value: 0.1, digits: 2 },
  { id: 'art-dark-quiet', group: 'spread', key: 'darkQuiet', uniform: 'uDarkQuiet',
    label: 'quiet the darks', min: 0, max: 1, step: 0.02, value: 1, digits: 2 },
  { id: 'art-tint', group: 'spread', key: 'tint', uniform: 'uTint',
    label: 'tint range', min: 0, max: 0.4, step: 0.005, value: 0.0, digits: 3 },
  { id: 'art-load', group: 'spread', key: 'load', uniform: 'uLoad',
    label: 'load range', min: 0, max: 0.5, step: 0.005, value: 0.295, digits: 3 },

  // ── Finish — the painting's own surface, not the depicted scene ──────────
  { id: 'art-weave', group: 'finish', key: 'weave', invalidates: 'compose', uniform: 'uWeave',
    label: 'canvas weave', min: 0, max: 1, step: 0.02, value: 1.0, digits: 2 },
  { id: 'art-weave-scale', group: 'finish', key: 'weaveScale', invalidates: 'compose',
    label: 'weave scale', min: 1, max: 12, step: 0.5, value: 3.0, digits: 1 },
  { id: 'art-weave-depth', group: 'finish', key: 'weaveDepth', invalidates: [], uniform: 'uWeaveDepth',
    label: 'weave depth', min: 0, max: 1, step: 0.02, value: 0.12, digits: 2 },
  // Set at the reference stroke size; reliefScale() derives every other size,
  // so changing stroke size does not change how thick paint looks. The shader
  // reads uHeightScale, derived from this and `cell` (artPass.js).
  { id: 'art-height-scale', group: 'finish', key: 'heightScale', invalidates: [],
    label: 'relief height', min: 0, max: 3, step: 0.05, value: 0.35, digits: 2 },
  { id: 'art-normal-radius', group: 'finish', key: 'normalRadius', invalidates: [],
    label: 'relief detail', min: 0.5, max: 6, step: 0.25, value: 1.25, digits: 2 },
  { id: 'art-light-az', group: 'finish', key: 'lightAz', invalidates: [], uniform: 'uLightAz',
    label: 'lamp direction', min: 0, max: 6.28, step: 0.05, value: 1.35, digits: 2 },
  { id: 'art-light-el', group: 'finish', key: 'lightEl', invalidates: [], uniform: 'uLightEl',
    label: 'lamp height', min: 0.05, max: 1.5, step: 0.05, value: 0.50, digits: 2 },
  { id: 'art-ambient', group: 'finish', key: 'ambient', invalidates: [], uniform: 'uAmbient',
    label: 'ambient', min: 0, max: 1, step: 0.02, value: 0.56, digits: 2 },
  { id: 'art-diffuse', group: 'finish', key: 'diffuse', invalidates: [], uniform: 'uDiffuse',
    label: 'diffuse strength', min: 0, max: 3, step: 0.05, value: 1.1, digits: 2 },
  { id: 'art-specular', group: 'finish', key: 'specular', invalidates: [], uniform: 'uSpecular',
    label: 'specular', min: 0, max: 1, step: 0.01, value: 0.12, digits: 2 },
  { id: 'art-spec-power', group: 'finish', key: 'specPower', invalidates: [], uniform: 'uSpecPower',
    label: 'gloss', min: 2, max: 120, step: 1, value: 57, digits: 0 },
  { id: 'art-crevice', group: 'finish', key: 'crevice', invalidates: [], uniform: 'uCrevice',
    label: 'crevice shadow', min: 0, max: 1, step: 0.02, value: 0, digits: 2 },
  { id: 'art-high-key', group: 'finish', key: 'highKey', invalidates: [], uniform: 'uHighKey',
    label: 'high key', min: 0, max: 1, step: 0.02, value: 0.0, digits: 2 },

  // ── Mixture — the pigment solve's own knobs. Rebuilding the lookup is a
  //    CPU pass over LUT_N³ entries, so both are debounced by the panel.
  { id: 'art-beta', group: 'mixture', key: 'beta',
    label: 'pigments β', min: 0, max: 1, step: 0.01, value: 0.8, digits: 2, rebuild: 'lut', invalidates: ['thaw', 'lut'] },
  { id: 'art-cull', group: 'mixture', key: 'cull',
    label: 'families', min: 0.002, max: 0.09, step: 0.002, value: 0.01, digits: 3, rebuild: 'lut', invalidates: ['thaw', 'lut'] },

  // ── Ground — what lies under the paint ───────────────────────────────────
  // A mip level; the shader reads uGroundSigma, derived from this and
  // `prepassScale` (artPass.js).
  { id: 'art-ground-blur', group: 'ground', key: 'groundBlur', invalidates: 'compose',
    label: 'ground blur', min: 0, max: 9, step: 0.2, value: 4.8, digits: 1, rebuild: 'ground' },

  // ── Edges — the occlusion-edge distance field ────────────────────────────
  { id: 'art-edge-tau', group: 'edges', key: 'edgeTau', uniform: 'uEdgeTau',
    label: 'edge threshold', min: 0.01, max: 0.6, step: 0.01, value: 0.10, digits: 2, rebuild: 'edge' },
  { id: 'art-edge-fit', group: 'edges', key: 'edgeFit',
    label: 'tangent smoothing', min: 2, max: 24, step: 1, value: 8, digits: 0, rebuild: 'edge' },
  // Reaches the shader as uRespectEdges, and only in the blurred ground mode
  // (artPass.js).
  { id: 'art-keep-edges', group: 'edges', key: 'keepEdges', invalidates: 'compose',
    label: 'blur stops at edges', min: 0, max: 1, step: 0.05, value: 0.6, digits: 2, rebuild: 'ground' },
  { id: 'art-seg-fog', group: 'edges', key: 'segFog', invalidates: 'compose', uniform: 'uSegFog',
    label: 'fog into sky', min: 0, max: 1, step: 0.05, value: 1.0, digits: 2, rebuild: 'ground' },
  // Both prepasses run below full resolution. Neither can resolve the
  // difference: the edge field is only ever read through a smoothstep across a
  // stroke-radius band, and the ground is a blur several pixels wide by
  // construction. Cost is quadratic in this.
  //
  // Measured (1600x900, software rasteriser): this buys most of its saving on the GROUND
  // gather, which costs about three times as much at full resolution as at
  // half. The edge chain's share does not rise above the measurement noise,
  // despite being a dozen fullscreen passes — so if this is ever raised for
  // sharper edges, the gather is what will be paid for, not the flood.
  { id: 'art-prepass-scale', group: 'edges', key: 'prepassScale',
    label: 'prepass resolution', min: 0.25, max: 1, step: 0.05, value: 0.5, digits: 2, rebuild: 'edge', invalidates: ['thaw', 'resize'] },

  // ── Reveal — the entrance animation played by playReveal() ───────────────
  // Not a live gathering/masking parameter of the finished picture: these
  // only matter for the handful of seconds after the pass is switched on.

  // ── Priming — the FIRST step, before any mark exists: the canvas itself
  //    arrives. Sequential with the marks step below, not concurrent with it —
  //    this finishes in full before a single mark is allowed to spawn.
  { id: 'art-reveal-prime-duration', group: 'reveal', key: 'revealPrimeDuration',
    label: 'canvas priming duration (s)', min: 0, max: 10, step: 0.1, value: 1.5, digits: 1 },
  // How far the whole scene lightens toward the ground colour at the END of
  // priming — 0 leaves it untouched, 1 replaces it outright. This is a CEILING
  // on the wash, not the wash itself: the actual amount ramps up smoothly
  // across the priming duration and then HOLDS at this value for the rest of
  // the reveal, the same way a real canvas stays toned once primed rather than
  // reverting the moment the first mark lands.
  { id: 'art-reveal-prime-lighten', group: 'reveal', key: 'revealPrimeLighten',
    label: 'canvas priming lightening', min: 0, max: 1, step: 0.05, value: 0.35, digits: 2 },

  { id: 'art-reveal-duration', group: 'reveal', key: 'revealDuration',
    label: 'reveal duration (s)', min: 0.5, max: 40, step: 0.5, value: 25.5, digits: 1 },
  // The fraction of the reveal spent BLOCKING IN — the opening beat in which
  // only marks sitting hard against an occlusion edge may spawn, so the
  // silhouettes are drawn in before any mass is laid over them. Only has an
  // effect while the `block the edges in first` toggle is on.
  { id: 'art-reveal-edge-beat', group: 'reveal', key: 'revealEdgeBeat', uniform: 'uRevealEdgeBeat',
    label: 'blocking-in beat', min: 0.05, max: 0.5, step: 0.01, value: 0.07, digits: 2 },
  // How far from the camera an edge may be and still be drawn in the blocking-in
  // beat, as a share of the fog range (0 = at the camera, 1 = the fog's far end).
  // 1 draws every edge; lower (default 0.7) leaves distant edges to the growth. Only has an
  // effect while the `block the edges in first` toggle is on.
  { id: 'art-reveal-edge-depth', group: 'reveal', key: 'revealEdgeMaxDepth', uniform: 'uRevealEdgeMaxDepth',
    label: 'blocking-in depth limit', min: 0.05, max: 1, step: 0.01, value: 0.7, digits: 2 },
  // The darks' own blocking-in beat, independent of the edges' one above —
  // see `revealDarksFirst`. Only has an effect while that toggle is on.
  { id: 'art-reveal-dark-beat', group: 'reveal', key: 'revealDarkBeat', uniform: 'uRevealDarkBeat',
    label: 'dark blocking-in beat', min: 0.05, max: 0.5, step: 0.01, value: 0.3, digits: 2 },
  // 0 = pure scatter, every mark's arrival time is an unbiased draw. 1 = a
  // dark mass or a mark sitting on a silhouette always lands ahead of an
  // unbiased one at the same draw — the underpainting-then-drawing order a
  // painter actually works in, not a uniform sprinkle.
  { id: 'art-reveal-bias', group: 'reveal', key: 'revealBias', uniform: 'uRevealBias',
    label: 'darks & edges first', min: 0, max: 1, step: 0.02, value: 1, digits: 2 },
  // How far the growth travels — in effect, how much screen distance it
  // covers — before it fades to nothing. Small values keep the growth tight
  // to its one seed for most of the reveal, so distant areas arrive very
  // late; large values let it reach the far corners of the frame promptly.
  // Baked into the growth field once per playReveal(), so retuning this
  // mid-reveal takes effect on the NEXT activation, not the one in flight.
  { id: 'art-reveal-growth-reach', group: 'reveal', key: 'revealGrowthReach',
    label: 'growth reach', min: 20, max: 800, step: 10, value: 260, digits: 0 },
  // 0 = pure geometric growth, a circle expanding from the seed with no regard
  // for colour at all. Higher makes the front pay a real cost to cross into a
  // differently-coloured area, so it spreads freely through — and stays
  // inside — one colour, and only breaks into the next once nothing similarly
  // coloured and closer is left to grow into. This is the mechanism, not a
  // texture on top of it: turning it up is what keeps a growing patch made of
  // similar colours rather than an even, colour-blind circle.
  { id: 'art-reveal-colour-weight', group: 'reveal', key: 'revealColourWeight', uniform: 'uRevealColourWeight',
    label: 'stick to similar colour', min: 0, max: 8, step: 0.2, value: 7.6, digits: 1 },
  // 0 = the arrival order is entirely the growth field above — the single
  // seed spreading outward. 1 = entirely an independent per-mark draw, a
  // scatter with no spatial order.
  { id: 'art-reveal-growth-jitter', group: 'reveal', key: 'revealGrowthJitter', uniform: 'uRevealGrowthJitter',
    label: 'independent scatter', min: 0, max: 1, step: 0.02, value: 0.1, digits: 2 },
  // 0 = marks arrive at the growth's own pace, in bursts (a flat colour fills in
  // an instant, then the growth waits at a border). 1 = a constant number of
  // marks per second, in the same order. Read when the strokes are baked, so it
  // takes effect on the next redraw of them.
  { id: 'art-reveal-even-pace', group: 'reveal', key: 'revealEvenPace',
    label: 'even pace', min: 0, max: 1, step: 0.02, value: 0.6, digits: 2 },
  // The fraction of the reveal spent transitioning the ground alone, at
  // whichever END the `underpaint before marks` toggle puts it — the start if
  // it's on, the end if it's off.
  { id: 'art-reveal-ground-beat', group: 'reveal', key: 'revealGroundBeat',
    label: 'ground beat', min: 0.05, max: 0.6, step: 0.01, value: 0.15, digits: 2 },

  // ── Exit — the painting coming apart again as the landscape resumes.
  //
  //    The strokes are HELD at this point (see ArtHold.freeze): they are a
  //    still image, and the landscape moving underneath them is a separate,
  //    live picture. A stroke leaves when the landscape has changed enough
  //    underneath it to make it a lie.
  { id: 'art-exit-duration', group: 'exit', key: 'exitDuration',
    label: 'exit duration (s)', min: 1, max: 40, step: 0.5, value: 16, digits: 1 },
  // How far the landscape under a stroke must drift from what that stroke was
  // painted from before the stroke goes. In the frame's own colour units, so
  // a value near 0 lets the faintest movement take a stroke and a large one
  // holds the painting together until the landscape is unrecognisable.
  { id: 'art-exit-threshold', group: 'exit', key: 'exitThreshold', uniform: 'uExitThreshold',
    label: 'drift a stroke survives', min: 0.01, max: 0.6, step: 0.01, value: 0.05, digits: 2 },
  // The fraction of the exit spent revealing the SURFACE BETWEEN strokes —
  // whatever `ground mode` configured it to look like — back to the live
  // frame, before any stroke may start its own fade. A gap pixel has no stroke
  // to draw a fade time from, so this beat is what lets the canvas between
  // strokes settle instead of flicker. See artDissolve.frag's GAPS note.
  { id: 'art-exit-ground-beat', group: 'exit', key: 'exitGroundBeat', uniform: 'uExitGroundBeat',
    label: 'ground reveal beat', min: 0.02, max: 0.4, step: 0.01, value: 0.15, digits: 2 },
  // Spread on that threshold, per stroke, so neighbouring strokes over the
  // same drifting patch do not all leave on the same frame.
  { id: 'art-exit-jitter', group: 'exit', key: 'exitJitter', uniform: 'uExitJitter',
    label: 'stroke-to-stroke spread', min: 0, max: 1, step: 0.02, value: 0.5, digits: 2 },
  // How abruptly one stroke goes once its drift is reached: 0 is a hard cut,
  // higher wipes it out across a wider band of drift.
  { id: 'art-exit-softness', group: 'exit', key: 'exitSoftness', uniform: 'uExitSoftness',
    label: 'stroke exit softness', min: 0.005, max: 0.3, step: 0.005, value: 0.005, digits: 3 },
  // How far into the exit the DRIFT rule still gets to decide on its own —
  // past this point, whatever is STILL standing switches to its own random
  // draw for the rest, same as the RANDOM rule uses throughout, so a calm
  // passage the landscape never disturbs still empties out by the end
  // without every survivor leaving on one shared, synchronised beat. Only
  // does anything under the DRIFT rule — a random exit already guarantees
  // every stroke finishes its own fade by the end (see artExit.glsl),
  // so there is nothing left for this to take over and it sits unused while
  // that is on.
  { id: 'art-exit-sweep', group: 'exit', key: 'exitSweep', uniform: 'uExitSweep',
    label: 'random takeover starts at', min: 0.2, max: 0.95, step: 0.01, value: 0.4, digits: 2 },
  // How long water and clouds take to come back up to speed once a painting
  // stops holding the scene (a drift exit starting, a random exit ending, the
  // checkbox switched off) — the time constant of an exponential ease, so
  // roughly the time to close two thirds of the gap. 0 snaps straight back to
  // full pace. Read by dynamics/animSpeed.js.
  { id: 'art-exit-resume-ease', group: 'exit', key: 'exitResumeEase',
    label: 'landscape resume ease (s)', min: 0, max: 15, step: 0.5, value: 9, digits: 1 },
].map(slider)

/**
 * The binary choices the reveal makes, as checkboxes rather than sliders —
 * each is a shape of the animation, not a tuned quantity.
 *
 * A toggle may name a `uniform` ('float01': written as 0/1), in which case the
 * choice reaches a shader on the very next frame; one without a uniform is
 * held by `artPass.params` and read by RevealDirector's JS-side curves on each
 * tick of the animation it shapes, so it changes an animation in flight and
 * does nothing while none is playing. Every toggle thaws, the exit's included.
 *
 * `edgesFirst`: on (default), the reveal opens by BLOCKING IN — for the first
 * `blocking-in beat` of the animation only marks sitting hard against an
 * occlusion edge may spawn, so the silhouettes are drawn in quickly, the way
 * an artist blocks a canvas out before laying in any mass. Everything else is
 * held back until that beat is over. Off, every mark's turn is decided purely
 * by the growth field and there is no drawing stage at all.
 *
 * `darksFirst`: off (default). On, the darkest marks get
 * their OWN blocking-in beat (`dark blocking-in beat`), independent of the
 * edges' one above: a painter often blocks in the shadow masses before ever
 * touching the silhouette, and the two beats need not agree on how long they
 * take or even both be on at once. Implemented the same way as edgesFirst —
 * a hard, ungrown beat placed in front of the growth field, mixed in AFTER
 * the edges stage rather than merged with it, so either can be switched off
 * without touching the other's look.
 *
 * `underpaintFirst`: on, the ground finishes first (within the `ground beat`
 * fraction above) and marks land on top of it afterward — the traditional
 * lay-in-then-divide order. Off (default), the ground instead finishes LAST:
 * marks arrive over the live frame across the full reveal, and only in the
 * closing `ground beat` does the surface settle into its configured look —
 * so the picture is never seen sitting on bare/toned canvas with nothing
 * painted over it.
 */
export const ART_REVEAL_TOGGLES = [
  { id: 'art-reveal-edges-first', group: 'reveal', key: 'revealEdgesFirst', uniform: 'uRevealEdgesFirst', encode: 'float01',
    label: 'block the edges in first', value: true },
  { id: 'art-reveal-darks-first', group: 'reveal', key: 'revealDarksFirst', uniform: 'uRevealDarksFirst', encode: 'float01',
    label: 'block the darks in first', value: false },
  { id: 'art-reveal-underpaint', group: 'reveal', key: 'revealUnderpaintFirst', encode: 'bool',
    label: 'underpaint before marks (off = ground revealed last)', value: false },
  // `exitRandom`: on, a stroke's turn to go is simply its own random moment in
  // the animation, and the landscape underneath is not consulted at all — the
  // painting thins out evenly and everywhere. Off (default) uses the drift
  // rule: a stroke leaves when the scene under it has
  // moved far enough from what it was painted from, which makes the picture
  // come apart where the landscape is busiest and hold together where it is
  // calm. The four drift sliders do nothing while this is on.
  { id: 'art-exit-random', group: 'exit', key: 'exitRandom', uniform: 'uExitRandom', encode: 'float01',
    label: 'paint just disappears at random', value: false },
].map(toggle)

/** Ground modes, in button order. Matches uGroundMode in artStroke/artGround. */
export const ART_GROUND_MODES = [
  { value: 0, label: 'source' },
  { value: 1, label: 'blurred' },
  { value: 2, label: 'solid' },
  { value: 3, label: 'segment solids' },
]

/**
 * Diagnostic views.
 *
 * `shader` is uDebugView in artPaint.frag; `orient` is uOrientMode. They are
 * separate because "no orientation" is not a diagnostic at all but the painting
 * itself with the orientation field switched off, and it must stay LIT while
 * every diagnostic stays unlit.
 *
 * Anything with shader > 0 replaces the paint outright and is deliberately not
 * shaded — lighting a diagnostic does not merely look odd, it changes the
 * values a probe reads back off the canvas.
 */
export const ART_DEBUG_VIEWS = [
  { value: 0, label: 'painting',          shader: 0, orient: 1 },
  { value: 1, label: 'no orientation',    shader: 0, orient: 0 },
  { value: 2, label: 'orientation field', shader: 1, orient: 1 },
  { value: 3, label: 'depth',             shader: 2, orient: 1 },
  { value: 4, label: 'segments',          shader: 3, orient: 1 },
  { value: 5, label: 'edge field',        shader: 4, orient: 1 },
]

/** Colour swatches: the toned canvas, and one flat colour per segment. */
export const ART_COLORS = [
  { id: 'art-col-ground', key: 'groundColor', invalidates: 'compose', uniform: 'uGroundColor', label: 'solid colour', value: '#84775a', drivenBy: 'weather' },
  { id: 'art-col-sky',    key: 'colSky', invalidates: 'compose',      uniform: 'uColSky',      label: 'sky',          value: '#8fa8c4', rebuild: 'ground', drivenBy: 'weather' },
  { id: 'art-col-land',   key: 'colLand', invalidates: 'compose',     uniform: 'uColLand',     label: 'terrain',      value: '#5c7a3a', rebuild: 'ground' },
  { id: 'art-col-water',  key: 'colWater', invalidates: 'compose',    uniform: 'uColWater',    label: 'water',        value: '#7d93a6', rebuild: 'ground' },
].map(colour)

/**
 * The two one-of-a-set choices; `id` is the radios' shared `name`.
 *
 * groundMode  which ground the paint sits on, by ART_GROUND_MODES' value;
 *             `blurred` at startup.
 * debugView   which ART_DEBUG_VIEWS entry is shown; one choice writes three
 *             uniforms (artPass.js derives them).
 */
export const ART_RADIOS = [
  { id: 'art-ground', group: 'ground', key: 'groundMode', invalidates: 'compose', uniform: 'uGroundMode',
    label: 'ground', value: 1, options: ART_GROUND_MODES },
  { id: 'art-view', key: 'debugView',
    label: 'inspect', value: 0, options: ART_DEBUG_VIEWS },
].map(radio)

/** Every art-pass row: what `artPass.params` is built over. */
export const ART_ROWS = [...ART_PARAMS, ...ART_COLORS, ...ART_REVEAL_TOGGLES, ...ART_RADIOS]

/**
 * The pass is ON at startup: the piece opens as a painting.
 *
 * It replaces the whole picture, so specs that read the landscape itself
 * switch it off first (tests/visual/helpers.js).
 */
export const ART_ENABLED_DEFAULT = true

/** Defaults as a flat {key: value} map. */
export function artDefaults() {
  return rowDefaults(ART_ROWS)
}

/**
 * Every art-pass uniform no row backs, with its snapshot class
 * (shared/uniformSerialize.js). The six derived from rows (uHeightScale,
 * uGroundSigma, uRespectEdges and the three debug-view uniforms) are
 * ART_DERIVED's, the fog range the scene set's.
 */
export const UNIFORM_CLASSES = {
  // The reveal and exit animation: rewritten by the director every frame, and
  // reset to "fully painted, at rest" by a restore (a snapshot is a still image).
  uRevealWeave:   'frame',
  uRevealSpawn:   'frame',
  uRevealGround:  'frame',
  uRevealLighten: 'frame',
  uRevealRelief:  'frame',
  uExitFade:      'frame',
  uExitProgress:  'frame',
  // Per frame and per pass: the frame and G-buffer textures, the camera, the
  // canvas and prepass sizes, the jump-flood and ground-blur step.
  uGBuffer:       'frame',
  uDepth:         'frame',
  uCameraNear:    'frame',
  uCameraFar:     'frame',
  uBeauty:        'frame',
  uGround:        'frame',
  uEdgeField:     'frame',
  uEdgeFieldScale: 'frame',
  uGrowthField:   'frame',
  // The stroke stage: the lattice tables and the mask of blocks to redraw, the
  // table being baked, and the strokes the compose pass lays over the ground.
  uBirthBase:     'frame',
  uBirthFill:     'frame',
  uBirthLayer2:   'frame',
  uBirthGate:     'frame',
  uLayerCellPx:   'frame',
  uGridOff:       'frame',
  uSeedOff:       'frame',
  uPrevSpawn:     'frame',
  uDirty:         'frame',
  uAllDirty:      'frame',
  uStrokes:       'frame',
  uStrokeId:      'frame',
  uPaint:         'frame',
  uPrev:          'frame',
  uSeed:          'frame',
  uSrc:           'frame',
  uSeedPx:        'frame',
  uEdgeSeeding:   'frame',
  uGrowthSeeding: 'frame',
  uHeldPaint:     'frame',
  uHeldId:        'frame',
  uHeldBeauty:    'frame',
  uPrevDissolved: 'frame',
  uPrevGone:      'frame',
  uHavePrev:      'frame',
  uRes:           'frame',
  uAxis:          'frame',
  uFirstPass:     'frame',
  uStep:          'frame',
  // Fixed at construction: the pigment palette and the lookup's size and
  // textures (beta and cull rewrite the texture contents, not the uniforms).
  uLutIdx:        'constant',
  uLutWts:        'constant',
  uPigment:       'constant',
  uPigmentCount:  'constant',
  uLutN:          'constant',
}
