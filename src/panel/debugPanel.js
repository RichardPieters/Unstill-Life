/**
 * debugPanel.js — the debug panel's wiring. main.js builds the modules, then
 * calls initDebugPanel() once; it returns `controls`, which the render loop
 * reads (paused, attention(), the render-dirty flag), reports frame
 * and CPU time to, and uses to hand over the form walker and the weather once
 * they exist (bindFormWalker, bindAtmosphere).
 *
 * LAYOUT   initDebugPanel is an orchestrator: one initialiser per section, in
 *          this file or in tabs/ (one file per self-contained tab, each taking
 *          `panelCtx`: the binder helpers plus the modules it needs).
 *
 * ROWS     every value control is generated from its param row into a host
 *          `<div data-param-group>` of index.html (paramPanel.js, placed by
 *          panelLayout.js) and bound by bindParam to its owner's `params`: it
 *          shows the live value at bind time and follows the owner's change
 *          hook. A control a running driver overwrites (drivenRegistry.js) is
 *          dimmed and its writes are dropped. `onFrame` registers views of
 *          state the system changes on its own (the art-pass switch, the
 *          frozen readout). By hand, still through bindParam: the control bar
 *          and the composite toggles. Wholly by hand: the drift tri-state, the
 *          readouts and the buttons.
 *
 * @param {object} deps  the modules the panel drives (see main.js), the
 *                       horizon-colour hooks `applyHorizon` / `forgetHorizon`,
 *                       `sceneUniforms` (the scene-wide fog, light level and
 *                       cloud shadows), `display` and `perf` (cost measurement)
 * @returns {object} `controls`
 */
import { PANEL_ROWS } from './panelRows.js'
import { LAYOUT, ART_HOSTS, SKY_SWATCH_ROW } from './panelLayout.js'
import { generateGroups, makeBindParam } from './paramPanel.js'
import { createSimState, SIM_PARAMS } from '../shared/simState.js'
import { formDrivenIds } from '../scene/formDriver.js'
import { createDrivenRegistry, CLOBBERED, SCALED, FREE } from './drivenRegistry.js'
import { TOOLTIPS } from './tooltips.js'
import { weatherLockedIds } from '../scene/weatherDriver.js'
import { WEATHER_PARAMS, weatherWalkIds } from '../drift/atmosphereParams.js'
// Tab sections with no shared closure state: each takes a `ctx` built from this
// module's binder helpers plus whichever scene/sim modules it wires.
import { initSound } from './tabs/sound.js'
import { initInteraction } from './tabs/interaction.js'
import { initFbm } from './tabs/fbm.js'
import { buildSpeciesHosts } from './tabs/species.js'
// Tab sections that need one extra reference from `panelCtx` (`clouds`, or
// `controls` once initSimControls has run).
import { initClouds } from './tabs/clouds.js'
import { initDebugOverlay } from './tabs/overlay.js'
import { initFullscreen } from './fullscreen.js'
import { initPerformance } from './tabs/performance.js'
import { initSnapshotButtons } from './tabs/snapshot.js'

export function initDebugPanel({ terrain, water, clouds, artPass, godrays, sky, animSpeed, dynamics, interaction, audio, applyHorizon, forgetHorizon, flyCamera, scene, renderer, sceneUniforms, form, display, perf }) {
  const debugEl = document.getElementById('debug')
  // Views of state the system changes on its own (the art pass turning on at a
  // freeze, the frozen flag under a hand-switched painting): re-read every
  // frame by reportFrameTime while the panel is visible. Register with onFrame.
  const liveViews = []
  function onFrame(fn) { liveViews.push(fn) }

  // Who is currently writing which panel control. See drivenRegistry.js.
  const driven = createDrivenRegistry()

  // The generated controls' rows and their binder (see "Param rows" below).
  const rowsById = new Map(PANEL_ROWS.map(r => [r.id, r]))
  const bindParam = makeBindParam({ isClobbered, onFrame, isVisible: () => debugEl.classList.contains('visible') })
  // Opening the panel (button or key, both toggle the class) re-reads what changed while it was hidden.
  new MutationObserver(() => { if (debugEl.classList.contains('visible')) bindParam.flush() })
    .observe(debugEl, { attributes: true, attributeFilter: ['class'] })
  const pulls = new Map()   // control id -> its pull()
  let generated = []        // the rows initParamRows generated, in DOM order

  // While paused, main.js skips the render loop's GPU work entirely unless
  // this is true (initRenderDirtyTracking, controls.consumeNeedsRender). Starts
  // true so the very first frame always renders.
  let needsRender = true

  // Set by bindFormWalker; the snapshot section needs it but runs before it.
  let boundWalker = null
  let boundAtmosphere = null

  // Shared by every tab section: the binder helpers (defined below; function
  // declarations hoist) plus the modules the sections wire. Each section
  // destructures only what it needs.
  const panelCtx = { pullControl, onFrame, debugEl, terrain, water, audio, dynamics, interaction, flyCamera, clouds, perf, renderer }

  initRenderDirtyTracking()
  initTabs()
  initDrivenRegistry()
  initParamRows()
  initArtPassToggle()
  applyTooltips()
  const controls = initSimControls()
  panelCtx.controls = controls
  initDebugOverlay(panelCtx)
  initFullscreen(panelCtx)
  initClouds(panelCtx)
  initSound(panelCtx)
  initFbm(panelCtx)
  initInteraction(panelCtx)
  const perfTab = initPerformance(panelCtx)
  initAtmosphere()
  initSnapshot()
  return controls

  // ─── Render dirty-tracking ──────────────────────────────────────────────
  // Any control inside the panel — a slider drag, a checkbox, a colour pick,
  // a button click (Export/Import/Calibrate/…) — should produce one visible
  // frame even while paused, so tuning terrain while the sim is frozen still
  // shows the result. Delegated at the panel root rather than per-control: a
  // control added later automatically participates without a new binding.
  function initRenderDirtyTracking() {
    const mark = () => { needsRender = true }
    debugEl.addEventListener('input', mark)
    debugEl.addEventListener('change', mark)
    debugEl.addEventListener('click', mark)
  }

  // ─── Tabs ────────────────────────────────────────────────────────────────
  // Pure DOM-position grouping — every control keeps its id, so which tab it
  // lives in never touches a binding below. One active tab-content div and one
  // active tab-btn at a time, matched by data-tab.
  function initTabs() {
    const btns = document.querySelectorAll('.dbg-tab-btn')
    const tabs = document.querySelectorAll('.dbg-tab')
    btns.forEach(btn => btn.addEventListener('click', () => {
      btns.forEach(b => b.classList.toggle('active', b === btn))
      tabs.forEach(t => t.classList.toggle('active', t.dataset.tab === btn.dataset.tab))
    }))
  }

  // ─── System-driven sliders ─────────────────────────────────────────────────
  // A control owned by a running driver (the form walker, the weather) is dimmed
  // and its writes are dropped: moving it would be overwritten on the next
  // tick, so the dimming is a correctness signal, not decoration. Ownership is
  // declared in drivenRegistry.js terms below.
  /** True while some active driver overwrites this control outright. */
  function isClobbered(id) { return driven.resolve().get(id) === CLOBBERED }

  /**
   * Push the registry's verdict onto the DOM: dim + mark every owned row, and
   * annotate a SCALED one differently from a CLOBBERED one.
   *
   * `aria-disabled` rather than `disabled`, and `pointer-events` on the ROW
   * rather than the input — the input-only rule left colour swatches clickable
   * through their <label>. The real inertness is the write guard in
   * bindParam (paramPanel.js); this is the part you can see.
   */
  function applyDrivenMarks() {
    const states = driven.resolve()
    for (const id of driven.declaredIds()) {
      const el = document.getElementById(id)
      if (!el) continue
      const row = el.closest('.dbg-slider-row, .dbg-color, .dbg-toggle')
      if (!row) continue
      const state = states.get(id) || FREE
      row.classList.toggle('sys-active', state === CLOBBERED)
      row.classList.toggle('sys-scaled', state === SCALED)
      if (state === CLOBBERED) el.setAttribute('aria-disabled', 'true')
      else el.removeAttribute('aria-disabled')
    }
  }

  /**
   * Declare every driver's ownership once, next to the fact that names it: the
   * form's driven ids (formDriver.js's formDrivenIds) for the walker, the
   * weather's locked ids (declared in initAtmosphere). See drivenRegistry.js.
   */
  function initDrivenRegistry() {
    // The dial positions, what they are blended into, and the two cloud
    // controls the cloud dials write through: all overwritten every tick.
    driven.declare('form', formDrivenIds())
    // The cloud-density dial always scales the light-shaft intensity and the
    // cloud-shadow amount by a factor of its own (see formDriver.js's density write) — not
    // gated on the walker, since dragging the dial by hand does the same
    // scaling. Declared active immediately and never toggled off.
    driven.declare('cloud-density', ['ctrl-ray-intensity', 'ctrl-cloudshadow-amt'], SCALED)
    // Shadow DEPTH (as opposed to shadow strength above) is set outright to
    // the density position, not scaled against whatever the slider already
    // said — see densityToShadowDepth's doc.
    driven.declare('cloud-density', ['ctrl-cloudshadow-abs'])
    driven.setActive('cloud-density', true)
  }

  /** Push every driver's CURRENT active state into the registry, then the DOM.
   *  Called from every place a driver's enable state can change — a checkbox,
   *  freezeForm(), the weather's `enabled`/`walking` change hooks (which a
   *  snapshot restore fires). */
  function syncDrivenActive() {
    if (boundWalker)     driven.setActive('form', boundWalker.params.get('enabled'))
    if (boundAtmosphere) {
      driven.setActive('weather-master', boundAtmosphere.params.get('enabled'))
      driven.setActive('weather-walk', boundAtmosphere.params.get('enabled') && boundAtmosphere.params.get('walking'))
    }
    applyDrivenMarks()
  }

  // ─── Tooltips ────────────────────────────────────────────────────────────
  // The single source is tooltips.js (see its header for why selectors, not
  // index.html title= attributes). Warns on any selector matching nothing, so a
  // renamed or removed control is noticed.
  function applyTooltips() {
    for (const { selector, text } of TOOLTIPS) {
      const el = document.querySelector(selector)
      if (el) el.title = text
      else console.warn(`[tooltips] selector matched nothing: ${selector}`)
    }
  }

  // ─── Param rows: generated controls, bound through their owners ───────────
  // Every value control is generated from its row (paramPanel.js) into the hosts
  // of index.html and the hosts built here (the art pass's, one per species),
  // then bound through the owner's `params`. An owner built later (the walker,
  // the weather) binds its rows when main.js hands it over (bindOwner).
  /** Bind one row and remember its pull, for callers that change a value behind the accessor. */
  function bind(row, access) {
    const pull = bindParam(row, access)
    pulls.set(row.id, pull)
    return pull
  }
  function pullControl(id) { pulls.get(id)?.() }

  /**
   * Bind a toggle that has no row of its own through the same binder: a
   * composite (the art-pass on switch, the mic).
   */
  function bindLoose({ id, live }, get, set) {
    return bind({ id, key: id, kind: 'toggle', live }, { get: () => get(), set: (_key, v) => set(v) })
  }

  function bindOwner(owner, access) {
    for (const row of generated) {
      if (row.owner === owner && !authoredThroughClear(row)) bind(row, accessOverride(row) ?? access)
    }
  }

  /**
   * The weather entry whose live param this row is, when the row's control
   * must edit the weather's clear mirror instead: a raw write would be
   * overwritten by the next blend from the stale captured clear (the art-pass
   * ground swatch). bindAtmosphere binds it, once the weather exists.
   */
  function authoredThroughClear(row) {
    return WEATHER_PARAMS.find(e => e.locks === false && e.ref === `${row.owner}.${row.key}`)
  }

  // Rows whose write path is not the owner's plain `set`.
  function accessOverride(row) {
    // The sky swatch edits the horizon colour, which four owners hold; the
    // weather moves it, so it follows the sky's own hook.
    if (row.id === 'col-sky') {
      return {
        get: () => sky.params.get('horizonHex'),
        set: (_key, v) => applyHorizon(parseInt(v.slice(1), 16)),
        onChange: (_key, fn) => sky.params.onChange('horizonHex', fn),
      }
    }
    return null
  }

  function initParamRows() {
    buildArtHosts()
    buildSpeciesHosts(document.getElementById('ctrl-species'))
    generated = generateGroups(debugEl, LAYOUT, rowsById)
    // Fog, light level and the cloud shadows are scene-wide: one write reaches
    // terrain and water at once, so the shoreline cannot seam.
    const owners = {
      terrain, water, godrays, clouds, artPass, audio, interaction, flyCamera, sky, dynamics, animSpeed, display,
      horizon: sky, scene: sceneUniforms, form,
    }
    for (const [name, owner] of Object.entries(owners)) if (owner) bindOwner(name, owner.params)
  }

  // ─── Art pass ─────────────────────────────────────────────────────────────
  // The divisionist post-process (artPass.js). Its hosts are built here, under
  // headings from ART_GROUPS, rather than written into index.html: the rows
  // already own each control's range, step, default and uniform.
  function buildArtHosts() {
    const container = document.getElementById('artpass-controls')
    if (!container || !artPass) return
    for (const h of ART_HOSTS) {
      if (h.heading) {
        const heading = document.createElement('h4')
        heading.className = 'dbg-sub'
        heading.textContent = h.heading
        container.appendChild(heading)
      }
      const host = document.createElement('div')
      host.dataset.paramGroup = h.name
      if (h.className) host.className = h.className
      container.appendChild(host)
    }
  }

  // Turning the pass ON plays the entrance animation; turning it off is
  // immediate (the paint simply stops being composited). Elsewhere `.enabled`
  // is set directly (tests, snapshot restore) and skips the animation. `live`:
  // the automatic reveal flips it too.
  function initArtPassToggle() {
    if (!artPass) return
    bindLoose({ id: 'tog-artpass', live: true }, () => artPass.enabled, on => {
      if (on) artPass.playReveal()
      else artPass.enabled = false
    })
  }

  // ─── Sim-drive state (read by the render loop via the returned controls) ──
  function initSimControls() {
    const sim = createSimState()
    // The control bar's two sliders are written in index.html (a bar, not a
    // panel group) and carry no value label; the rows hold their defaults, so
    // the markup's `value=` is not read.
    for (const row of SIM_PARAMS.filter(r => r.kind === 'slider')) bind(row, sim.params)
    const pauseButton = document.getElementById('pause')
    sim.params.onChange('paused', paused => { pauseButton.textContent = paused ? 'Resume' : 'Pause' })
    // Mic mode reads interaction.getAttentionLevel() instead of the slider.
    // Defaults to manual so the page never prompts for a mic permission on load.
    let micMode = false
    const attentionLabel = document.getElementById('attention').closest('label')
    let frameMsEma = 0   // smoothed render-loop frame time, ms — perf readout only

    // Composite: it asks for permission, so a refusal unchecks the box again.
    bindLoose({ id: 'int-src-mic' }, () => micMode, async v => {
      if (v && !interaction.getSignals().active) {
        const ok = await interaction.enableMic(audio.getAudioContext() ?? new (window.AudioContext)())
        if (!ok) { document.getElementById('int-src-mic').checked = false; return }
      }
      if (!v) interaction.disableMic()   // releases the mic track — stops the OS mic indicator
      micMode = v
      // The mic sets attention, so the bar's manual slider would do nothing.
      attentionLabel.style.display = v ? 'none' : ''
    })
    pauseButton.addEventListener('click', () => sim.params.set('paused', !sim.params.get('paused')))

    // Getters so the render loop sees live values. setPaused lets the snapshot
    // restore pause before writing state (a tick after the write would
    // re-stamp uTime/drift over the restore).
    return {
      get paused()          { return sim.params.get('paused') },
      // What main.js feeds dynamics.update(): the slider in Manual mode, the mic
      // in Mic mode. A method because it reads a live sensor each call.
      attention()           { return micMode ? interaction.getAttentionLevel() : sim.params.get('manualAttention') },
      /** The driven registry, exposed for tests/visual/driven_registry.spec.js. */
      driven,
      // The walker is built from `controls`, so its sliders are bound here,
      // once it exists, rather than in a section function.
      bindFormWalker(walker) {
        boundWalker = walker
        initDriftToggle()
        bindOwner('formWalker', walker.params)
        // bindAtmosphere's sync ran while boundWalker was still null.
        syncDrivenActive()
      },
      /** Re-read the drift toggle from the walker: it is tri-state, so it has no
       *  row of its own and anything that flips it in code (freezeForm) must say so or
       *  the checkbox keeps claiming the walk is on. */
      syncFormWalkToggle(walker) {
        syncDriftToggle()
        // Re-dim from the walker, not the checkbox: setting `.checked` in code
        // fires no `change`, so the listener would never hear of freezeForm().
        syncDrivenActive()
      },
      bindAtmosphere(atmosphere) {
        boundAtmosphere = atmosphere
        // The WALK decides whether the two condition scalars move on their own;
        // the master (no UI control; on by default, see atmosphere.js) decides
        // whether the weather writes the Colour-tab params at all. A row is
        // dimmed only by the switch that overwrites it.
        initDriftToggle()
        bindOwner('atmosphere', atmosphere.params)
        // One owner binds everything it holds a control for: the settings,
        // the walked scalars, and the clear/heavy profile rows.
        const own = atmosphere.params
        for (const row of generated) {
          const e = authoredThroughClear(row)
          if (!e) continue
          const key = `clear.${e.key}`
          bind(row, { get: () => own.get(key), set: (_k, v) => own.set(key, v), onChange: (_k, fn) => own.onChange(key, fn) })
        }
        // The drift box and the dimming follow the two flags that decide them,
        // however they change (a snapshot, a probe).
        for (const key of ['enabled', 'walking']) own.onChange(key, syncWeatherDriven)
        syncWeatherDriven()
      },
      setPaused(on) {
        sim.params.set('paused', !!on)
        // Covers callers that write new state around this (snapshot restore,
        // the probe hook) without a DOM event initRenderDirtyTracking would see.
        needsRender = true
      },
      /** Force one more frame even while paused (main.js: resize, snapshot import). */
      markDirty() { needsRender = true },
      /** Read+clear the dirty flag — main.js calls this at most once per frame. */
      consumeNeedsRender() {
        const v = needsRender
        needsRender = false
        return v
      },
      // Called every rendered frame regardless of pause/visibility. A fixed-rate
      // EMA (not dt-scaled): it only smooths a diagnostic readout.
      reportFrameTime(ms) {
        frameMsEma = frameMsEma === 0 ? ms : frameMsEma + (ms - frameMsEma) * 0.1
        perfTab.recordFrame(ms)
        if (!debugEl.classList.contains('visible')) return
        for (const sync of liveViews) sync()
        document.getElementById('val-frametime').textContent = frameMsEma.toFixed(1)
        document.getElementById('val-fps').textContent = (1000 / frameMsEma).toFixed(0)
      },
      // The CPU's own share of the frame: the time the render loop spent
      // issuing work, start to end (main.js). The GPU runs after it on its
      // own, so this is NOT the frame's cost — the Performance tab says so.
      reportJsTime(ms) { perfTab.recordJs(ms) },
    }
  }

  // ─── Weather (atmosphere.js) ───────────────────────────────────────────────
  // The panel half of the weather: atmosphere.js owns the two scalars and their
  // walk; weatherDriver.js owns every uniform they reach; this owns the DOM half
  // (which controls are marked driven, and the clear/heavy sliders). The weather
  // writes through the same setters the sliders use, so those sliders stay in
  // step instead of showing stale values.
  //
  // CLEAR / HEAVY. Each driven parameter is `mix(clear, heavy, w)`. `heavy` is
  // authored on the Sky tab; `clear` is the live value the scene had before the
  // weather touched it, and is written back verbatim when the weather goes off.
  // So the rest of the panel stays the authority on what a clear day looks
  // like, w = 0 reproduces it exactly, and switching the weather off is a
  // restore, not a reset to a second set of defaults.
  //
  // This section is stateless on purpose: `clear` lives in atmosphere.js's state,
  // so it survives snapshots. A closure variable here would be invisible to
  // captureScene/applyScene, and a clear lost in a snapshot makes a restore apply
  // the weather a second time (see atmosphere.js's header).

  // The weather marks which controls it drives, from the rows of the live params
  // (weatherDriver.js's weatherLockedIds). `clear`/`heavy` rows are not among them.
  function initAtmosphere() {
    driven.declare('weather-master', weatherLockedIds(PANEL_ROWS))
    // The two condition sliders answer to the WALK, not the master.
    driven.declare('weather-walk', weatherWalkIds())
  }

  /**
   * Bring the drift box and the dimmed rows in line with the weather's flags:
   * each control follows its own param, but these follow two drivers' enable
   * flags.
   */
  function syncWeatherDriven() {
    syncDriftToggle()
    syncDrivenActive()
  }

  /**
   * The one drift switch, standing in front of TWO independent drifts: the
   * form walker and the weather walk. They stay separate underneath — separate
   * enable flags, separate snapshot state, separate range/speed sliders, and
   * separate dim conditions (the weather's condition rows answer to the walk,
   * the Colour rows it writes answer to the always-on master).
   *
   * That means the two can genuinely disagree, and a plain checkbox would have
   * to lie about it. freezeForm() stops ONLY the walker, and a snapshot or a
   * test can set either on its own. So the box is TRI-STATE: checked when both
   * drift, unchecked when neither does, and `indeterminate` when they differ —
   * rather than picking one of the two to believe and silently misreporting the
   * other. Clicking it commits both to the same state, which is the point of
   * having one switch.
   */
  function initDriftToggle() {
    const box = document.getElementById('tog-scene-drift')
    if (box.dataset.bound) return          // both binders call this; wire once
    box.dataset.bound = '1'
    box.addEventListener('change', () => {
      const on = box.checked
      if (boundWalker) boundWalker.params.set('enabled', on)
      if (boundAtmosphere) {
        boundAtmosphere.params.set('walking', on)
      }
      syncDrivenActive()
      syncDriftToggle()
    })
    syncDriftToggle()
  }

  /** Re-read the tri-state drift box from the two drivers themselves. */
  function syncDriftToggle() {
    const box = document.getElementById('tog-scene-drift')
    if (!box) return
    const form    = boundWalker ? boundWalker.params.get('enabled') : box.checked
    const weather = boundAtmosphere ? boundAtmosphere.params.get('walking') : box.checked
    box.checked = form && weather
    box.indeterminate = form !== weather
  }

  // ─── Scene snapshot ─────────────────────────────────────────────────────────
  function initSnapshot() {
    // formWalker and atmosphere are getters: main.js builds them from
    // `controls`, so they do not exist yet when this section runs.
    //
    // Exposed as `controls.snapshotDeps`: main.js's window.__d handle
    // (captureSnapshot/applySnapshot) reuses this same object, so the Export
    // button and the test path can never capture different module sets.
    const deps = { terrain, water, clouds, form, artPass, godrays, sky, dynamics, animSpeed, audio, flyCamera, scene, renderer, applyHorizon, forgetHorizon,
      setPaused: controls.setPaused,
      get formWalker() { return boundWalker },
      get atmosphere() { return boundAtmosphere } }
    controls.snapshotDeps = deps
    initSnapshotButtons(deps)
  }
}
