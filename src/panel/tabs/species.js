import { SPECIES } from '../../terrain/treeSpecies.js'

// ─── Tree species ────────────────────────────────────────────────────────
// One group per species, generated from treeSpecies.js: adding a species adds
// its controls with no edit to index.html, and none to tooltips.js, whose rows
// for them are generated from the same list. Each control is one terrain param row (terrainParams.js, key
// `sp:<species>:<property>`); panelLayout.js lists a host per species.

/** A heading and an empty param host for each species, appended to `container`. */
export function buildSpeciesHosts(container) {
  if (!container) return
  for (const sp of SPECIES) {
    const head = document.createElement('h4')
    head.className = 'dbg-sub'
    head.textContent = sp.label
    container.appendChild(head)
    const host = document.createElement('div')
    host.dataset.paramGroup = `forest.sp-${sp.key}`
    container.appendChild(host)
  }
}
