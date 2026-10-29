/**
 * micProbeMath.js — pure analysis helpers for the mic self-noise probe
 * (micProbe.js). No DOM / wall-clock / AudioContext → unit-tested.
 *
 * The probe answers: how much of what the mic hears is the sim's own audio,
 * and can a human still be told apart from it? Everything here is threshold-
 * free (percentiles, hit rates, a linear fit) so a result reads the same
 * whatever the flux-gain / floor sliders are set to.
 */

/** Linear-interpolated percentile, p ∈ [0,100]. NaN for an empty series. */
export function percentile(values, p) {
  if (!values.length) return NaN
  const s = [...values].sort((a, b) => a - b)
  const pos = (Math.min(100, Math.max(0, p)) / 100) * (s.length - 1)
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return s[lo] + (s[hi] - s[lo]) * (pos - lo)
}

/** p50 / p90 / max of one series. */
export function describe(values) {
  return {
    p50: percentile(values, 50),
    p90: percentile(values, 90),
    max: values.length ? Math.max(...values) : NaN,
  }
}

const METRICS = ['micDb', 'rms', 'flux', 'restlessness', 'master']

/** One take's rows ([{t, micDb, rms, flux, restlessness, master, ...}]) → per-metric percentiles. */
export function summariseTake(rows) {
  const out = { n: rows.length }
  for (const m of METRICS) out[m] = describe(rows.map(r => r[m]))
  return out
}

/** Least-squares y = slope·x + intercept with the coefficient of determination. */
export function linearFit(x, y) {
  const n = Math.min(x.length, y.length)
  if (n < 2) return { slope: NaN, intercept: NaN, r2: NaN }
  let sx = 0, sy = 0
  for (let i = 0; i < n; i++) { sx += x[i]; sy += y[i] }
  const mx = sx / n
  const my = sy / n
  let sxx = 0, sxy = 0, syy = 0
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx
    const dy = y[i] - my
    sxx += dx * dx; sxy += dx * dy; syy += dy * dy
  }
  if (sxx === 0) return { slope: NaN, intercept: NaN, r2: NaN }
  const slope = sxy / sxx
  return { slope, intercept: my - slope * mx, r2: syy === 0 ? 1 : (sxy * sxy) / (sxx * syy) }
}

/**
 * Lag (in samples) at which `b` best follows `a`: the shift L maximising the
 * Pearson correlation of a[i] with b[i+L], L ∈ [0, maxLag]. Returns
 * { lag, corr }. A flat series has no defined correlation → corr NaN, lag 0.
 */
export function bestLag(a, b, maxLag) {
  let best = { lag: 0, corr: -Infinity }
  for (let L = 0; L <= maxLag; L++) {
    const n = Math.min(a.length, b.length - L)
    if (n < 3) break
    const c = pearson(a, b, L, n)
    if (Number.isFinite(c) && c > best.corr) best = { lag: L, corr: c }
  }
  return best.corr === -Infinity ? { lag: 0, corr: NaN } : best
}

function pearson(a, b, shift, n) {
  let ma = 0, mb = 0
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i + shift] }
  ma /= n; mb /= n
  let saa = 0, sbb = 0, sab = 0
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma
    const db = b[i + shift] - mb
    saa += da * da; sbb += db * db; sab += da * db
  }
  return saa === 0 || sbb === 0 ? NaN : sab / Math.sqrt(saa * sbb)
}

/**
 * Fraction of `take` frames whose value exceeds the `leak` series' own
 * p-th percentile — "how often does a human moment poke above the sim's
 * worst leak". 1 = always separable, ~(100-p)/100 = indistinguishable.
 * With leak == take this is by construction ≈ (100-p)/100.
 */
export function hitRate(leakValues, takeValues, p = 95) {
  if (!takeValues.length) return NaN
  const cut = percentile(leakValues, p)
  let hits = 0
  for (const v of takeValues) if (v > cut) hits++
  return hits / takeValues.length
}

/** Median frame interval (s) of a rows series — the xcorr lag's unit. NaN if < 2 rows. */
export function medianDt(rows) {
  const dts = []
  for (let i = 1; i < rows.length; i++) dts.push(rows[i].t - rows[i - 1].t)
  return percentile(dts, 50)
}

/**
 * Leak model from the gain-sweep take (room silent, only the sim playing):
 * mic rms ≈ k·master rms + c, plus how long the mic takes to follow the master.
 */
export function leakModel(sweepRows, maxLagSeconds = 0.6) {
  const master = sweepRows.map(r => r.master)
  const mic = sweepRows.map(r => r.rms)
  const fit = linearFit(master, mic)
  const dt = medianDt(sweepRows)
  const lag = Number.isFinite(dt) && dt > 0
    ? bestLag(master, mic, Math.round(maxLagSeconds / dt))
    : { lag: 0, corr: NaN }
  return { k: fit.slope, c: fit.intercept, r2: fit.r2, lagMs: lag.lag * dt * 1000, lagCorr: lag.corr }
}
