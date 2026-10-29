/**
 * panelRows.js — the rows the debug panel can show a control for: every
 * owner's rows (their own *Params.js files) without the `hidden` ones, plus the
 * panel-only sky swatch. The panel looks a row up by id here (paramPanel.js's
 * generateGroups) and binds it through its owner's `params` (debugPanel.js).
 */
import { TERRAIN_PARAMS } from '../terrain/terrainParams.js'
import { WATER_PARAMS } from '../water/waterParams.js'
import { CLOUD_PARAMS } from '../clouds/cloudParams.js'
import { GODRAY_PARAMS } from '../clouds/godrayParams.js'
import { SCENE_PARAMS } from '../shared/sceneParams.js'
import { ART_ROWS } from '../artpass/artPassParams.js'
import { AUDIO_PARAMS } from '../audio/audioParams.js'
import { MIC_PARAMS } from '../interaction/interactionParams.js'
import { FLY_PARAMS } from '../scene/flyCameraParams.js'
import { SKY_PARAMS } from '../render/skyParams.js'
import { DYNAMICS_PARAMS, ANIM_SPEED_PARAMS } from '../dynamics/dynamicsParams.js'
import { FORM_WALKER_PARAMS } from '../drift/formWalkerParams.js'
import { ATMOSPHERE_PARAMS } from '../drift/atmosphereParams.js'
import { DISPLAY_PARAMS } from '../render/display.js'
import { SIM_PARAMS } from '../shared/simState.js'
import { FORM_PARAMS } from '../scene/formParams.js'
import { SKY_SWATCH_ROW } from './panelLayout.js'

export const PANEL_ROWS = [
  ...TERRAIN_PARAMS, ...WATER_PARAMS, ...CLOUD_PARAMS, ...GODRAY_PARAMS, ...SCENE_PARAMS, ...ART_ROWS,
  ...AUDIO_PARAMS, ...MIC_PARAMS, ...FLY_PARAMS, ...SKY_PARAMS,
  ...DYNAMICS_PARAMS, ...ANIM_SPEED_PARAMS, ...FORM_WALKER_PARAMS, ...ATMOSPHERE_PARAMS,
  ...DISPLAY_PARAMS, ...SIM_PARAMS, ...FORM_PARAMS,
].filter(r => r.kind !== 'hidden').concat(SKY_SWATCH_ROW)
