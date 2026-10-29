/**
 * weatherDriver.js — the weather's write path: how the weather reaches
 * terrain, water, clouds, sky, the art pass and the scene-wide uniforms (fog,
 * light, cloud shadow: shared/sceneUniforms.js, written through its params).
 * No DOM.
 *
 * main.js builds one instance and hands its `applyWeather` (as `apply`) and
 * `live` to Atmosphere, so every weather write goes through the owners' params,
 * the same path the panel sliders use, and runs and is tested without the
 * panel. The debug panel imports weatherLockedIds; the form's density dial calls
 * reapplyWeather.
 *
 * LIVE       Every weather-driven parameter, from the one list the weather
 *            declares (drift/atmosphereParams.js WEATHER_PARAMS): each entry's
 *            `ref` ('owner.key') resolved to that owner's `params`. `live` is
 *            what Atmosphere captures its clear day from and what its clear rows
 *            write while it is off; applyWeather writes the blend through it.
 *            So a parameter cannot be driven without also being captured and
 *            restored. Panel controls follow the writes through the params' own
 *            change hooks, so nothing here tells the panel. The macro form
 *            dials write through scene/formDriver.js.
 */
import { overcastCurves, hazeCurves, colourCurves, shapeOvercast } from '../drift/atmosphereMath.js'
import { WEATHER_PARAMS, hexToInt, intToHex } from '../drift/atmosphereParams.js'
import { densityToWeatherEffect, absorptionToDensity } from '../drift/cloudDialsMath.js'

/**
 * The control ids the weather master dims while it runs: each driven param's
 * visible panel row, except those that opt out (WEATHER_PARAMS `locks`). A
 * param with no panel control (a hidden row) has no id.
 * @param {{id: string, owner: string, key: string}[]} panelRows
 */
export function weatherLockedIds(panelRows) {
  return WEATHER_PARAMS
    .filter(e => e.ref && e.locks !== false)
    .map(e => panelRows.find(r => `${r.owner}.${r.key}` === e.ref)?.id)
    .filter(Boolean)
}

export function createWeatherDriver({
  terrain, water, clouds, artPass, sky, scene, sceneUniforms, horizon,
}) {
  // ─── live: every weather-driven parameter, by the weather's key ────────────

  const owners = { terrain, water, clouds, artPass, sky, horizon, scene: sceneUniforms }
  const paramsOf = ref => {
    const [owner, key] = ref.split('.')
    return { params: owners[owner].params, key }
  }

  /**
   * One driven param as the weather sees it: a number, colours as 0xrrggbb
   * whatever the owner holds ('#rrggbb' for the art pass). Read from `read`
   * when the write path is not the one to read (the horizon's fan-out has no
   * value of its own to read back).
   */
  function liveTarget(e) {
    const writer = paramsOf(e.ref)
    const reader = paramsOf(e.read ?? e.ref)
    const asInt = v => (typeof v === 'string' ? hexToInt(v) : v)
    return {
      get: () => asInt(reader.params.get(reader.key)),
      set: v => {
        const hex = typeof writer.params.get(writer.key) === 'string'
        writer.params.set(writer.key, hex ? intToHex(v) : v)
      },
      onChange: fn => reader.params.onChange(reader.key, fn),
    }
  }
  const targets = Object.fromEntries(WEATHER_PARAMS.filter(e => e.ref).map(e => [e.key, liveTarget(e)]))

  /** What Atmosphere reads its clear day from and writes through while it is off. */
  const live = {
    get: key => targets[key].get(),
    set: (key, v) => targets[key].set(v),
    onChange: (key, fn) => targets[key].onChange(fn),
  }

  // three.js's own scene.fog is not a uniform: it follows the scene set's fog
  // range whoever writes it (the weather, a snapshot restore).
  sceneUniforms.params.onChange('fogNear', v => { scene.fog.near = v })
  sceneUniforms.params.onChange('fogFar',  v => { scene.fog.far = v })

  let lastAtmosphereState = null

  /**
   * Re-apply the last weather state: the form's density dial calls this when
   * its effect factor changes, because with the weather walk off nothing else
   * would push the new light strength to the scene.
   */
  function reapplyWeather() {
    if (lastAtmosphereState) applyWeather(lastAtmosphereState)
  }

  // ─── weather ───────────────────────────────────────────────────────────────

  /**
   * Write one weather state (atmosphere.js's getState()) onto the scene: the
   * clear values verbatim while the weather is off, else the overcast and haze
   * curves between clear and heavy.
   *
   * No scatter write here: `baseFreq` is a function of the scatter dial alone,
   * so it moves only when that dial does, never on a weather step.
   */
  function applyWeather(state) {
    lastAtmosphereState = state
    const { overcast, haze, enabled, clear, heavy, shape } = state
    // Nothing to write and nothing to restore. Reached on a snapshot that
    // turned the weather off while it was already off.
    if (!clear) return

    if (!enabled) {
      for (const key of Object.keys(targets)) live.set(key, clear[key])
      return
    }
    // Written by iterating what the curves RETURNED, not a hand-kept list of
    // setter calls, so a curve added in atmosphereMath.js cannot be computed
    // and then silently never written.
    const effectScale = densityToWeatherEffect(
      absorptionToDensity(clouds.params.get('absorption')))
    const lit  = overcastCurves(clear, heavy, overcast, shape, effectScale, haze)
    const dist = hazeCurves(clear, heavy, haze)
    for (const [key, value] of Object.entries({ ...lit, ...dist })) live.set(key, value)
    const litW = shapeOvercast(overcast, shape) * effectScale
    const colours = colourCurves(clear, heavy, litW, haze, lit.lightLevel / Math.max(clear.lightLevel, 1e-4))
    // Guarded, because these are the expensive writes: the horizon allocates a
    // THREE.Color and writes five targets and an art-pass colour write rebuilds its
    // ground, while this runs on every walk step. mixHex quantises to bytes, so
    // most steps land on the colour that is already up.
    for (const [key, hex] of Object.entries(colours)) {
      if (hex !== live.get(key)) live.set(key, hex)
    }
  }

  return { live, applyWeather, reapplyWeather }
}
