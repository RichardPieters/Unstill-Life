/**
 * paramPanel.js — the panel's value controls, generated from param rows
 * (shared/paramSchema.js), and the one binder that wires each to its owner.
 *
 * GENERATING  index.html keeps its tabs, headings, buttons, readouts and notes;
 *   each place that holds params has a host `<div data-param-group="name">`, and
 *   panelLayout.js lists the row ids each host receives, in order. rowHtml(row)
 *   is the markup of one control, written once here:
 *     slider  <div class="dbg-slider-row"><span>label</span><input type="range"
 *             id min max step value><span id="id-val">text</span></div>
 *     toggle  <label class="dbg-toggle"><input type="checkbox" id> label</label>
 *     colour  <label class="dbg-color"><input type="color" id> label</label>, or
 *             with data-colour-style="labelled" on the host, a `.dbg-row` with
 *             the label before the swatch
 *     radio   one `.dbg-toggle` label per option, `name` = the row's id
 *   A row whose id is `owner.key` (no DOM id of its own, e.g. a species crown
 *   colour) is generated with a `data-param-row` attribute instead of an `id`,
 *   so it is found by its row id.
 *   The class names are what drivenRegistry's marking (`closest`) and the CSS
 *   look for. A slider's `value` attribute and label text are placeholders:
 *   bindParam overwrites both with the live value as soon as it binds.
 *
 * BINDING  bindParam(row, access) is the one binder, for every kind:
 *   - pull at bind time: the control and its `-val` label show `access.get`,
 *     through the row's displayScale and digits;
 *   - the control's `input`/`change` writes `access.set`. A slider or colour
 *     that a running driver owns (env.isClobbered, from drivenRegistry) is
 *     inert: the write is dropped and the control snaps back. CSS
 *     `pointer-events` stops only the mouse, and `disabled` would also stop
 *     test fill() on permanently driven rows, so the guard sits at the write;
 *   - `access.onChange(key)` pulls after any other writer (a driver, a snapshot
 *     import, an action), so nothing polls and nothing shows a bind-time value;
 *   - `live` rows are re-read every frame (env.onFrame), for state that changes
 *     outside the panel (the F key, the art pass's automatic reveal).
 *   `access` is `{ get(key), set(key, v), onChange?(key, fn) }`: an owner's
 *   `params`, or a wrapper where one write path has side effects (the art-pass
 *   ground swatch, which edits the weather's clear mirror). A control with no `-val` label (the control bar) binds
 *   the same way.
 */
import { toDisplay, fromDisplay } from '../shared/paramSchema.js'

/** Whether the row's control carries a DOM id (an `owner.key` id does not). */
export const hasDomId = row => row.id !== `${row.owner}.${row.key}`

// An id-less control is found by its row id instead.
const idAttr = row => (hasDomId(row) ? ` id="${row.id}"` : ` data-param-row="${row.id}"`)

// A stored number as the panel's attribute shows it; rounded so ×1000 leaves no float tail.
const shownNum = (row, n) => +toDisplay(row, n).toFixed(9)

function sliderHtml(row) {
  const shown = shownNum(row, row.value)
  return `<div class="dbg-slider-row"><span>${row.label}</span>`
    + `<input type="range"${idAttr(row)} min="${shownNum(row, row.min)}" max="${shownNum(row, row.max)}" step="${shownNum(row, row.step)}" value="${shown}">`
    + `<span id="${row.id}-val">${shown.toFixed(row.digits)}</span></div>`
}

const toggleHtml = row =>
  `<label class="dbg-toggle"><input type="checkbox"${idAttr(row)}> ${row.label}</label>`

function colourHtml(row, style) {
  if (style === 'labelled') {
    return `<div class="dbg-row"><span class="dbg-label">${row.label}</span><input type="color"${idAttr(row)}></div>`
  }
  return `<label class="dbg-color"><input type="color"${idAttr(row)}> ${row.label}</label>`
}

const radioHtml = row => row.options.map(o =>
  `<label class="dbg-toggle"><input type="radio" name="${row.id}" value="${o.value}"> ${o.label}</label>`).join('')

/** The markup of one control (a radio row: its whole group of choices). */
export function rowHtml(row, { colourStyle = 'swatch' } = {}) {
  switch (row.kind) {
    case 'slider': return sliderHtml(row)
    case 'toggle': return toggleHtml(row)
    case 'colour': return colourHtml(row, colourStyle)
    case 'radio':  return radioHtml(row)
    default: throw new Error(`rowHtml: ${row.id} has kind "${row.kind}", which has no control`)
  }
}

/**
 * Fill every `[data-param-group]` host under `root` with the controls of the
 * rows `layout[name]` lists (ids into `rowsById`). Returns the rows generated,
 * in order. A host the layout does not know, or an id no row has, throws: both
 * are a typo that would otherwise show up as a missing control.
 */
export function generateGroups(root, layout, rowsById) {
  const made = []
  for (const host of root.querySelectorAll('[data-param-group]')) {
    const name = host.dataset.paramGroup
    const ids = layout[name]
    if (!ids) throw new Error(`generateGroups: no layout for host "${name}"`)
    const colourStyle = host.dataset.colourStyle || 'swatch'
    host.insertAdjacentHTML('beforeend', ids.map(id => {
      const row = rowsById.get(id)
      if (!row) throw new Error(`generateGroups: host "${name}" lists unknown row "${id}"`)
      made.push(row)
      return rowHtml(row, { colourStyle })
    }).join(''))
  }
  return made
}

const hexOf = v => (typeof v === 'string' ? v.toLowerCase() : '#' + (v >>> 0).toString(16).padStart(6, '0'))

/**
 * The binder for one panel. `env`:
 *   isClobbered(id)  true while a driver owns the control (drivenRegistry)
 *   onFrame(fn)      registers a per-frame re-read (for `live` rows)
 *   isVisible()      whether the panel is open. A change while it is hidden only
 *                    marks the control stale; `bindParam.flush()` (called on
 *                    open) re-reads every stale control, so a walker that moves
 *                    dozens of params per tick costs no DOM writes while hidden.
 */
export function makeBindParam(env) {
  const stale = new Set()
  const followChange = pull => () => { if (env.isVisible()) pull(); else stale.add(pull) }
  function bindParam(row, access) {
    const { key } = row
    if (row.kind === 'radio') return bindRadio(row, access)
    const el = hasDomId(row) ? document.getElementById(row.id) : document.querySelector(`[data-param-row="${row.id}"]`)
    if (!el) throw new Error(`bindParam: no control #${row.id}`)
    const valEl = document.getElementById(`${row.id}-val`)
    let own = false   // the write is this control's own: its label already shows it
    const read = {
      slider: () => { const v = access.get(key); return v == null ? null : toDisplay(row, v) },
      toggle: () => !!access.get(key),
      colour: () => { const v = access.get(key); return v == null ? null : hexOf(v) },
    }[row.kind]
    const show = {
      slider: v => { el.value = v; if (valEl) valEl.textContent = v.toFixed(row.digits) },
      toggle: v => { el.checked = v },
      colour: v => { el.value = v },
    }[row.kind]
    const pull = () => { const v = read(); if (v !== null) show(v) }
    pull()
    if (access.onChange) {
      const follow = followChange(pull)
      access.onChange(key, () => { if (!own) follow() })
    }
    if (row.live) env.onFrame(pull)

    const write = v => { own = true; try { access.set(key, v) } finally { own = false } }
    if (row.kind === 'toggle') {
      el.addEventListener('change', e => write(e.target.checked))
    } else if (row.kind === 'slider') {
      el.addEventListener('input', e => {
        if (env.isClobbered(row.id)) { pull(); return }
        const v = parseFloat(e.target.value)
        write(fromDisplay(row, v))
        if (valEl) valEl.textContent = v.toFixed(row.digits)
      })
    } else {
      // A colour sits inside its <label>: clicking the label's text still opens
      // the picker whatever the input's `pointer-events` says.
      el.addEventListener('input', e => {
        if (env.isClobbered(row.id)) { pull(); return }
        write(e.target.value)
      })
    }
    return pull
  }

  function bindRadio(row, access) {
    const radios = [...document.querySelectorAll(`input[type=radio][name="${row.id}"]`)]
    if (!radios.length) throw new Error(`bindParam: no radios named ${row.id}`)
    const pull = () => {
      const v = access.get(row.key)
      for (const r of radios) r.checked = parseFloat(r.value) === v
    }
    pull()
    if (access.onChange) access.onChange(row.key, followChange(pull))
    for (const r of radios) {
      r.addEventListener('change', () => { if (r.checked) access.set(row.key, parseFloat(r.value)) })
    }
    return pull
  }

  bindParam.flush = () => { const pulls = [...stale]; stale.clear(); for (const pull of pulls) pull() }
  return bindParam
}
