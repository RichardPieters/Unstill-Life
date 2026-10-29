/**
 * terrainParams.js — the terrain's param rows (shared/paramSchema.js): every
 * value the terrain can be set to, read back through `terrain.params`.
 * terrain.js seeds the uniforms from them and builds its accessor from them;
 * the panel binds the controls through panel/panelRows.js.
 *
 * DEFAULTS  `value` is the one default of each value. The form rows
 *   (`drivenBy: 'form'`) are numbers an ocean/mountains blend produced, which
 *   is why they sit off their step grid; main.js's boot form.apply overwrites
 *   them before the first frame. The weather rows are the clear-weather start
 *   the weather blends from; the palette rows take shared/palette.js's values.
 *
 * BACKING  a row that names a `uniform` writes it (terrain.js puts uErosion*
 *   and uCamPit* in the heightmap pass, every other one in the material). A
 *   row without one is a field of terrain.js (the driver's bases and
 *   switches, the mantle octaves, the segment count) or held by the accessor
 *   (the sun azimuth angle, from which the uSunAzimuth vector is derived).
 *
 * GENERATED  per fBM instance (fbmRows) and per species and crown property
 *   (speciesRows, from treeSpecies.js); their controls are in index.html and
 *   tabs/species.js respectively.
 */
import { SPECIES, SPECIES_FORM } from './treeSpecies.js'
import { PALETTE, hexString } from '../shared/palette.js'

const row = r => ({ owner: 'terrain', kind: 'slider', encode: 'float', ...r })
const hidden = r => row({ kind: 'hidden', id: `terrain.${r.key}`, ...r })
const toggle = r => row({ kind: 'toggle', encode: 'bool', value: true, ...r })
const cap = s => s[0].toUpperCase() + s.slice(1)

// The two fBM instances: few big mountains — low frequencies, high amplitudes —
// because the erosion filter carves the detail. Their frequencies and
// amplitudes are form-driven. Drift direction is angle-driven (terrainDriver);
// the H_NORM that sizes erosion depends on the amplitude SUM, which
// terrainDriver derives from the live amps.
const FBM_INSTANCES = [
  { freq: 0.0017766410942317156, amp: 85.26613643182003, timeSpeed: 0.015,
    persistence: 0.65,   // smooth hills, not sharp ridges
    lacunarity: 1.8,     // gentle scaling, not aggressive detail
    freqMax: 0.015 },
  { freq: 0.003083127952335604, amp: 44.95947475423699, timeSpeed: 0.025,
    persistence: 0.55, lacunarity: 1.9, freqMax: 0.025 },
]

function fbmRows() {
  return FBM_INSTANCES.flatMap((f, i) => [
    row({ id: `f${i}-freq`, key: `fbm${i}Freq`, uniform: `uFBM${i}Freq`, label: `freq${i}`,
      value: f.freq, min: 0.0005, max: f.freqMax, step: 0.0005, digits: 4, drivenBy: 'form' }),
    row({ id: `f${i}-amp`, key: `fbm${i}Amp`, uniform: `uFBM${i}Amp`, label: `amp${i}`,
      value: f.amp, min: 0, max: 150, step: 0.5, digits: 1, drivenBy: 'form' }),
    row({ id: `f${i}-timespeed`, key: `fbm${i}TimeSpeed`, uniform: `uFBM${i}TimeSpeed`, label: 'timeSpeed',
      value: f.timeSpeed, min: 0, max: 0.5, step: 0.005, digits: 3 }),
    row({ id: `f${i}-persistence`, key: `fbm${i}Persistence`, uniform: `uFBM${i}Persistence`, label: 'persistence',
      value: f.persistence, min: 0.2, max: 0.8, step: 0.01, digits: 2 }),
    row({ id: `f${i}-lacunarity`, key: `fbm${i}Lacunarity`, uniform: `uFBM${i}Lacunarity`, label: 'lacunarity',
      value: f.lacunarity, min: 1.5, max: 3, step: 0.05, digits: 2 }),
    // Drift magnitude, world units per noiseTime unit (a terrainDriver field).
    row({ id: `fbm-basespeed-${i}`, key: `baseSpeed${i}`, label: `speed${i}`,
      value: 4, min: 0.1, max: 4, step: 0.05, digits: 3 }),
  ])
}


/** One row per species × crown property, and one crown colour per species. */
function speciesRows() {
  return SPECIES.flatMap((s, i) => [
    row({ id: `terrain.sp:${s.key}:color`, key: `sp:${s.key}:color`, kind: 'colour', encode: 'srgb',
      uniform: 'uSpColor', index: i, value: hexString(PALETTE.crown[s.key]), label: 'crown colour' }),
    ...SPECIES_FORM.map(p => row({ id: `ctrl-sp${i}-${p.key}`, key: `sp:${s.key}:${p.key}`,
      uniform: p.uniform, index: i, value: s.form[p.key],
      min: p.min, max: p.max, step: p.step, digits: p.digits, label: p.label })),
  ])
}

// The palette's biomes (shared/palette.js `terrain`, `glow`, `shade`): one
// colour, alpenglow susceptibility and shadow floor each.
const BIOMES = Object.keys(PALETTE.terrain).map(b =>
  [b, hexString(PALETTE.terrain[b]), PALETTE.glow[b], PALETTE.shade[b]])

function paletteRows() {
  return [
    ...BIOMES.map(([b, colour]) => row({ id: `col-${b}`, key: `col${cap(b)}`, kind: 'colour', encode: 'srgb',
      uniform: `uCol${cap(b)}`, value: colour, label: b })),
    row({ id: 'col-shadow', key: 'shadowHue', kind: 'colour', encode: 'srgb', uniform: 'uShadowHue',
      value: hexString(PALETTE.light.shadowHue), label: 'shadow' }),
    row({ id: 'col-glow', key: 'glowHue', kind: 'colour', encode: 'srgb', uniform: 'uGlowHue',
      value: hexString(PALETTE.light.glowHue), label: 'glow' }),
    ...BIOMES.map(([b, , glow]) => hidden({ key: `glow${cap(b)}`, uniform: `uGlow${cap(b)}`, value: glow })),
    // Per-material shadow susceptibility (local value, material.glsl shadeMaterial).
    ...BIOMES.map(([b, , , shade]) => hidden({ key: `shade${cap(b)}`, uniform: `uShade${cap(b)}`, value: shade })),
  ]
}

export const TERRAIN_SPECIES_PARAMS = speciesRows()

export const TERRAIN_PARAMS = [
  // ── fBM instances, drift and time ────────────────────────────────────────
  ...fbmRows(),
  // Mantle octave count, both instances (a field: one value, two uniforms). 3
  // because the erosion filter supplies the fine detail; slide up to 8 when
  // erosion is off.
  row({ id: 'ctrl-octaves', key: 'mantleOctaves', label: 'octaves', value: 3, min: 1, max: 8, step: 1, digits: 0 }),
  // When off, the terrain is a rigid pattern that only translates.
  toggle({ id: 'tog-time-axis', label: 'time axis', key: 'timeAxis', uniform: 'uEnableTimeAxis' }),
  toggle({ id: 'tog-basefbm', label: 'base fBM', key: 'baseFBM', uniform: 'uEnableBaseFBM' }),
  // terrainDriver field: the direction random walk.
  toggle({ id: 'tog-drift', label: 'spatial drift', key: 'driftEnabled' }),
  // Holds the driver's tick still for a deterministic readback (tests/signals/
  // probe.js and several visual specs). Not a panel control.
  hidden({ key: 'frozen', encode: 'bool', value: false, persist: false }),

  // ── Bedrock / mantle two-field placement (see fbm.glsl) ──────────────────
  // Bedrock's own octave count, above the mantle's, so the two fields differ in
  // fine detail; that difference breaks the soil line into ribs instead of a
  // smooth contour. Equal counts collapse the crossing onto the K = 0 contour
  // (F degenerates to rho·K). The shader clamps it up to the mantle count, so a
  // value below that behaves as "equal", not as an inverted field.
  row({ id: 'ctrl-bedrock-octaves', key: 'bedrockOctaves', uniform: 'uBedrockOctaves', label: 'bedrock octaves',
    value: 6, min: 1, max: 8, step: 1, digits: 0, drivenBy: 'form' }),
  // rho — mantle relief as a FRACTION of bedrock's. A ratio, not an amplitude,
  // so the crossing is invariant to the amp sliders. The coherence ceiling
  // measured for a bare max() is ~0.45 (mask boundary length 9583 → 24124 going
  // 0.45 → 0.90); the default sits at it.
  row({ id: 'ctrl-mantle-relief', key: 'mantleRelief', uniform: 'uMantleRelief', label: 'mantle relief ρ',
    value: 0.45046442303688594, min: 0, max: 1, step: 0.05, digits: 2, drivenBy: 'form' }),
  // Renders ONE field as the entire surface, so its noise can be judged alone:
  // 0 composed · 1 bedrock alone (no max(), no mantle: exactly what fbmDual
  // accumulates) · 2 mantle alone.
  row({ id: 'field-solo', key: 'fieldSolo', uniform: 'uFieldSolo', kind: 'radio', value: 0,
    options: [
      { value: 0, label: 'show: composed surface' },
      { value: 1, label: 'show: bedrock field alone' },
      { value: 2, label: 'show: mantle field alone' },
    ] }),
  // Adaptive-grid segments per side (a field: a change rebuilds the geometry).
  row({ id: 'ctrl-segments', key: 'segments', encode: 'int', label: 'mesh segments',
    value: 800, min: 50, max: 800, step: 50, digits: 0 }),

  // ── Erosion filter (heightmap material) ──────────────────────────────────
  toggle({ id: 'tog-erosion', label: 'erosion filter', key: 'erosion', uniform: 'uErosionEnabled' }),
  // uErosionTimeSpeed: the gully pattern's phase drift.
  row({ id: 'ctrl-ero-time', key: 'timeSpeed', uniform: 'uErosionTimeSpeed',
    label: 'gully drift', value: 0.03, min: 0, max: 0.1, step: 0.002, digits: 3 }),
  row({ id: 'ctrl-ero-scale', key: 'scale', uniform: 'uErosionScale',
    label: 'ero scale', value: 0.06, min: 0.02, max: 0.4, step: 0.01, digits: 2 }),
  row({ id: 'ctrl-ero-strength', key: 'strength', uniform: 'uErosionStrength',
    label: 'ero strength', value: 0.6, min: 0, max: 0.6, step: 0.01, digits: 2 }),
  row({ id: 'ctrl-ero-gully', key: 'gullyWeight', uniform: 'uErosionGullyWeight',
    label: 'gully weight', value: 0.1, min: 0, max: 1, step: 0.05, digits: 2 }),
  row({ id: 'ctrl-ero-detail', key: 'detail', uniform: 'uErosionDetail',
    label: 'ero detail', value: 3, min: 0.5, max: 3, step: 0.1, digits: 1 }),
  row({ id: 'ctrl-ero-octaves', key: 'octaves', uniform: 'uErosionOctaves',
    label: 'ero octaves', value: 3, min: 1, max: 6, step: 1, digits: 0 }),
  row({ id: 'ctrl-ero-ridge-round', key: 'erosionRidgeRound', uniform: 'uErosionRidgeRound',
    label: 'ridge round', value: 1, min: 0, max: 1, step: 0.05, digits: 2 }),
  row({ id: 'ctrl-ero-crease-round', key: 'creaseRound', uniform: 'uErosionCreaseRound',
    label: 'crease round', value: 1, min: 0, max: 1, step: 0.05, digits: 2 }),
  // Rounding multiplier on the INPUT height function (rounding.z). Gates how
  // much ridge/crease rounding applies at base-fBM peaks — the spike fix: at 0.1
  // (the runevision demo value) the ridge-round slider barely affected the
  // combiMask transition at summits, leaving needle spikes. Scale with the
  // base-wavelength : gully-wavelength ratio (ours ~5x the demo's).
  row({ id: 'ctrl-ero-input-round', key: 'inputRound', uniform: 'uErosionInputRound',
    label: 'input round', value: 2, min: 0, max: 2, step: 0.05, digits: 2 }),
  // Summit-cone control (fade-to-target magnitude at flat spots). The filter
  // deliberately sharpens peaks toward ±1 there; at our scale that is a ~30-unit
  // needle no other slider touches. 1 = original, 0 = flat.
  row({ id: 'ctrl-ero-peak', key: 'peakSharpen', uniform: 'uErosionPeakSharpen',
    label: 'peak sharpen', value: 0.25, min: 0, max: 1, step: 0.05, digits: 2 }),

  // ── Camera-safety pit (heightmap material) ───────────────────────────────
  row({ id: 'ctrl-cam-pit-radius', key: 'camPitRadius', uniform: 'uCamPitRadius',
    label: 'pit radius', value: 300, min: 10, max: 700, step: 10, digits: 0 }),
  // Floor's slider max is held below CAM_POSITION.y with margin (tests/unit/
  // paramRows.test.js checks it), so no configuration of the radius/floor pair
  // can let the camera's own column clip.
  row({ id: 'ctrl-cam-pit-floor', key: 'camPitFloor', uniform: 'uCamPitFloor',
    label: 'pit floor', value: 30, min: 0, max: 40, step: 1, digits: 0 }),
  // Ease-out power: 1 = linear, higher = heavier.
  row({ id: 'ctrl-cam-pit-ease', key: 'camPitEase', uniform: 'uCamPitEase',
    label: 'pit ease', value: 4, min: 1, max: 8, step: 0.5, digits: 1 }),

  // ── Biome zonation (terrain material) ────────────────────────────────────
  // Treeline, tH units — above it the ground is meadow.
  row({ id: 'ctrl-tree-base', key: 'treeBase', uniform: 'uTreeBase',
    label: 'tree base', value: 0.78, min: 0, max: 1, step: 0.01, digits: 2 }),
  row({ id: 'ctrl-tree-aspect', key: 'treeAspect', uniform: 'uTreeAspect',
    label: 'tree aspect', value: 0.14, min: 0, max: 0.4, step: 0.01, digits: 2 }),
  // Convex, wind-scoured ground lowers the treeline.
  row({ id: 'ctrl-tree-wind', key: 'treeWind', uniform: 'uTreeWind',
    label: 'tree wind', value: 0.15, min: 0, max: 0.6, step: 0.05, digits: 2 }),
  row({ id: 'ctrl-snow-base', key: 'snowBase', uniform: 'uSnowBase',
    label: 'snow base', value: 0.8934521755657023, min: 0.4, max: 1, step: 0.01, digits: 2, drivenBy: 'form' }),
  row({ id: 'ctrl-scree-band', key: 'screeBand', uniform: 'uScreeBand',
    label: 'scree band', value: 0.12, min: 0, max: 0.25, step: 0.01, digits: 2 }),
  row({ id: 'ctrl-cliff-flat', key: 'cliffFlat', uniform: 'uCliffFlat',
    label: 'cliff flat', value: 0.85, min: 0, max: 1, step: 0.01, digits: 2 }),
  row({ id: 'ctrl-pasture-flat', key: 'pastureFlat', uniform: 'uPastureFlat',
    label: 'pasture flat', value: 0.98, min: 0.5, max: 1, step: 0.01, digits: 2 }),
  row({ id: 'ctrl-riparian', key: 'riparian', uniform: 'uRiparian',
    label: 'riparian', value: 0.15, min: 0, max: 1, step: 0.05, digits: 2 }),
  // Large ring: valley-scale concavity (world units).
  row({ id: 'ctrl-hollow-radius', key: 'hollowRadius', uniform: 'uHollowRadius',
    label: 'hollow radius', value: 60, min: 30, max: 400, step: 10, digits: 0 }),
  // Small ring: gully-scale concavity (world units).
  row({ id: 'ctrl-crease-radius', key: 'creaseRadius', uniform: 'uCreaseRadius',
    label: 'crease radius', value: 15, min: 10, max: 100, step: 5, digits: 0 }),
  row({ id: 'ctrl-beach-flat', key: 'beachFlat', uniform: 'uBeachFlat',
    label: 'beach flat', value: 0.66, min: 0, max: 1, step: 0.01, digits: 2 }),
  row({ id: 'ctrl-beach-moist', key: 'beachMoist', uniform: 'uBeachMoist',
    label: 'beach moist', value: 0.6, min: 0, max: 1, step: 0.01, digits: 2 }),

  // ── Forest (terrain material) — see terrain/shaders/includes/forest.glsl ─
  // Lattice pitch, world units (4 gives 3.3 wu site spacing).
  row({ id: 'ctrl-forest-cell', key: 'forestCell', uniform: 'uForestCell',
    label: 'cell (wu)', value: 4, min: 1, max: 30, step: 0.5, digits: 1 }),
  // Breaks up the lattice; the slider max is its default.
  row({ id: 'ctrl-forest-jitter', key: 'forestJitter', uniform: 'uForestJitter',
    label: 'jitter', value: 0.2, min: 0, max: 0.2, step: 0.01, digits: 2 }),
  // Cel tone steps a crown may swing.
  row({ id: 'ctrl-forest-depth', key: 'forestDepth', uniform: 'uForestDepth',
    label: 'tone depth', value: 0.4, min: 0, max: 3, step: 0.05, digits: 2 }),
  // Spill shaping: structure for the trees the floors above allow past a biome
  // boundary (material.glsl forestSpill). Without it the spill is a uniform random
  // scatter over the meadow.
  row({ id: 'ctrl-forest-spillfade', key: 'forestSpillFade', uniform: 'uForestSpillFade',
    label: 'spill reach', value: 0.04, min: 0.01, max: 0.4, step: 0.01, digits: 2 }),
  row({ id: 'ctrl-forest-ribthin', key: 'forestRibThin', uniform: 'uForestRibThin',
    label: 'spill ribs', value: 0.45, min: 0, max: 1, step: 0.05, digits: 2 }),
  row({ id: 'ctrl-forest-slopethin', key: 'forestSlopeThin', uniform: 'uForestSlopeThin',
    label: 'spill slope', value: 0.4, min: 0, max: 1, step: 0.05, digits: 2 }),
  // How far past a biome edge the solid fill bleeds.
  row({ id: 'ctrl-forest-fillpad', key: 'forestFillPad', uniform: 'uForestFillPad',
    label: 'fill padding', value: 0.01, min: 0, max: 0.05, step: 0.002, digits: 3 }),
  // How softly each biome gate ramps.
  row({ id: 'ctrl-forest-band', key: 'forestBand', uniform: 'uForestBand',
    label: 'gate softness', value: 0.04, min: 0, max: 0.3, step: 0.01, digits: 2 }),
  // Wide: density also sets tree height.
  row({ id: 'ctrl-forest-grow', key: 'forestGrow', uniform: 'uForestGrow',
    label: 'grow window', value: 0.1, min: 0, max: 0.5, step: 0.01, digits: 2 }),
  // Per-biome likelihood floors (forest.glsl): 0 = trees never there. Riparian
  // is the one that stocks rather than thins: above 1 it drives the probability
  // to its clamp, so a gully floor is fully wooded while the hillside sits at the
  // forest baseline (probability 1).
  row({ id: 'ctrl-forest-on-rock', key: 'forestOnRock', uniform: 'uForestOnRock',
    label: 'on rock', value: 0, min: 0, max: 1, step: 0.01, digits: 2 }),
  row({ id: 'ctrl-forest-on-snow', key: 'forestOnSnow', uniform: 'uForestOnSnow',
    label: 'on snow', value: 0, min: 0, max: 1, step: 0.01, digits: 2 }),
  row({ id: 'ctrl-forest-on-mdw', key: 'forestOnMeadow', uniform: 'uForestOnMeadow',
    label: 'on meadow', value: 0.04, min: 0, max: 1, step: 0.01, digits: 2 }),
  row({ id: 'ctrl-forest-on-shore', key: 'forestOnShore', uniform: 'uForestOnShore',
    label: 'on shore', value: 0, min: 0, max: 1, step: 0.01, digits: 2 }),
  row({ id: 'ctrl-forest-on-rip', key: 'forestOnRiparian', uniform: 'uForestOnRiparian',
    label: 'on riparian', value: 2, min: 0, max: 2, step: 0.05, digits: 2 }),
  // ── Crown form ───────────────────────────────────────────────────────────
  // Crown form is always on; the values are per-species arrays (treeSpecies.js).
  // These three are value knobs for how strongly a term couples to
  // flatness/steepness. wobFlat: 1 = bite depth tracks flatness.
  row({ id: 'ctrl-forest-wobflat', key: 'forestWobFlat', uniform: 'uForestWobbleFlat',
    label: 'ragged ← flatness', value: 1, min: 0, max: 1, step: 0.05, digits: 2 }),
  // 1 = elongation/lean only on slopes.
  row({ id: 'ctrl-forest-slope', key: 'forestSlopeForm', uniform: 'uForestSlopeForm',
    label: 'slope gating', value: 0.75, min: 0, max: 1, step: 0.05, digits: 2 }),
  // Height tracks flatness.
  row({ id: 'ctrl-forest-hgtflat', key: 'forestHeightFlat', uniform: 'uForestHeightFlat',
    label: 'height ← flatness', value: 0.65, min: 0, max: 1, step: 0.05, digits: 2 }),
  row({ id: 'ctrl-forest-lod-hi', key: 'forestLodHi', uniform: 'uForestLodHi',
    label: 'lod hi', value: 0.45, min: 0.05, max: 4, step: 0.05, digits: 2 }),

  // ── Colour & light (terrain material) ────────────────────────────────────
  row({ id: 'ctrl-shadow-value', key: 'shadowValue', uniform: 'uShadowValue',
    label: 'shadow val', value: 0.05, min: 0, max: 1, step: 0.01, digits: 2, drivenBy: 'weather' }),
  row({ id: 'ctrl-shadow-desat', key: 'shadowDesat', uniform: 'uShadowDesat',
    label: 'shadow desat', value: 0.65, min: 0, max: 1, step: 0.05, digits: 2 }),
  // The shadow-hue push in material.glsl's toShadow. Desaturating the shadows
  // needs this too: shadowDesat reaches only the term this one then mixes a
  // fully saturated hue back into.
  row({ id: 'ctrl-shadow-hue-amt', key: 'shadowHueAmt', uniform: 'uShadowHueAmt',
    label: 'shadow hue amt', value: 0.07, min: 0, max: 1, step: 0.01, digits: 2, drivenBy: 'weather' }),
  row({ id: 'ctrl-glow', key: 'glow', uniform: 'uGlow',
    label: 'alpenglow', value: 0.26, min: 0, max: 1, step: 0.05, digits: 2, drivenBy: 'weather' }),
  // Vertical component of the sun direction (1 = overhead, ~0.3 = grazing).
  row({ id: 'ctrl-sun-elev', key: 'sunElevation', uniform: 'uSunElevation',
    label: 'sun elevation', value: 0.45, min: 0.05, max: 2, step: 0.05, digits: 2 }),
  // Sun's horizontal (compass) direction, degrees. Held by the accessor;
  // terrain.js derives the uSunAzimuth (x, z) vector from it at a fixed radius,
  // so rotating the sun does not also change how strongly it lights the
  // terrain (elevation alone owns that axis).
  row({ id: 'ctrl-sun-azimuth', key: 'sunAzimuth',
    label: 'sun azimuth', value: 336, min: 0, max: 360, step: 1, digits: 1 }),
  // N·L remap window: shade lo/hi.
  row({ id: 'ctrl-shade-lo', key: 'shadeLo', uniform: 'uShadeLo', pair: { with: 'shadeHi', order: 'lo' },
    label: 'shade lo', value: -0.2, min: -1, max: 1, step: 0.05, digits: 2 }),
  row({ id: 'ctrl-shade-hi', key: 'shadeHi', uniform: 'uShadeHi', pair: { with: 'shadeLo', order: 'hi' },
    label: 'shade hi', value: 1, min: -1, max: 1, step: 0.05, digits: 2 }),
  // Height-to-colour spread (normalised): lo → the deep end, hi → the peak end.
  row({ id: 'ctrl-height-lo', key: 'heightLo', uniform: 'uHeightLo', pair: { with: 'heightHi', order: 'lo' },
    label: 'height lo', value: 0.3, min: 0, max: 1, step: 0.01, digits: 2 }),
  row({ id: 'ctrl-height-hi', key: 'heightHi', uniform: 'uHeightHi', pair: { with: 'heightLo', order: 'hi' },
    label: 'height hi', value: 0.72, min: 0, max: 1, step: 0.01, digits: 2 }),
  // Painterly material edge wobble: strength and spatial scale.
  row({ id: 'ctrl-band-noise', key: 'bandNoiseAmt', uniform: 'uBandNoiseAmt',
    label: 'band noise', value: 0.06, min: 0, max: 0.25, step: 0.01, digits: 2 }),
  row({ id: 'ctrl-band-scale', key: 'bandNoiseScale', uniform: 'uBandNoiseScale',
    label: 'band scale', value: 0.012, min: 0.002, max: 0.05, step: 0.002, digits: 3 }),
  ...paletteRows(),
  toggle({ id: 'tog-diffuse', label: 'diffuse shading', key: 'diffuse', uniform: 'uEnableDiffuse' }),
  toggle({ id: 'tog-fog', label: 'fog', key: 'fog', uniform: 'uEnableFog' }),
  // fBM-to-ridged per-octave blend (fbm.glsl octaveShape).
  row({ id: 'ctrl-ridge-amt', key: 'ridgeAmt', uniform: 'uRidgeAmt',
    label: 'ridge amount', value: 0.4226912089234138, min: 0, max: 1, step: 0.05, digits: 2, drivenBy: 'form' }),
  // Ridge-crease roundness epsilon: kills erosion-filter rill artifacts.
  row({ id: 'ctrl-ridge-round', key: 'ridgeRound', uniform: 'uRidgeRound',
    label: 'ridge roundness', value: 0.351348356784276, min: 0, max: 0.5, step: 0.01, digits: 2, drivenBy: 'form' }),
  // Shore, light steps, aerial perspective
  row({ id: 'ctrl-shore-width', key: 'shoreWidth', uniform: 'uShoreWidth',
    label: 'shore width', value: 2, min: 0, max: 20, step: 0.5, digits: 1 }),
  row({ id: 'ctrl-shore-noise', key: 'shoreNoiseAmt', uniform: 'uShoreNoiseAmt',
    label: 'shore noise', value: 0.75, min: 0, max: 2, step: 0.05, digits: 2 }),
  row({ id: 'ctrl-light-steps', key: 'lightSteps', uniform: 'uLightSteps',
    label: 'light steps', value: 4, min: 0, max: 8, step: 1, digits: 0 }),
  row({ id: 'ctrl-aerial-desat', key: 'aerialDesat', uniform: 'uAerialDesat',
    label: 'aerial desat', value: 0.55, min: 0, max: 1, step: 0.05, digits: 2, drivenBy: 'weather' }),

  // ── Rock character — the bedrock-only octaves (fbm.glsl §6) ─────────────
  // Creasing the rock octaves is the point, but the erosion filter carves ALONG
  // slope discontinuities by design (see octaveShape's note). uRidgeRound, shared
  // by every octave, rounds the fold's kink; with it near 0 the kink stays and
  // erosion cuts jagged rills along it.
  row({ id: 'ctrl-rock-ridge', key: 'rockRidge', uniform: 'uRockRidge',
    label: 'rock crease', value: 0.791769546539961, min: 0, max: 1, step: 0.05, digits: 2, drivenBy: 'form' }),
  // <= 1/lacunarity (0.556 at the default 1.8) so added octaves stop increasing
  // slope; this sits well under it. Above the instance persistence (0.65 / 0.55)
  // the rock octaves contribute more than the stock series the normalisation is
  // built from, so the field can overshoot uFBM*Amp (~17% at the slider's 0.9
  // ceiling, which clips into the top of the tH ramp). The intended regime
  // (<= 1/lacunarity) stays under it.
  row({ id: 'ctrl-rock-persist', key: 'rockPersist', uniform: 'uRockPersist',
    label: 'rock falloff', value: 0.33104159131006816, min: 0.2, max: 0.9, step: 0.01, digits: 2, drivenBy: 'form' }),
  // Joint stretch: blade-like rather than lumpy.
  row({ id: 'ctrl-rock-aniso', key: 'rockAniso', uniform: 'uRockAniso',
    label: 'joint stretch', value: 1.297335090776335, min: 1, max: 6, step: 0.1, digits: 2, drivenBy: 'form' }),
  // Radians; the three joint sets sit at this + k·60°.
  row({ id: 'ctrl-rock-joint', key: 'rockJoint', uniform: 'uRockJointAngle',
    label: 'joint angle', value: 0.6, min: 0, max: 3.14, step: 0.05, digits: 2 }),

  // ── Height gate — where rock detail may appear (fbm.glsl §7) ────────────
  // Height-gated roughness (fbm.glsl §7), always applied. lo/hi are levels on the
  // normalised mantle landform, which runs about ±1 with a standard deviation near
  // 0.26. amt < 1 leaves the remainder of the rock detail everywhere, so low
  // ground is quietened rather than erased.
  row({ id: 'ctrl-gate-amt', key: 'gateAmt', uniform: 'uRockGateAmt',
    label: 'gate amount', value: 0.8573261009635984, min: 0, max: 1, step: 0.05, digits: 2, drivenBy: 'form' }),
  row({ id: 'ctrl-gate-lo', key: 'gateLo', uniform: 'uRockGateLo', pair: { with: 'gateHi', order: 'lo' },
    label: 'gate low', value: -0.14984608009030498, min: -1, max: 1, step: 0.05, digits: 2, drivenBy: 'form' }),
  row({ id: 'ctrl-gate-hi', key: 'gateHi', uniform: 'uRockGateHi', pair: { with: 'gateLo', order: 'hi' },
    label: 'gate high', value: 0.8089174082401579, min: -1, max: 1, step: 0.05, digits: 2, drivenBy: 'form' }),

  // ── Soil level (fbm.glsl §5) ─────────────────────────────────────────────
  // World units the mantle is lifted by. An explicit override of the emergent
  // crossing: up means more soil and less exposed rock. uMantleDC does NOT cancel
  // it: the DC removes the statistical lift from max(), not an authored offset, so
  // a large change wants uSnowBase / uTreeBase re-checked.
  row({ id: 'ctrl-mantle-bias', key: 'mantleBias', uniform: 'uMantleBias',
    label: 'mantle bias (soil level)', value: 3.7857142822224725, min: -80, max: 80, step: 1, digits: 1, drivenBy: 'form' }),

  // ── Forest switch and the species ───────────────────────────────────────
  toggle({ id: 'tog-forest', label: 'forest (crowns + clearings)', key: 'forest', uniform: 'uForestOn', encode: 'float01' }),
  ...TERRAIN_SPECIES_PARAMS,

  // ── Debug views, test and pass switches, frame input ────────────────────
  // terrain.frag's legend: 0 off · 1 height · 2 flatness · 3 aspect ·
  // 4 concaveSmall · 5 concaveLarge · 6 moisture · 7 ridge · 8 erosion ·
  // 9 hollowness · 10 biome id · 11 normal (RGB) · 12 raw N·L · 13 forest cover ·
  // 14 bedrock select.
  row({ id: 'debug-view', key: 'debugView', uniform: 'uDebugView', kind: 'radio', value: 0,
    options: [
      { value: 0, label: 'off (material colour)' },
      { value: 1, label: 'height (dark low → bright high)' },
      { value: 2, label: 'flatness (red steep → white flat)' },
      { value: 3, label: 'aspect (blue shaded → red sunny)' },
      { value: 4, label: 'concave small (blue rib → red gully)' },
      { value: 5, label: 'concave large (blue mass → red valley)' },
      { value: 6, label: 'moisture (tan dry → blue wet)' },
      { value: 7, label: 'ridge map (blue crease → white ridge)' },
      { value: 8, label: 'erosion delta (red carved → green ridge)' },
      { value: 9, label: 'hollowness combined (blue ridge → red valley)' },
      { value: 10, label: 'biome id (flat colour key)' },
      { value: 11, label: 'surface normal (RGB, lighting input)' },
      { value: 12, label: 'raw N·L (blue away · white grazing · red sunlit)' },
      { value: 13, label: 'forest cover (bare → crown)' },
      { value: 14, label: 'bedrock select (green mantle → tan bedrock)' },
    ] }),
  // Signal tests: a debug view emits the raw signal value (for a float-RT
  // readback) instead of the display ramp. See tests/signals.
  hidden({ key: 'probeRaw', uniform: 'uProbeRaw', encode: 'float01', value: false, persist: false }),
  // The art pass's capture: the terrain emits its G-buffer (normal.xz +
  // coverage) instead of colour. artGBuffer.js switches it around its pass.
  hidden({ key: 'artData', uniform: 'uArtData', encode: 'float01', value: false, persist: false }),
  // A frame input: main.js writes water's sea level here every frame, so this
  // default is overwritten before the first render.
  hidden({ key: 'seaLevel', uniform: 'uSeaLevel', value: -10.9, persist: false }),
]

/**
 * Every terrain uniform no row backs, with its snapshot class
 * (shared/uniformSerialize.js). A uniform a row, a paramAccess `derived` entry
 * or the scene-wide set owns is not listed.
 *   integrated  captured by name
 *   derived     recomputed from rows by the restore (the driver's range step)
 *   frame       rewritten every frame, pass or tick; never captured
 *   constant    written at construction only; never captured
 *   row:<key>   written by that row's field
 */
export const UNIFORM_CLASSES = {
  // The drift clock, the offsets it integrates, and the last tick's velocity.
  uTime:            'integrated',
  uFBM0DriftOffset: 'integrated',
  uFBM1DriftOffset: 'integrated',
  uFBM0DriftX:      'integrated',
  uFBM0DriftZ:      'integrated',
  uFBM1DriftX:      'integrated',
  uFBM1DriftZ:      'integrated',
  // The biome ranges: functions of the amplitude, persistence and erosion rows.
  uHeightMax:       'derived',
  uMantleDC:        'derived',
  // One count for both instances: the `mantleOctaves` row's field.
  uFBM0Octaves:     'row:mantleOctaves',
  uFBM1Octaves:     'row:mantleOctaves',
  // Textures and the per-frame lattice window.
  uDataMap:         'frame',
  uDeriveMap:       'frame',
  uForestSites:     'frame',
  uForestSiteOrigin: 'frame',
  // Fixed at construction.
  uCamXZ:           'constant',   // CAM_POSITION.xz, never the fly camera
  uPlaneSize:       'constant',
  uDataMapTexel:    'constant',
  uSnowAspect:      'constant',   // snowline and treeline field shapes, no control
  uSnowHollow:      'constant',
  uTreeTongue:      'constant',
  uForestClose:     'constant',   // forest fill threshold and crown blend, no control
  uForestSmooth:    'constant',
}
