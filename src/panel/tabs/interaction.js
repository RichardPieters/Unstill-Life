import { MIC_PARAMS } from '../../interaction/interactionParams.js'

// ─── Mic tab: floor/span/tau/curve tuning + live signal readouts ────────────
export function initInteraction(ctx) {
  const { pullControl, debugEl, interaction } = ctx
  const floorId = MIC_PARAMS.find(r => r.key === 'floorDb').id
  // Calibration measures ~1 s of room level and sets the floor itself, not
  // through `params.set`, so no change hook fires: the slider is re-read
  // afterwards so it shows the measured value. (The sliders themselves are
  // generated rows, bound in debugPanel.js.)
  document.getElementById('mic-calibrate').addEventListener('click', async () => {
    await interaction.calibrateFloor()
    pullControl(floorId)
  })

  const fluxGraph = document.getElementById('mic-flux-graph')
  const fluxCtx = fluxGraph.getContext('2d')

  // Wall-clock timer, not dynamics' 'tick': a frozen sim (a painting is up)
  // stops ticking, and the readout would freeze as if the mic had died.
  setInterval(() => {
    if (!debugEl.classList.contains('visible')) return
    const { rms, peak, micDb, flux, restlessness, attention, active } = interaction.getSignals()
    document.getElementById('val-mic-active').textContent = active ? 'on' : 'off'
    document.getElementById('val-mic-rms').textContent = rms.toFixed(5)
    document.getElementById('val-mic-peak').textContent = peak.toFixed(5)
    document.getElementById('val-mic-db').textContent = Number.isFinite(micDb) ? micDb.toFixed(1) : '—'
    document.getElementById('val-mic-flux').textContent = flux.toFixed(4)
    document.getElementById('val-mic-restlessness').textContent = restlessness.toFixed(2)
    document.getElementById('val-mic-attention').textContent = attention.toFixed(2)
    drawFluxGraph(interaction.getFluxHistory())

    const d = interaction.getDiagnostics()
    document.getElementById('val-mic-diag').textContent =
      `calls=${d.sampleCalls} ctx=${d.ctxState} analyser=${d.hasAnalyser} `
      + `track="${d.trackLabel}" ready=${d.trackReadyState} muted=${d.trackMuted} enabled=${d.trackEnabled}`
  }, 100)

  // Auto-scaled sparkline of recent flux — the *dynamic range in the last
  // few seconds*, not calibrated against anything, so a whisper-quiet room
  // still shows a visible line rather than a flat zero.
  function drawFluxGraph(history) {
    const w = fluxGraph.width, h = fluxGraph.height
    fluxCtx.clearRect(0, 0, w, h)
    if (history.length < 2) return
    const max = Math.max(...history, 1e-4)   // floor avoids divide-by-zero on silence
    fluxCtx.strokeStyle = '#6eb5ff'
    fluxCtx.lineWidth = 1.5
    fluxCtx.beginPath()
    history.forEach((v, i) => {
      const x = (i / (history.length - 1)) * w
      const y = h - (v / max) * h
      i === 0 ? fluxCtx.moveTo(x, y) : fluxCtx.lineTo(x, y)
    })
    fluxCtx.stroke()
  }
}
