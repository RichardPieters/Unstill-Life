/**
 * treeSpecies.js — single source of truth for the forest's TREE SPECIES.
 *
 * A species is a crown shape plus a colour. Which species grows where is NOT
 * decided here: it falls out of the biome the tree's root stands on, mapped in
 * one place (`speciesFor` in terrain/shaders/includes/forest.glsl). That is
 * deliberate — placement rules duplicated alongside classify()'s gates drift
 * out of sync with it, so a species owns its LOOK and nothing else.
 *
 * This module is consumed by four places, and is the only place values are
 * written down:
 *   terrainUniforms.js — seeds the `uSp*` uniform ARRAYS (index = species order
 *                    here, which must match forest.glsl's CAN_SPECIES ids)
 *   terrainParams.js — generates one param row per species and property
 *                    (key `sp:<species>:<property>`, an `index` into the
 *                    array) and one crown colour row per species
 *   panel/tabs/species.js — generates one slider group + colour picker per
 *                    species, bound to those rows
 *   forest.glsl    — reads the arrays; CAN_SPECIES must equal SPECIES.length
 *
 * ADDING A SPECIES: append a row to SPECIES, bump CAN_SPECIES in forest.glsl,
 * and add its row to `speciesFor` so some ground actually grows it. The panel,
 * the uniforms, the param rows and the tooltips all follow automatically —
 * nothing in index.html changes. tests/unit/treeSpecies.test.js checks the two
 * counts agree, so a forgotten CAN_SPECIES bump fails in `npm test` rather
 * than silently reading a zeroed array element.
 */

import { PALETTE } from '../shared/palette.js'

/**
 * Per-species crown-form properties. `key` indexes a species' `form` object
 * below AND is the last part of the param key; `uniform` is the GLSL array.
 * min/max/step/digits/label are the panel slider's.
 *
 * NOTE ON RADIUS: each species is clamped against its OWN extent bound in
 * forest.glsl (radius * elongation * lean must fit the candidate set), so a
 * round species can be far wider than a strongly elongated one. That is why
 * radius is per-species rather than global — with one shared clamp, the most
 * elongated species caps the width of every other one.
 */
export const SPECIES_FORM = [
  { key: 'radius',  uniform: 'uSpRadius',  min: 0.2, max: 1.2, step: 0.01, digits: 2,
    label: 'radius',
    tip: 'Crown radius for this species. Clamped against this species\' own reach — a round species can be much wider than a strongly elongated one, because the elongated one spends its budget on length.' },
  { key: 'cone',    uniform: 'uSpCone',    min: 0,   max: 1,    step: 0.05, digits: 2,
    label: 'cone-ness',
    tip: 'Blends the crown between a rounded dome (0) and a cone with a rounded tip (1). Conifers want cone; broadleaves want dome.' },
  { key: 'profile', uniform: 'uSpProfile', min: 0.4, max: 2.5,  step: 0.05, digits: 2,
    label: 'falloff',
    tip: 'How fast the crown falls away from its apex. Below 1 it is fat and shouldered; above 1 it tapers to a narrow top.' },
  { key: 'elong',   uniform: 'uSpElong',   min: 1,   max: 3,    step: 0.05, digits: 2,
    label: 'elongation',
    tip: 'Stretches the crown along the slope\'s fall line, so a tree on a hillside projects like a standing spire instead of a flat disc. 1 = no stretch.' },
  { key: 'lean',    uniform: 'uSpLean',    min: 0,   max: 0.6,  step: 0.05, digits: 2,
    label: 'lean',
    tip: 'Shifts the crown downhill of its trunk, so crowns lean out of the slope rather than sitting symmetrically on it.' },
  { key: 'height',  uniform: 'uSpHeight',  min: 0.2, max: 3,    step: 0.05, digits: 2,
    label: 'height',
    tip: 'How tall this species\' crowns stand — it scales the shading relief, not the geometry, so taller crowns read as a stronger light/shadow swing.' },
  { key: 'wobble',  uniform: 'uSpWobble',  min: 0,   max: 0.6,  step: 0.05, digits: 2,
    label: 'ragged amt',
    tip: 'How deeply the ragged outline bites into this species\' crowns. 0 gives a clean ellipse; higher values give a lumpy, foliage-like edge.' },
  { key: 'wobFreq', uniform: 'uSpWobFreq', min: 1,   max: 7,    step: 0.5,  digits: 1,
    label: 'ragged freq',
    tip: 'How many lobes go around the outline. Low values give a few big bulges; high values give a finer, bushier fringe.' },
  { key: 'sizeVar', uniform: 'uSpSizeVar', min: 0,   max: 0.6,  step: 0.05, digits: 2,
    label: 'size spread',
    tip: 'How much crown size varies tree to tree within this species. 0 makes every crown identical.' },
  { key: 'ampVar',  uniform: 'uSpAmpVar',  min: 0,   max: 0.7,  step: 0.05, digits: 2,
    label: 'height spread',
    tip: 'How much crown height varies tree to tree within this species, so a stand does not read as one uniform tone.' },
]

/**
 * The species themselves. ORDER IS THE GLSL SPECIES ID — index 0 is the
 * default every biome falls back to, so it must stay the hillside conifer.
 */
export const SPECIES = [
  {
    key: 'conifer',
    label: 'conifer',
    tip: 'The default tree — grown on any ground the forest allows that is not a streamside gully floor.',
    color: PALETTE.crown.conifer,
    form: {
      radius: 0.61, cone: 0.60, profile: 1.60, elong: 2.45, lean: 0.25,
      height: 1.50, wobble: 0.60, wobFreq: 3.0, sizeVar: 0.60, ampVar: 0.70,
    },
  },
  {
    key: 'broadleaf',
    label: 'broadleaf',
    tip: 'Gallery forest on damp gully floors — alder and willow rather than spruce. Rounder, wider and taller than the conifers, because a streambank is the best growing site on the mountain.',
    color: PALETTE.crown.broadleaf,
    form: {
      // Round and wide: near-zero cone, a fat shouldered falloff, and almost no
      // fall-line stretch. Low elongation is what buys the width — see the
      // radius note in SPECIES_FORM.
      radius: 0.95, cone: 0.05, profile: 1.0, elong: 1.25, lean: 0.10,
      height: 3.0, wobble: 0.45, wobFreq: 6.0, sizeVar: 0.35, ampVar: 0.45,
    },
  },
]

/** GLSL array names → the flat default arrays terrainUniforms.js seeds uniforms with. */
export function speciesUniformArrays() {
  const out = {}
  for (const p of SPECIES_FORM) out[p.uniform] = SPECIES.map(s => s.form[p.key])
  return out
}
