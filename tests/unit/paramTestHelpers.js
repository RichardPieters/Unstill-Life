/** Whether a slider row's default sits on its own step grid. */
export function onStepGrid({ value, min, step }) {
  const n = (value - min) / step
  return Math.abs(n - Math.round(n)) < 1e-6
}
