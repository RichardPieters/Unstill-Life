/**
 * flyCameraParams.js — the param row (shared/paramSchema.js) of flyCamera.js,
 * held by `flyCamera.params`. The debug camera is not part of a painting, so
 * the row is `persist: false`. `live`: the F key flips it outside the panel.
 */
export const FLY_PARAMS = [
  { id: 'tog-flycam', owner: 'flyCamera', key: 'enabled', kind: 'toggle', encode: 'bool',
    label: 'fly camera — WASD move · Space/Shift up-down · Ctrl boost · drag to look (F)', value: false, persist: false, live: true },
]
