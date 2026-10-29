/**
 * costMeasure.js — the Performance tab's "Measure costs" run.
 *
 * Switches each part of the frame off and back on in short alternating
 * windows and reports how many milliseconds of frame time each one costs
 * (see perfMath.js for why this, and not a timer, is the measurement).
 *
 * Driven one rendered frame at a time: the render loop calls onFrame(ms) at
 * the start of each frame with the previous frame's duration, and keeps every
 * pass running while `active` (a held scene would otherwise skip the very
 * passes being measured). A window ignores its first `settleFrames` frames —
 * the switch itself lands mid-pipeline — then takes the median of the next
 * `windowFrames`.
 *
 * Stateful but DOM-free, so it is unit-tested with synthetic parts.
 */
import { costSchedule, pairedCost, quantile } from './perfMath.js'

export class CostMeasure {
  /**
   * @param {{settleFrames?:number, windowFrames?:number, pairs?:number}} [opts]
   */
  constructor({ settleFrames = 2, windowFrames = 8, pairs = 4 } = {}) {
    this._settle = settleFrames
    this._frames = windowFrames
    this._pairs = pairs
    this._schedule = []
    this._parts = new Map()
    this._step = 0
    this._samples = []
    this._windowMs = []      // per schedule step, the window's median frame
    this.results = []
  }

  /** True while a run is in progress. */
  get active() { return this._step < this._schedule.length }

  /**
   * Start a run over `parts`. Each part: { name, off(), on() }; on() must undo
   * exactly what off() did.
   * @param {{name:string, off:Function, on:Function}[]} parts
   */
  start(parts) {
    this.cancel()
    this._parts = new Map(parts.map(p => [p.name, p]))
    this._schedule = costSchedule(parts.map(p => p.name), this._pairs)
    this._step = 0
    this._samples = []
    this._windowMs = []
    this.results = []
    this._enter()
  }

  /** Stop early, leaving every part switched back on. */
  cancel() {
    if (this.active && this._schedule[this._step].off) this._parts.get(this._schedule[this._step].part).on()
    this._step = this._schedule.length
  }

  /** { part, done, total } for the status line; part is null when idle. */
  progress() {
    const total = this._schedule.length
    return { part: this.active ? this._schedule[this._step].part : null, done: this._step, total }
  }

  /** @param {number} frameMs  the previous frame's duration */
  onFrame(frameMs) {
    if (!this.active) return
    this._samples.push(frameMs)
    if (this._samples.length < this._settle + this._frames) return
    this._windowMs.push(quantile(this._samples.slice(this._settle), 0.5))
    const w = this._schedule[this._step]
    if (w.off) this._parts.get(w.part).on()
    this._step++
    this._samples = []
    if (this.active) this._enter()
    else this._finish()
  }

  _enter() {
    const w = this._schedule[this._step]
    if (w.off) this._parts.get(w.part).off()
  }

  _finish() {
    for (const name of this._parts.keys()) {
      const base = [], variant = []
      this._schedule.forEach((w, i) => {
        if (w.part !== name) return
        ;(w.off ? variant : base).push(this._windowMs[i])
      })
      this.results.push({ name, ...pairedCost(base, variant) })
    }
  }
}
