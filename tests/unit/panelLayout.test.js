import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { PANEL_ROWS } from '../../src/panel/panelRows.js'
import { LAYOUT, MARKUP_LAYOUT, PALETTE_LAYOUT, ART_HOSTS, speciesLayout } from '../../src/panel/panelLayout.js'
import { rowHtml, hasDomId } from '../../src/panel/paramPanel.js'
import { SIM_PARAMS } from '../../src/shared/simState.js'
import { MIC_PARAMS } from '../../src/interaction/interactionParams.js'

/**
 * The panel's controls are generated from rows into hosts (paramPanel.js,
 * panelLayout.js). These checks keep the three lists level: every row with a
 * control is placed once, every placement names a row, and every host the
 * markup declares has a list. The control bar's two sliders are the only rows
 * written by hand.
 */

const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8')
const markupHosts = [...html.matchAll(/data-param-group="([^"]+)"/g)].map(m => m[1])
const rowsById = new Map(PANEL_ROWS.map(r => [r.id, r]))
const BY_HAND = new Set(SIM_PARAMS.filter(r => r.kind === 'slider').map(r => r.id))

describe('panel layout', () => {
  it('places every row that has a control exactly once (the control bar aside)', () => {
    const placed = Object.values(LAYOUT).flat()
    expect(placed.filter((id, i) => placed.indexOf(id) !== i), 'placed twice').toEqual([])
    const unplaced = PANEL_ROWS.filter(r => !placed.includes(r.id) && !BY_HAND.has(r.id)).map(r => r.id)
    expect(unplaced, 'rows with a control but no host').toEqual([])
  })

  it('names only rows that exist and have a control', () => {
    for (const [host, ids] of Object.entries(LAYOUT)) {
      for (const id of ids) {
        expect(rowsById.has(id), `${host} lists unknown row ${id}`).toBe(true)
        expect(rowsById.get(id).kind, `${id} is hidden`).not.toBe('hidden')
      }
    }
  })

  it('gives every host in index.html a list, and every markup list a host', () => {
    for (const h of markupHosts) expect(LAYOUT[h], `index.html host ${h} has no layout`).toBeDefined()
    const wanted = [...Object.keys(MARKUP_LAYOUT), ...Object.keys(PALETTE_LAYOUT)]
    expect(wanted.filter(h => !markupHosts.includes(h)), 'layout lists with no host in index.html').toEqual([])
    expect(new Set(markupHosts).size, 'a host name used twice').toBe(markupHosts.length)
  })

  it('has a list for every host the panel builds itself', () => {
    for (const h of ART_HOSTS) expect(LAYOUT[h.name]).toBe(h.ids)
    for (const h of Object.keys(speciesLayout())) expect(LAYOUT[h]).toBeDefined()
  })
})

describe('rowHtml', () => {
  const slider = rowsById.get('ctrl-snow-base')

  it('writes a slider as the label, the range input and its value label', () => {
    const h = rowHtml(slider)
    expect(h).toContain('class="dbg-slider-row"')
    expect(h).toContain(`<span>${slider.label}</span>`)
    expect(h).toContain(`id="${slider.id}" min="${slider.min}" max="${slider.max}" step="${slider.step}"`)
    expect(h).toContain(`<span id="${slider.id}-val">`)
  })

  it('shows a slider with a displayScale in the panel unit, range included', () => {
    const row = MIC_PARAMS.find(r => 'displayScale' in r)
    const h = rowHtml(row)
    expect(h).toContain(`max="${row.max * row.displayScale}"`)
    expect(h).toContain(`step="${+(row.step * row.displayScale).toFixed(9)}"`)
  })

  it('writes a toggle, a colour and a radio group in the classes the driven marking looks for', () => {
    expect(rowHtml(rowsById.get('tog-fog'))).toMatch(/^<label class="dbg-toggle"><input type="checkbox" id="tog-fog"> .+<\/label>$/)
    expect(rowHtml(rowsById.get('col-forest'))).toMatch(/^<label class="dbg-color"><input type="color" id="col-forest"> forest<\/label>$/)
    expect(rowHtml(rowsById.get('ctrl-ray-color'), { colourStyle: 'labelled' })).toContain('class="dbg-row"')
    const radios = rowHtml(rowsById.get('debug-view'))
    expect((radios.match(/type="radio" name="debug-view"/g) || []).length).toBe(rowsById.get('debug-view').options.length)
  })

  it('marks a row whose id is only `owner.key`', () => {
    const species = PANEL_ROWS.find(r => r.kind === 'colour' && !hasDomId(r))
    expect(species).toBeDefined()
    expect(rowHtml(species)).not.toContain(' id=')
    expect(rowHtml(species)).toContain(`data-param-row="${species.id}"`)
  })

  it('refuses a row with no control', () => {
    expect(() => rowHtml({ id: 'x', owner: 'o', key: 'k', kind: 'hidden' })).toThrow()
  })
})

describe('bindParam while the panel is hidden', () => {
  it('writes no DOM on a change while hidden and pulls the stale control on flush', async () => {
    const { makeBindParam } = await import('../../src/panel/paramPanel.js')
    const el = { writes: 0, addEventListener() {} }
    Object.defineProperty(el, 'value', { get: () => el._v, set: v => { el._v = v; el.writes++ } })
    const val = { writes: 0 }
    Object.defineProperty(val, 'textContent', { get: () => val._t, set: v => { val._t = v; val.writes++ } })
    globalThis.document = { getElementById: id => (id === 'x-val' ? val : id === 'x' ? el : null), querySelector: () => null }
    let stored = 0.5, visible = false, notify
    const bind = makeBindParam({ isClobbered: () => false, onFrame() {}, isVisible: () => visible })
    bind({ id: 'x', key: 'k', kind: 'slider', digits: 2 }, { get: () => stored, set() {}, onChange: (_k, fn) => { notify = fn } })
    el.writes = 0; val.writes = 0
    stored = 0.9; notify()
    expect(el.writes + val.writes).toBe(0)
    bind.flush()
    expect(el.value).toBe(0.9)
    expect(val.textContent).toBe('0.90')
    visible = true; stored = 0.2; notify()
    expect(el.value).toBe(0.2)
    delete globalThis.document
  })
})
