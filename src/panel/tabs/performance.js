// ─── Performance tab ──────────────────────────────────────────────────────
//
// Two halves (see perfMath.js for why):
//   Frame — always on: fps, typical and slowest-5% frame time over the last
//     ~2 s, what is being drawn, and the CPU's own share.
//   Cost per part — on demand: costMeasure.js switches each part off and on
//     and reports what it costs. The parts and their switches come from
//     main.js (`perf`), which owns the modules and the render loop.
//
// The pixel-ratio slider lives here too (src/render/pixelRatio.js); it is not
// a uniform, so it goes through main.js's `display.params`.
import { frameStats } from '../perfMath.js'

const RECENT_FRAMES = 120   // ~2 s at 60 fps, ~6 s at 20

/**
 * @returns {{recordFrame(ms:number):void, recordJs(ms:number):void}} what
 *   debugPanel feeds every frame
 */
export function initPerformance(ctx) {
  const { onFrame, perf, renderer } = ctx

  const recent = []
  let jsMsEma = 0
  const el = id => document.getElementById(id)

  const button = el('perf-measure')
  const status = el('perf-measure-status')
  const costs = el('perf-costs')
  let wasActive = false
  let frameAtStart = 0
  button.addEventListener('click', () => {
    if (perf.costMeasure.active) { perf.costMeasure.cancel(); status.textContent = 'Cancelled.'; return }
    frameAtStart = frameStats(recent).median
    perf.costMeasure.start(perf.measurableParts())
  })

  function showResults(results) {
    costs.textContent = ''
    const scale = Math.max(frameAtStart, ...results.map(r => r.hi))
    for (const r of [...results].sort((a, b) => b.ms - a.ms)) {
      const row = document.createElement('div')
      row.className = 'dbg-row'
      row.innerHTML = '<span class="dbg-label"></span><div class="dbg-bar-track"><div class="dbg-bar-fill"></div></div><span class="dbg-val"></span>'
      row.querySelector('.dbg-label').textContent = r.name
      row.querySelector('.dbg-bar-fill').style.width = `${Math.max(0, (r.ms / scale) * 100).toFixed(1)}%`
      // ± half the interquartile range of the paired differences: how much
      // the repeats disagreed, so a cost inside its own spread reads as ~0.
      row.querySelector('.dbg-val').textContent = `${r.ms.toFixed(1)} ± ${((r.hi - r.lo) / 2).toFixed(1)} ms`
      costs.appendChild(row)
    }
  }

  onFrame(() => {
    const s = frameStats(recent)
    el('perf-val-fps').textContent = Number.isFinite(s.fps) ? s.fps.toFixed(0) : '-'
    el('perf-val-frametime').textContent = Number.isFinite(s.median) ? s.median.toFixed(1) : '-'
    el('perf-val-p95').textContent = Number.isFinite(s.p95) ? s.p95.toFixed(1) : '-'
    el('perf-val-js').textContent = jsMsEma.toFixed(1)
    const w = renderer.domElement.width, h = renderer.domElement.height   // the drawing buffer
    el('perf-val-resolution').textContent = `${w} × ${h} (×${renderer.getPixelRatio()})`

    const m = perf.costMeasure
    if (m.active) {
      const p = m.progress()
      status.textContent = `Measuring ${p.part}… ${Math.round((p.done / p.total) * 100)}%`
      button.textContent = 'Cancel'
    } else if (wasActive) {
      button.textContent = 'Measure costs'
      if (m.results.length) {
        status.textContent = `Measured at ${frameAtStart.toFixed(1)} ms per frame.`
        showResults(m.results)
      }
    }
    wasActive = m.active
  })

  return {
    recordFrame(ms) {
      recent.push(ms)
      if (recent.length > RECENT_FRAMES) recent.shift()
    },
    recordJs(ms) { jsMsEma = jsMsEma === 0 ? ms : jsMsEma + (ms - jsMsEma) * 0.1 },
  }
}
