import * as THREE from 'three'
import { SPECIES, speciesUniformArrays } from './treeSpecies.js'

/**
 * terrainUniforms.js — the forest uniforms of the terrain material that no
 * single row seeds: the two fixed canopy constants and the per-species
 * arrays. Pure data: it only constructs the initial value objects.
 *
 * A uniform with a row in terrainParams.js takes its default from that row
 * (terrain.js seeds it with uniformsFor), so it is not spelled here. The
 * species arrays are built from treeSpecies.js, the same table the species
 * rows are generated from, so each value is still written down once.
 */

// Species uniform arrays, in the shape three wants: one uniform per GLSL
// array, its value a JS array (floats) or an array of THREE.Color (vec3).
function speciesUniforms() {
  const arrays = speciesUniformArrays()
  const out = {}
  for (const [name, values] of Object.entries(arrays)) out[name] = { value: values.slice() }
  out.uSpColor = { value: SPECIES.map(s => new THREE.Color(s.color)) }
  return out
}

/** Fragment-stage forest canopy (see includes/forest.glsl): its fixed
 *  constants and the per-species crown-form/colour arrays it reads. */
export function forestUniforms() {
  return {
    // A crown's reach (species radius × extent) + uForestJitter must stay under
    // the 3-site exactness bound 0.7071 (field units) for the fast path;
    // forest.glsl clamps the realised radius against the 5x5 bound.
    uForestClose:    { value: 0.55 },  // density above this → solid fill (no slider)
    uForestSmooth:   { value: 0.4 },   // smooth-max blend width (no slider)
    // Per-species crown form + colour, as GLSL arrays indexed by species id
    // (the order in treeSpecies.js).
    ...speciesUniforms(),
  }
}
