// ─── Clouds: the grid readout ─────────────────────────────────────────────
// Every cloud control is a cloudParams.js row, generated and bound in debugPanel.js's
// initParamRows.
export function initClouds(ctx) {
  const { clouds } = ctx
  // Derived, not authored: the octave count follows from the draw distance via
  // the window size and the Nyquist limit, so the panel reports it rather than letting it be set.
  function syncCloudReadouts() {
    const cell = document.getElementById('dbg-cvol-cell')
    const oct  = document.getElementById('dbg-cvol-octaves')
    const rad  = document.getElementById('dbg-cvol-radius')
    if (cell) cell.textContent = clouds.getCellSize().toFixed(1)
    if (oct)  oct.textContent  = String(clouds.getOctaves())
    const doc = document.getElementById('dbg-cvol-detail-oct')
    if (doc) doc.textContent = String(clouds.getDetailOctaves())
    if (rad)  rad.textContent  = clouds.getUsableRadius().toFixed(0)
  }
  // Any writer of the grid-shaping rows (the slider, the form walker, a
  // snapshot import) moves the readouts, so they hang off the change hook
  // rather than the sliders' own events.
  for (const key of ['drawDistance', 'baseFreq', 'marchStepSize']) clouds.params.onChange(key, syncCloudReadouts)
  syncCloudReadouts()
}
