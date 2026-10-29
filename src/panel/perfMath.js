/**
 * perfMath.js — pure helpers for the Performance tab. No THREE/DOM/wall-clock
 * → unit-tested.
 *
 * Why the tab measures what it measures: the frame is GPU-bound, and neither
 * the CPU-side time spent issuing a stage nor (in Safari) any GPU timer says
 * what that stage costs. What does is switching the stage off and seeing how
 * much faster frames get — an ablation. costSchedule/pairedCost are that
 * method; frameStats is the always-on readout.
 */

/**
 * The p-quantile (0..1) of `values`, nearest-rank on a sorted copy. NaN for an
 * empty list.
 * @param {number[]} values
 * @param {number} p
 */
export function quantile(values, p) {
  if (!values.length) return NaN
  const s = [...values].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * p)))]
}

/**
 * Typical and slowest frame times over a recent window of frame durations.
 * The median, not the mean: one hitch would drag a mean far from what most
 * frames feel like, and the hitches get their own number (p95).
 * @param {number[]} frameMs  recent frame durations, ms
 * @returns {{median:number, p95:number, fps:number}}
 */
export function frameStats(frameMs) {
  const median = quantile(frameMs, 0.5)
  return { median, p95: quantile(frameMs, 0.95), fps: median > 0 ? 1000 / median : 0 }
}

/**
 * The order of measurement windows: for each part, `pairs` pairs of one
 * window with everything on (base) and one with that part off. The order
 * inside a pair alternates (base first, then part-off first, …), so a slow
 * drift in frame time — the scene changing, the machine warming up — adds to
 * the base in half the pairs and to the variant in the other half, and
 * cancels in the median.
 * @param {string[]} parts
 * @param {number} pairs
 * @returns {{part:string, off:boolean, pair:number}[]}
 */
export function costSchedule(parts, pairs) {
  const out = []
  for (const part of parts) {
    for (let pair = 0; pair < pairs; pair++) {
      const baseFirst = pair % 2 === 0
      out.push({ part, off: !baseFirst, pair }, { part, off: baseFirst, pair })
    }
  }
  return out
}

/**
 * A part's cost from its paired windows: base minus part-off, per pair, then
 * the median of those differences and their interquartile range. Pairing
 * before taking the median is what makes it robust: each difference compares
 * two windows taken seconds apart, so slow changes in the scene cancel.
 * @param {number[]} baseMs     per-pair frame time with everything on
 * @param {number[]} variantMs  per-pair frame time with the part off
 * @returns {{ms:number, lo:number, hi:number}}
 */
export function pairedCost(baseMs, variantMs) {
  const d = baseMs.map((b, i) => b - variantMs[i])
  return { ms: quantile(d, 0.5), lo: quantile(d, 0.25), hi: quantile(d, 0.75) }
}
