/**
 * drivenRegistry.js — who is currently writing which panel control.
 *
 * Several system drivers write sliders behind the user's back: the form
 * walker, the weather's master, the weather's walk, the cloud-density dial. A
 * control one of them owns has to SAY so; otherwise moving it looks broken,
 * because the change is overwritten on the next tick.
 *
 * SET UNION  Each driver declares the ids it owns, from next to the code that
 *   writes them, and a control is owned if ANY active driver claims it. Two
 *   drivers claiming one control is ordinary, not a conflict, and no driver
 *   needs to know the others exist. The ownership lives here in JS, never as a
 *   class in the markup: a hand-kept copy there outlives the driver's row and
 *   leaves a control dimmed for a driver that no longer writes it.
 *
 * OWNERSHIP  is not binary:
 *   CLOBBERED  the driver writes the control's value outright; anything you
 *              set is gone next tick.
 *   SCALED     the driver multiplies the control's value by a factor of its
 *              own (the cloud-density dial does this to the light-shaft
 *              intensity and the cloud-shadow amount). The control keeps real
 *              authority over its value, so disabling it would be a lie, but
 *              its EFFECT is not what the number shows, so it gets its own mark.
 *
 * Free of the DOM so the resolution is unit-testable; debugPanel sets the
 * classes.
 */

/** No active driver is writing this control. */
export const FREE = 'free'
/** An active driver overwrites this control's value outright. */
export const CLOBBERED = 'clobbered'
/** An active driver multiplies this control's value by a factor of its own. */
export const SCALED = 'scaled'

export function createDrivenRegistry() {
  /** @type {{driverId: string, id: string, state: string}[]} */
  const declarations = []
  const active = new Set()

  return {
    /**
     * Say that `driverId` owns `ids` whenever it is active.
     * Called once per driver, from next to the code that does the writing.
     */
    declare(driverId, ids, state = CLOBBERED) {
      for (const id of ids) {
        if (id) declarations.push({ driverId, id, state })
      }
    },

    /** Turn a driver's claim on or off — from the DRIVER's state, never from a
     *  checkbox, which can be set in code without firing an event. */
    setActive(driverId, on) {
      if (on) active.add(driverId)
      else active.delete(driverId)
    },

    isActive(driverId) { return active.has(driverId) },

    /**
     * controlId -> the strongest claim any ACTIVE driver makes on it.
     * CLOBBERED beats SCALED: if one driver overwrites the value outright, it
     * does not matter that another merely scales it.
     */
    resolve() {
      const out = new Map()
      for (const { driverId, id, state } of declarations) {
        if (!active.has(driverId)) continue
        if (out.get(id) === CLOBBERED) continue
        out.set(id, state)
      }
      return out
    },

    /** Every id any driver has declared, active or not — for the guard test. */
    declaredIds() {
      return [...new Set(declarations.map(d => d.id))]
    },
  }
}
