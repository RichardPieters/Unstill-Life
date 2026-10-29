/**
 * panelLayout.js — which row's control goes where in the debug panel.
 *
 * index.html keeps its tabs, headings, notes and buttons and holds a host
 * `<div data-param-group="tab.section">` wherever controls of param rows
 * belong; paramPanel.js fills each host with the controls of the rows LAYOUT
 * lists for it, in list order. A host's name is its tab and the heading it sits
 * under (a second host under one heading gets `-2`).
 *
 * Hosts the panel builds itself — the art pass's (ART_HOSTS), one per species
 * (speciesLayout) — get their lists from the row files' own order and groups.
 *
 * tests/unit/panelLayout.test.js checks that every row with a control is listed
 * exactly once, that every list names a row, and that every host in index.html
 * has a list.
 */
import { SPECIES } from '../terrain/treeSpecies.js'
import { TERRAIN_SPECIES_PARAMS } from '../terrain/terrainParams.js'
import { ART_GROUPS, ART_ROWS } from '../artpass/artPassParams.js'
import { weatherProfileIds, weatherWalkIds } from '../drift/atmosphereParams.js'

/** Hosts written into index.html. */
export const MARKUP_LAYOUT = {
  'live.interaction': [
    'ctrl-momentum-inertia', 'ctrl-settle-interval', 'ctrl-unfreeze-attention', 'ctrl-anim-speed',
    'ctrl-wave-weather-gain', 'ctrl-cloud-weather-gain',
  ],
  'driven.form-drift': [
    'ctrl-walk-spread', 'ctrl-walk-rate',
  ],
  'driven.cloud-and-sky-drift': [
    'ctrl-atmo-spread', 'ctrl-atmo-rate',
  ],
  'driven.weather': weatherWalkIds(),
  'driven.form-dials': [
    'ctrl-form-ocean', 'ctrl-form-mountains',
  ],
  'driven.snowline': [
    'ctrl-snow-base',
  ],
  'driven.cloud-dials': [
    'ctrl-cdial-scatter', 'ctrl-cdial-density',
  ],
  'terrain.landform': [
    'tog-basefbm', 'ctrl-octaves', 'ctrl-segments', 'f0-freq', 'f0-amp', 'f1-freq', 'f1-amp',
    'ctrl-ridge-amt', 'ctrl-ridge-round',
  ],
  'terrain.bedrock-and-mantle': [
    'ctrl-bedrock-octaves', 'ctrl-mantle-relief', 'ctrl-mantle-bias',
  ],
  'terrain.rock-gate': [
    'ctrl-gate-amt', 'ctrl-gate-lo', 'ctrl-gate-hi',
  ],
  'terrain.rock-look': [
    'ctrl-rock-ridge', 'ctrl-rock-persist', 'ctrl-rock-aniso', 'ctrl-rock-joint',
  ],
  'terrain.inspect': [
    'field-solo',
  ],
  'terrain.erosion': [
    'tog-erosion', 'ctrl-ero-scale', 'ctrl-ero-strength', 'ctrl-ero-gully', 'ctrl-ero-time',
    'ctrl-ero-detail', 'ctrl-ero-octaves', 'ctrl-ero-ridge-round', 'ctrl-ero-crease-round',
    'ctrl-ero-input-round', 'ctrl-ero-peak',
  ],
  'terrain.fbm-debug': [
    'tog-time-axis', 'tog-drift',
    'fbm-basespeed-0', 'fbm-basespeed-1',
  ],
  'terrain.fbm0': [
    'f0-timespeed',
  ],
  'terrain.fbm0-2': [
    'f0-persistence', 'f0-lacunarity',
  ],
  'terrain.fbm1': [
    'f1-timespeed',
  ],
  'terrain.fbm1-2': [
    'f1-persistence', 'f1-lacunarity',
  ],
  'biome.zonation': [
    'ctrl-tree-base', 'ctrl-tree-aspect', 'ctrl-tree-wind', 'ctrl-scree-band', 'ctrl-cliff-flat',
    'ctrl-pasture-flat', 'ctrl-riparian', 'ctrl-hollow-radius', 'ctrl-crease-radius',
    'ctrl-height-lo', 'ctrl-height-hi',
  ],
  'biome.shore': [
    'ctrl-shore-width', 'ctrl-shore-noise', 'ctrl-beach-flat', 'ctrl-beach-moist',
  ],
  'water.sea-band': [
    'ctrl-sea-low', 'ctrl-sea-high',
  ],
  'water.surface': [
    'ctrl-ripple', 'ctrl-wave-noise', 'ctrl-water-depth', 'ctrl-water-bands', 'ctrl-water-reflect',
    'ctrl-reflect-terrain', 'ctrl-reflect-distort', 'ctrl-reflect-tiers', 'ctrl-reflect-res',
    'ctrl-distort-steps', 'ctrl-water-spec', 'ctrl-water-sparkle', 'ctrl-foam-width',
    'ctrl-foam-tiers', 'ctrl-foam-amt', 'ctrl-foam-noise',
  ],
  'clouds.top': [
    'tog-clouds',
  ],
  'clouds.top-2': [
    'ctrl-cvol-distance', 'ctrl-cvol-level', 'ctrl-cvol-height', 'ctrl-cvol-speed', 'ctrl-cvol-freq',
    'ctrl-cvol-density', 'ctrl-cvol-coverage', 'ctrl-cvol-coverage-ease', 'ctrl-cvol-absorb', 'ctrl-cvol-aniso',
  ],
  'clouds.detail': [
    'ctrl-cvol-steps', 'ctrl-cvol-step-size', 'ctrl-cvol-step-growth', 'ctrl-cvol-detail',
    'ctrl-cvol-light-steps', 'ctrl-cvol-light-step-size', 'ctrl-cvol-light-rate',
    'ctrl-cvol-ground-ease', 'ctrl-cvol-roll-rate',
  ],
  'clouds.weather-map': [
    'ctrl-cvol-weather-strength', 'ctrl-cvol-weather-scale', 'ctrl-cvol-weather-speed',
  ],
  'clouds.curl-noise-warp': [
    'ctrl-cvol-curl-freq', 'ctrl-cvol-curl-strength',
  ],
  'clouds.perlin-worley': [
    'ctrl-cvol-worley-freq', 'ctrl-cvol-worley-amount', 'ctrl-cvol-worley-erosion',
    'ctrl-cvol-worley-octaves',
  ],
  'clouds.horizon': [
    'ctrl-cvol-planet-curve',
  ],
  'clouds.posterize': [
    'ctrl-cloud-color-steps', 'ctrl-cloud-alpha-tiers',
  ],
  'clouds.shading': [
    'tog-cloud-sint', 'tog-cloud-powder', 'ctrl-cloud-powder-strength',
  ],
  'atmosphere.sky-gradient': [
    'ctrl-sky-reach',
  ],
  'atmosphere.conditions': [
    'ctrl-atmo-onset', 'ctrl-atmo-full',
  ],
  'atmosphere.clear': weatherProfileIds('clear'),
  'atmosphere.heavy-overcast': weatherProfileIds('heavy', 'overcast'),
  'atmosphere.heavy-haze': weatherProfileIds('heavy', 'haze'),
  'sound.top': [
    'ctrl-master-gain',
  ],
  'sound.balance': [
    'ctrl-wind-level', 'ctrl-surf-level', 'ctrl-surf-break-level', 'ctrl-bird-level',
    'ctrl-bird-rate', 'ctrl-reverb-level',
  ],
  'sound.trees': [
    'ctrl-tree-level', 'ctrl-leaf-level', 'ctrl-leaf-flutter', 'ctrl-leaf-tail', 'ctrl-leaf-tone',
  ],
  'sound.paint': [
    'ctrl-distance-depth', 'ctrl-distance-cutoff', 'tog-room-mode', 'tog-paint-sound',
    'ctrl-paint-level',
  ],
  'forest.top': [
    'tog-forest', 'ctrl-forest-cell', 'ctrl-forest-jitter', 'ctrl-forest-depth',
    'ctrl-forest-fillpad', 'ctrl-forest-band', 'ctrl-forest-grow', 'ctrl-forest-on-rock',
    'ctrl-forest-on-snow', 'ctrl-forest-on-mdw', 'ctrl-forest-on-shore', 'ctrl-forest-on-rip',
    'ctrl-forest-spillfade', 'ctrl-forest-ribthin', 'ctrl-forest-slopethin',
  ],
  'forest.forest-form': [
    'ctrl-forest-wobflat', 'ctrl-forest-slope', 'ctrl-forest-hgtflat', 'ctrl-forest-lod-hi',
  ],
  'colour.palette-colours': [
    'tog-diffuse', 'tog-fog', 'ctrl-sun-elev', 'ctrl-sun-azimuth', 'ctrl-shade-lo', 'ctrl-shade-hi',
    'ctrl-aerial-desat', 'ctrl-fog-curve', 'ctrl-fog-max', 'ctrl-shadow-value', 'ctrl-shadow-desat',
    'ctrl-shadow-hue-amt', 'ctrl-glow', 'ctrl-light-level',
  ],
  'colour.cloud-shadows': [
    'ctrl-cloudshadow-amt', 'ctrl-cloudshadow-abs', 'ctrl-cloudshadow-floor',
    'ctrl-cloudshadow-tiers',
  ],
  'colour.light-shafts': [
    'tog-godrays', 'ctrl-ray-intensity', 'ctrl-ray-density',
    'ctrl-ray-absorption', 'ctrl-ray-tiers', 'ctrl-ray-hardness', 'ctrl-ray-threshold',
    'ctrl-ray-cutsnap', 'ctrl-ray-gateonset', 'ctrl-ray-nearfade', 'ctrl-ray-deckfade',
    'ctrl-ray-drop', 'ctrl-ray-aniso', 'ctrl-ray-soften', 'ctrl-ray-maxdist', 'ctrl-ray-steps',
  ],
  'colour.light-shafts-2': [
    'ctrl-ray-color',
  ],
  'colour.light-shafts-3': [
    'ctrl-light-steps', 'ctrl-band-noise', 'ctrl-band-scale',
  ],
  'camera.top': [
    'tog-flycam',
  ],
  'camera.clearance': [
    'ctrl-cam-pit-radius',
  ],
  'camera.clearance-2': [
    'ctrl-cam-pit-floor', 'ctrl-cam-pit-ease',
  ],
  'mic.top': [
    'ctrl-mic-floor', 'ctrl-mic-span', 'ctrl-mic-tau', 'ctrl-mic-curve', 'ctrl-mic-fluxgain',
    'ctrl-mic-leakgain', 'ctrl-mic-leakdelay',
  ],
  'debugview.top': [
    'debug-view',
  ],
  'performance.frame': [
    'ctrl-pixel-ratio',
  ],
}

/** The palette swatches, in order. 'col-sky' is the horizon, which has no row of its own (see SKY_SWATCH_ROW). */
export const PALETTE_LAYOUT = {
  'colour.palette': [
    'col-forest', 'col-meadow', 'col-snow', 'col-rock', 'col-sand', 'col-riparian',
    'col-shadow', 'col-glow', 'col-water-deep', 'col-water-shallow', 'col-glint', 'col-sky',
  ],
}

/**
 * The sky swatch edits the horizon colour, a value four owners hold (the scene's
 * horizon owner fans it out), so there is no colour row for it; this row exists
 * for the panel only and is bound through a wrapper (debugPanel.js).
 */
export const SKY_SWATCH_ROW = {
  id: 'col-sky', owner: 'horizon', key: 'hex', kind: 'colour', encode: 'srgb', value: '#4a7ab5', label: 'sky',
}

/** One host per species: its crown colour, then its crown form sliders. */
export const speciesLayout = () => Object.fromEntries(SPECIES.map(s => [
  `forest.sp-${s.key}`,
  TERRAIN_SPECIES_PARAMS.filter(r => r.key.split(':')[1] === s.key).map(r => r.id),
]))

const artRows = (g, kind) => ART_ROWS.filter(r => r.group === g && r.kind === kind).map(r => r.id)

/**
 * The art pass's hosts in render order: a heading (if any), the host's name and
 * the ids it holds. Ground's radios follow its sliders, its swatches have a
 * container of their own, and the diagnostic views come last under "Inspect".
 */
export const ART_HOSTS = [
  ...ART_GROUPS.flatMap(g => [
    {
      heading: g.title, name: `artpass.${g.id}`,
      ids: [...artRows(g.id, 'slider'), ...artRows(g.id, 'radio'), ...artRows(g.id, 'toggle')],
    },
    ...(g.id === 'ground'
      ? [{ name: 'artpass.colours', className: 'dbg-colors', ids: ART_ROWS.filter(r => r.kind === 'colour').map(r => r.id) }]
      : []),
  ]),
  { heading: 'Inspect', name: 'artpass.inspect', ids: ART_ROWS.filter(r => r.kind === 'radio' && !r.group).map(r => r.id) },
]

/** Every host's id list, by host name. */
export const LAYOUT = {
  ...MARKUP_LAYOUT,
  ...PALETTE_LAYOUT,
  ...speciesLayout(),
  ...Object.fromEntries(ART_HOSTS.map(h => [h.name, h.ids])),
}
