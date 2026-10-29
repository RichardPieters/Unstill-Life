import { captureScene, applyScene } from '../../scene/sceneSnapshot.js'

// ─── Scene snapshot: export/import the exact visual state as JSON ─────────
// Export fills the text box and copies the JSON; Import applies the box's text.
// `deps` is the module set sceneSnapshot.js captures and restores.
export function initSnapshotButtons(deps) {
  const ta = document.getElementById('snap-json')
  document.getElementById('snap-export').addEventListener('click', async () => {
    const json = JSON.stringify(captureScene(deps), null, 2)
    ta.value = json
    try { await navigator.clipboard.writeText(json) } catch (e) { /* clipboard may be blocked */ }
    console.log('[snapshot] captured (copied to clipboard):\n' + json)
  })
  document.getElementById('snap-import').addEventListener('click', () => {
    const json = ta.value.trim()
    if (!json) return
    try { applyScene(deps, json) } catch (e) { console.warn('[snapshot] import failed:', e) }
  })
}
