/**
 * main.js — the composition root: builds the renderer, scene and every module,
 * wires them to each other and to the debug panel, and runs the render loop.
 *
 * SETUP     renderer (fills the window) -> scene -> modules ->
 *           weatherDriver -> debug panel -> atmosphere and form walker ->
 *           snapshot deps and the `window.__d` handle -> render loop.
 * WIRING    The few couplings that no single module owns live here: dynamics'
 *           freeze/unfreeze -> the art pass's reveal/exit, the horizon
 *           fan-out, the mic's leak source, and the per-frame pushes
 *           between modules (sea level, terrain scale, cloud shadow, audio).
 * LOOP      frame() skips everything when nothing needs drawing, else runs
 *           named steps in order: stepDynamics, isWorldHolding, stepAnimSpeed,
 *           renderPrepasses, pushTerrainAndWater, pushSoundscapeState,
 *           renderGBuffer, stepClouds, the composer, wakeAfterExit. The
 *           reasoning sits with each step; docs/architecture.md ("Frame order
 *           and render targets") is the summary.
 */
import * as THREE from 'three'
import { Dynamics, NOISE_SPEED_MAX } from './dynamics/dynamics.js'
import { Terrain }        from './terrain/terrain.js'
import { Water }          from './water/water.js'
import { VolumeClouds }   from './clouds/cloudsVolume.js'
import { Sky }            from './render/sky.js'
import { Audio }          from './audio/audio.js'
import { Postprocessing } from './render/postprocessing.js'
import { ArtGBuffer }     from './artpass/artGBuffer.js'
import { ArtPass }        from './artpass/artPass.js'
import { Godrays }        from './clouds/godrays.js'
import { Interaction }    from './interaction/interaction.js'
import { MicProbe }       from './interaction/micProbe.js'
import { FlyCamera }      from './scene/flyCamera.js'
import { FormWalker }     from './drift/formWalker.js'
import { createFormDriver } from './scene/formDriver.js'
import { Atmosphere }     from './drift/atmosphere.js'
import { AnimSpeed }      from './dynamics/animSpeed.js'
import { PALETTE } from './shared/palette.js'
import { initDebugPanel } from './panel/debugPanel.js'
import { createWeatherDriver } from './scene/weatherDriver.js'
import { createSceneUniforms } from './shared/sceneUniforms.js'
import { captureScene, applyScene } from './scene/sceneSnapshot.js'
import START_SCENE from './scene/startScene.json'
import { shouldAdvanceDynamics, reconcilePaintingHold, isArtPassAnimating, computeSceneStatic } from './scene/frameLogic.js'
import { FOG_NEAR_START, FOG_FAR_START, CAM_POSITION, CAM_LOOKAT } from './shared/sceneConfig.js'
import { forestCover } from './audio/audioMath.js'
import { createHorizonColour } from './scene/horizonColour.js'
import { createDisplay } from './render/display.js'
import { CostMeasure } from './panel/costMeasure.js'

// ─── Camera constants ─────────────────────────────────────────────────────────
// Position/lookAt come from sceneConfig (shared with the terrain's adaptive-mesh bias).
const CAM_FOV      = 45
const CAM_NEAR     = 0.1
const CAM_FAR      = 3000

// ─── Canvas shape ─────────────────────────────────────────────────────────────
// The canvas fills the window. The picture was composed at 16:9, so the camera
// never shows less than that framing: a wider window adds ground and sky at the
// sides, a taller one adds them above and below (the vertical field of view
// grows so the 16:9 width stays in view).
const DESIGN_ASPECT = 16 / 9

function windowSize() {
  return { width: Math.max(1, window.innerWidth), height: Math.max(1, window.innerHeight) }
}

/** Vertical field of view that keeps the design framing's width in view. */
function fovFor(aspect) {
  if (aspect >= DESIGN_ASPECT) return CAM_FOV
  const half = Math.tan(THREE.MathUtils.degToRad(CAM_FOV) / 2)
  return THREE.MathUtils.radToDeg(2 * Math.atan(half * DESIGN_ASPECT / aspect))
}

// ─── Scene setup ──────────────────────────────────────────────────────────────
const renderer = new THREE.WebGLRenderer({ antialias: false })
// The ratio is capped, not the raw device ratio (pixelRatio.js). The display
// owner sets it BEFORE the composer is built, which copies it once at
// construction; a later change reaches the composer and the canvas through the
// onChange hook below.
const display = createDisplay(renderer)
const { width: initW, height: initH } = windowSize()
renderer.setSize(initW, initH)
// Explicit id: the debug panel has its own 2D canvases (mic-flux-graph,
// cam-overlay), so this is not the page's only <canvas>; the test helpers
// select the scene by this id.
renderer.domElement.id = 'scene-canvas'
document.body.appendChild(renderer.domElement)

const scene = new THREE.Scene()
// scene.background is assigned once `sky` exists, below (it is the sky
// gradient texture, not a flat colour — see sky.js).
scene.fog = new THREE.Fog(PALETTE.sky.horizon, FOG_NEAR_START, FOG_FAR_START)

const camera = new THREE.PerspectiveCamera(fovFor(initW / initH), initW / initH, CAM_NEAR, CAM_FAR)
camera.position.copy(CAM_POSITION)
camera.lookAt(CAM_LOOKAT)

// ─── Modules ──────────────────────────────────────────────────────────────────
const dynamics       = new Dynamics()
// The one fog, light level and cloud shadow every material reads (terrain,
// water, godrays, the art pass): one set of uniform objects mounted into each,
// written through its own API and by the per-frame shadow step below.
const sceneUniforms  = createSceneUniforms()
const terrain        = new Terrain(dynamics, sceneUniforms)
const water          = new Water(dynamics, sceneUniforms)
// The baked-volume clouds; their values are `clouds.params`.
const clouds         = new VolumeClouds(sceneUniforms)
const sky            = new Sky()
scene.background = sky.texture
const audio          = new Audio()
// The divisionist post-process and the scene data it paints from. While the
// pass is disabled neither costs anything: the composer skips a disabled pass
// and the render loop below skips the G-buffer's extra scene render. It starts
// enabled (ART_ENABLED_DEFAULT) so the piece opens as a painting.
const artGBuffer     = new ArtGBuffer(terrain, water)
const artPass        = new ArtPass(artGBuffer, camera, { sceneUniforms })
// Volumetric light shafts; marches the same baked cloud-shadow field the ground
// reads, so it needs no bake of its own (godrays.js).
const godrays        = new Godrays(sceneUniforms)
const postprocessing = new Postprocessing(renderer, scene, camera, clouds, artPass, godrays)

// dynamics' freeze/unfreeze -> the art pass. Neither module knows the other;
// this is the one place that knows both. The painting grows in (playReveal) as
// the scene settles and dissolves (playExit) as it resumes, rather than
// snapping on and off via `.enabled`.
//
// The exit reads the landscape MOVING as its material: unfreeze lets the tick
// run again, and the dissolve measures every stroke against how far the scene
// has drifted from the frame it was painted from. So the pass is left enabled
// here; playExit turns it off itself once nothing of the painting is left.
dynamics.addEventListener('freeze',   () => artPass.playReveal())
dynamics.addEventListener('unfreeze', () => artPass.playExit())

// Water and cloud pace: proportional to restlessness, 0 under a painting
// (the exit's resume ease comes from artPass).
const animSpeed = new AnimSpeed(artPass, dynamics)

const interaction    = new Interaction()
// The sim's own output level, so the mic can tell its own speakers from the room.
interaction.setLeakSource(() => audio.getOutputLevel())
const flyCamera      = new FlyCamera(camera)
flyCamera.attach()

scene.add(terrain.mesh)
scene.add(water.mesh)

// The ONE place the scene's horizon colour is set; the weather (atmosphere.js)
// calls it every time the sky colour moves. It reaches the sky gradient, the
// scene fog, the scene-wide fog colour terrain and water read, and the clouds:
// cloudShade.glsl's colour gradients depend on sun height alone, so without
// this an overcast lid would render in clear-day colours against a grey sky.
//
// artPass is deliberately NOT included, although it keeps its own sky copy for
// the ground and aerial-fog target it paints from. Its authored default
// (#8fa8c4) is not the palette horizon (0xc7e0ff), so pushing the horizon here
// would restyle the painting at startup. The weather drives that copy instead,
// from its own captured clear end: it follows the sky while the weather is on
// and returns to its authored colour when the weather goes off.
const horizon = createHorizonColour({ sky, fog: scene.fog, sceneUniforms, clouds })
function applyHorizon(hex) { horizon.params.set('hex', hex) }
const forgetHorizon = () => horizon.forget()

// ─── Click-to-begin overlay (Web Audio autoplay policy) ──────────────────────
const overlay = document.getElementById('start-overlay')
const beginButton = document.getElementById('start-begin')
const beginFullscreen = document.getElementById('start-begin-fs')
if (!document.fullscreenEnabled) beginFullscreen.remove()
beginButton.focus()
let begun = false

/**
 * Fullscreen hides a permission prompt, so it waits until the microphone is
 * answered. By then the click's user gesture may have expired and the browser
 * refuses; the next click then does it, with a hint saying so.
 */
function enterFullscreen() {
  const root = document.documentElement
  root.requestFullscreen().catch(() => {
    const hint = document.createElement('div')
    hint.className = 'fs-hint'
    hint.textContent = 'Click anywhere for fullscreen'
    document.body.appendChild(hint)
    document.addEventListener('pointerdown', () => {
      hint.remove()
      root.requestFullscreen().catch(() => {})
    }, { once: true })
    setTimeout(() => hint.remove(), 10000)
  })
}

function begin({ fullscreen = false } = {}) {
  if (begun) return
  begun = true
  // Always dismiss, even if audio fails: the veil fades, then leaves the page.
  overlay.classList.add('leaving')
  overlay.addEventListener('transitionend', () => overlay.remove(), { once: true })
  setTimeout(() => overlay.remove(), 1000)
  try { audio.start() } catch (e) { console.warn('AudioContext failed:', e) }
  // Sound on by default: audio starts muted, so flip the panel's own toggle
  // (the panel owns the mute state).
  const soundToggle = document.getElementById('tog-sound')
  soundToggle.checked = true
  soundToggle.dispatchEvent(new Event('change'))
  // Mic on by default: it needs this same user gesture for the permission
  // prompt and a live AudioContext. Goes through the panel toggle so the
  // panel's state stays in sync; the second call shares that request, so it
  // settles when the prompt is answered or closed.
  const micToggle = document.getElementById('int-src-mic')
  micToggle.checked = true
  micToggle.dispatchEvent(new Event('change'))
  if (fullscreen) interaction.enableMic(audio.getAudioContext()).finally(enterFullscreen)
}
// A click anywhere on the veil begins; the fullscreen button asks for it too.
overlay.addEventListener('click', e => begin({ fullscreen: e.target === beginFullscreen }))

// ─── Init ─────────────────────────────────────────────────────────────────────
const clock = new THREE.Clock()

await terrain.init(renderer)

// The weather's write path (weatherDriver.js), built once; the Atmosphere below
// writes through it.
const weatherDriver = createWeatherDriver({
  terrain, water, clouds, artPass, sky, scene, sceneUniforms, horizon,
})
// The five macro dials' positions and writes (scene/formDriver.js). Its panel
// rows update themselves through `form.params`.
const form = createFormDriver({
  terrain, water, clouds, godrays, sceneUniforms,
  onDensityEffect: () => weatherDriver.reapplyWeather(),
})

// The render-resolution slider (Performance tab): the display owner sets the
// renderer's ratio; the composer and every per-pixel render target follow.
display.params.onChange('pixelRatioCap', () => {
  postprocessing.setPixelRatio(display.ratio())
  resizeCanvas()
})
// The Performance tab's "Measure costs" (costMeasure.js): what it can switch
// off, and how. Each on() restores exactly what its off() changed; parts that
// are already off (forest disabled, godrays gated shut by clear weather) are
// left out rather than measured as zero. The three pre-passes have no switch of
// their own, so the render loop consults perfSkip.
const perfSkip = { dataMap: false, depthPass: false, reflection: false }
const skipPass = key => ({ off: () => { perfSkip[key] = true }, on: () => { perfSkip[key] = false } })
const perf = {
  costMeasure: new CostMeasure(),
  measurableParts() {
    const parts = []
    if (clouds.params.get('enabled')) parts.push({ name: 'clouds', off: () => clouds.params.set('enabled', false), on: () => clouds.params.set('enabled', true) })
    if (terrain.params.get('forest')) parts.push({ name: 'forest', off: () => terrain.params.set('forest', false), on: () => terrain.params.set('forest', true) })
    parts.push({ name: 'terrain data map', ...skipPass('dataMap') })
    parts.push({ name: 'water depth pass', ...skipPass('depthPass') })
    parts.push({ name: 'water reflection', ...skipPass('reflection') })
    if (godrays.pass.enabled) parts.push({ name: 'godrays', off: () => godrays.params.set('enabled', false), on: () => godrays.params.set('enabled', true) })
    return parts
  },
}
// All debug-panel DOM wiring lives in panel/. `controls` carries the sim-drive
// state the loop reads (paused, attention()) and the panel hooks.
const controls = initDebugPanel({ terrain, water, clouds, artPass, godrays, sky, animSpeed, dynamics, interaction, audio, applyHorizon, forgetHorizon, flyCamera, scene, renderer, sceneUniforms, form, display, perf })

// The weather wanders on its own, paced by noiseSpeed so it stalls whenever the
// scene does. It writes through weatherDriver rather than at the scene, so every
// uniform it reaches is written once, by its owner. Constructed BEFORE
// formWalker: the walker's cloud channels read this instance's spread/rate
// synchronously while seeding their targets.
const atmosphere = new Atmosphere(dynamics, {
  apply:       state => weatherDriver.applyWeather(state),
  live:        weatherDriver.live,
  noiseSpeed:  () => dynamics.noiseSpeed,
})
controls.bindAtmosphere(atmosphere)

// The macro form (ocean, mountains, snowline, cloud dials) wanders on its own,
// paced by noiseSpeed. It writes through `form`, so the dials and the
// walk cannot disagree about where the form is. Its start positions come from
// the start scene below.
const formWalker = new FormWalker(dynamics, {
  apply:      pos => form.apply(pos),
  noiseSpeed: () => dynamics.noiseSpeed,
  // The cloud dials (scatter/density) ride the weather's spread/rate (the
  // "Cloud & sky drift" controls), not the form's own pace: they move with
  // overcast and haze, not with the ocean/mountain/snowline creep.
  cloudSpread: () => atmosphere.params.get('spread'),
  cloudRate:   () => atmosphere.params.get('rate'),
})
controls.bindFormWalker(formWalker)

// Scene-snapshot deps: the same object the panel's Export/Import buttons use
// (debugPanel.js), so the buttons and the `window.__d` handle can
// never capture different module sets.
const snapshotDeps = controls.snapshotDeps

// The piece opens on the start scene (scene/startScene.json), a snapshot
// exported from the panel: every module's values, the drift's accumulated
// offsets and the camera. Restored here, before the render loop starts, so no
// frame is drawn from the modules' construction values. applyScene pauses for
// its writes; the piece itself starts running.
applyScene(snapshotDeps, START_SCENE)
controls.setPaused(false)
// A restored pose always turns the fly camera on (flyCamera.js). The start
// scene's pose is the authored camera with the fly camera off, which switching
// it off returns to.
if (!START_SCENE.camera.enabled) flyCamera.params.set('enabled', false)
const formStart = form.positions()

// Per-pixel render targets are sized in physical framebuffer pixels (CSS size
// × pixel ratio): gl_FragCoord.xy is in physical pixels, so the depth-texture
// UV lookup must match. resizeCanvas() repeats this on resize.
function sizeRenderTargets() {
  const sz = renderer.getDrawingBufferSize(new THREE.Vector2())
  water.setSize(sz.x, sz.y)
  clouds.setDepthTexture(water.getDepthTexture())
  clouds.setSize(sz.x, sz.y)
  godrays.setDepthTexture(water.getDepthTexture())
  godrays.setSize(sz.x, sz.y)
  artGBuffer.setSize(sz.x, sz.y)
}
sizeRenderTargets()

// State for the static-scene shortcut in the loop: the G-buffer is a full scene
// render and only needs redoing once the scene or the camera has moved.
let gbufferValid = false
// Catches the exit-finished transition (artPass.enabled true -> false, set
// inside its own render()) so dynamics can be woken here; artPass knows
// nothing of dynamics.
let prevArtPassEnabled = artPass.enabled
const lastCamPos = new THREE.Vector3()
const lastCamQuat = new THREE.Quaternion()

// Dev handle for the test harness and headless probes (tests/visual,
// tests/signals): module access plus the helpers below. Harmless in production.
window.__d = { THREE, scene, camera, dynamics, sceneUniforms, terrain, water, clouds, sky, renderer, flyCamera, formWalker, atmosphere, godrays, artPass, artGBuffer, animSpeed, audio, interaction, micProbe: new MicProbe({ interaction, audio }), driven: controls.driven,
  pause: () => { document.getElementById('pause').click() },
  // Force one frame while paused. The loop skips all GPU work while paused
  // unless a panel control (or this call) marked the scene dirty, so a change
  // made programmatically stays invisible until it asks for a frame. Panel
  // controls get this for free.
  markDirty: () => controls.markDirty(),
  // The form walker's write path: the one place the normalised positions are
  // mapped onto real controls, so a harness checking that mapping goes through
  // it rather than reimplementing it.
  applyFormPositions: (pos, opts) => form.apply(pos, opts),
  readForm: () => form.positions(),
  form,
  // Scene snapshot capture/restore (scene/sceneSnapshot.js).
  captureSnapshot: () => captureScene(snapshotDeps),
  applySnapshot: (json) => applyScene(snapshotDeps, json),
  // Hold the macro form still: the walker drifts from the first frame, so a
  // harness needing a fixed landscape stops it AND undoes the drift already
  // done (restoring the start scene's form).
  freezeForm: () => {
    formWalker.params.set('enabled', false)
    controls.syncFormWalkToggle(formWalker)
    // snapSea: a one-shot restore, with no further ticks (callers pause
    // right after) for the smoothed waterline to crawl to the band.
    form.apply(formStart, { snapSea: true })
    controls.markDirty()   // writes uniforms directly, no DOM event to catch it
  },
}

// ─── Render loop ──────────────────────────────────────────────────────────────
// Log an audio fault once rather than every frame at 60 fps.
let audioFaultLogged = false
// The start scene's terrain scale and sea level, before the tick below
// recomputes the water's foam and deep-colour depth from them.
pushTerrainAndWater()
// Dynamics starts frozen (a held painting); hand every listener wired above the
// starting state.
dynamics.broadcastState()
// The start scene moved the cloud amount and scale rows; the clouds' eased
// uniforms start at those rows, or the sky would visibly drift into place for
// the first seconds.
clouds.snapEases()

// One frame of the loop, `dt` seconds after the last. The steps below run in
// this order; each is a named function so the order reads here and the reasons
// sit with the step.
renderer.setAnimationLoop(() => frame(clock.getDelta()))

function frame(dt) {
  controls.reportFrameTime(dt * 1000)   // real wall-clock frame time, unaffected by pause
  // A cost measurement needs every pass running every frame; a held scene would
  // skip the very passes it is timing.
  if (perf.costMeasure.active) {
    perf.costMeasure.onFrame(dt * 1000)
    controls.markDirty()
  }
  // The CPU's own share of the frame, for the Performance tab.
  const jsStart = performance.now()

  flyCamera.update(dt)

  // `dirty`: a panel control (or the harness) touched something since the last
  // frame. Read ONCE per frame, here: consumeNeedsRender clears as it reads, so
  // there can only be one caller, and the holding-still gates below need it on
  // every frame (a slider moved while the world is frozen must not be skipped).
  //
  // Nothing to redraw = paused, fly camera disabled, nothing dirty, and the art
  // pass not mid-animation. Every GPU stage below is then skipped and the
  // canvas keeps its last pixels. The art-pass check is what keeps frames
  // coming while paused: the landscape holds still while its reveal paints on
  // top of it over the reveal's duration.
  //
  // This does NOT also gate on dynamics.isFrozen(): a frozen scene still needs
  // dynamics.update() every frame to notice attention rising past the unfreeze
  // threshold.
  const dirty = controls.consumeNeedsRender()
  if (controls.paused && !flyCamera.params.get('enabled') && !dirty
      && !isArtPassAnimating(artPass)) {
    return
  }

  stepDynamics(dt)
  const worldHolding = isWorldHolding(dirty)
  stepAnimSpeed(dt)
  renderPrepasses(worldHolding)
  pushTerrainAndWater()
  pushSoundscapeState(dt)
  renderGBuffer(worldHolding)
  stepClouds(dt, worldHolding)
  postprocessing.render()
  wakeAfterExit()

  controls.reportJsTime(performance.now() - jsStart)
}

/** Settle or wake the world: a painting on screen always has dynamics frozen
 *  under it, however it got there, so that is reconciled before the advance. */
function stepDynamics(dt) {
  reconcilePaintingHold(artPass, dynamics)
  if (shouldAdvanceDynamics(controls.paused, artPass)) {
    dynamics.update(dt, controls.attention())
  }
}

/** Is the world holding still — nothing moving, nothing touched? Computed
 *  before the pre-passes it gates; everything it reads is final by now:
 *  flyCamera.update() ran at the top of the frame, and dynamics.update() fires
 *  its 'unfreeze' before returning, so a resuming world reads as moving on the
 *  very frame it resumes. */
function isWorldHolding(dirty) {
  const camPoseChanged = !camera.position.equals(lastCamPos) || !camera.quaternion.equals(lastCamQuat)
  if (camPoseChanged) { lastCamPos.copy(camera.position); lastCamQuat.copy(camera.quaternion) }
  return computeSceneStatic(controls.paused, camPoseChanged, dynamics, dirty)
}

/** Water and cloud pace. dt = 0 while paused freezes the resume ease; the fade
 *  tracks restlessness and needs no dt. The visible (shaped) overcast is pushed
 *  first so the weather-hurried pace applies this same frame. */
function stepAnimSpeed(dt) {
  animSpeed.setWeatherDrive(atmosphere.getOvercastShaped())
  animSpeed.update(controls.paused ? 0 : dt)
  water.setAnimSpeed(animSpeed.getWaveSpeed())
}

/** Every pass here writes into a render target that survives the frame, and
 *  every input is frozen while the world holds still, so re-running them would
 *  reproduce what those targets already hold: skipping leaves the correct
 *  result, not a stale one. Over a held painting these were the bulk of the
 *  frame. */
function renderPrepasses(worldHolding) {
  if (!worldHolding && !perfSkip.dataMap) terrain.renderDataMap()

  // Depth-only terrain material for this pass: water reads only the hardware
  // depth buffer here, so the full forest/biome fragment cost is not paid twice.
  if (!worldHolding && !perfSkip.depthPass) {
    terrain.setDepthOnly(true)
    water.depthPrePass(renderer, scene, camera)
    terrain.setDepthOnly(false)
  }

  if (!worldHolding && !perfSkip.reflection) water.reflectionPrePass(renderer, scene, camera)
}

/** Water -> terrain: the sea level. Terrain -> water: the vertical scale.
 *  Water's foam reach and deep-colour depth are in world units of depth, so they
 *  must track the amplitude the form dials move. Both are pushed per frame
 *  rather than on change, so they cannot go stale whichever control moved them. */
function pushTerrainAndWater() {
  terrain.params.set('seaLevel', water.getSeaLevel())
  water.setTerrainScale(terrain.params.get('fbm0Amp') + terrain.params.get('fbm1Amp'))
}

/** The soundscape's portrait of the frame. Pushed from the render loop, not a
 *  dynamics 'tick' listener: dynamics stops ticking while the scene is frozen,
 *  which is exactly when the painting animation plays and audio has the most to
 *  do. Audio subscribes to no dynamics event; this is its whole input.
 *
 *  The forest share is analytic, from values already on hand: a per-biome
 *  measurement would need a GPU readback every frame (a cloud-target readback
 *  is a synchronous ~2 MB pipeline stall).
 *
 *  Wrapped because audio is driven from inside the render loop: an exception
 *  here would abort the frame before anything draws. Sound may fail; the
 *  landscape may not. */
function pushSoundscapeState(dt) {
  try {
    // The macro-form dials, from `form`, not formWalker: the walker's positions
    // are its own latents and go stale as soon as the walk is switched off or a
    // slider is dragged by hand.
    const dials = form.positions()
    audio.setSceneState({
      // `forest` is the share of the frame that is forest; the other levels come off the dials.
      forest: forestCover({
        seaLevel:  water.getSeaLevel(),
        heightMax: terrain.params.get('fbm0Amp') + terrain.params.get('fbm1Amp'),
        treeBase:  terrain.params.get('treeBase'),
        snowBase:  terrain.params.get('snowBase'),
      }),
      ocean:        dials.ocean,
      mountains:    dials.mountains,
      snowline:     dials.snowline,
      // SHAPED, the curve every visible overcast effect goes through; below the
      // light's onset the raw walk is above 0 while the light is still clear.
      overcast:     atmosphere.getOvercastShaped(),
      haze:         atmosphere.getHaze(),
      // Two paces the sound keeps apart: `motion` is the water-and-sky pace
      // (animSpeed) and drives the swell; `terrainPace` is how fast the LAND is
      // reshaping and drives the wind. Normalised here so audio never needs
      // dynamics' constants. noiseSpeed rather than momentum: it is the rate the
      // field really evolves, and is exactly 0 while a painting is up.
      motion:       animSpeed.getSpeed(),
      terrainPace:  Math.min(1, Math.max(0, dynamics.noiseSpeed / NOISE_SPEED_MAX)),
      restlessness: dynamics.restlessness,
      // The same clock water.frag's swell()/wave() read (uTime), so the surf's
      // break trigger fires on the field the shore foam is computed from (two
      // independent clocks cannot be tuned into agreement; see SurfVoice).
      rippleTime:   water.getRippleTime(),
      // The same dt dynamics advances on, so sound and scene stay in step.
      dt,
    })
    audio.setPaintState({
      priming:        artPass.getPrimeProgress(),
      marks:          artPass.getPaintedFraction(),
      exit:           artPass.getExitProgress(),
      removed:        artPass.getRemovedFraction(),
      revealing:      artPass.isRevealPlaying(),
      exiting:        artPass.isExitPlaying(),
      enabled:        artPass.enabled,
      primeDuration:  artPass.params.get('revealPrimeDuration'),
      revealDuration: artPass.params.get('revealDuration'),
      exitDuration:   artPass.params.get('exitDuration'),
      // The blocking-in beat, as a fraction of the reveal; the sound's phase
      // boundary between drawing and filling.
      edgeBeat:       artPass.params.get('revealEdgeBeat'),
      edgesFirst:     artPass.params.get('revealEdgesFirst'),
    })
  } catch (e) {
    if (!audioFaultLogged) { audioFaultLogged = true; console.warn('[audio] disabled after fault:', e) }
  }
}

/** The art pass's scene data (G-buffer), drawn between the reflection pre-pass
 *  and the main render. After the pre-passes because it renders the scene and
 *  they swap the terrain into its depth-only material; before the main render
 *  because the pass that reads it runs at the end of the composer chain.
 *  Skipped entirely while the pass is disabled.
 *
 *  While the world holds still (a frozen scene or the debug pause, camera
 *  still) nothing the art pass reads can change, so neither the G-buffer nor the
 *  pass's own edge field and ground are redone. The G-buffer matters most: it is
 *  a second full render of the scene. */
function renderGBuffer(worldHolding) {
  artPass.setSceneStatic(worldHolding)
  if (!worldHolding) gbufferValid = false
  if (artPass.enabled && !gbufferValid) {
    artGBuffer.render(renderer, scene, camera)
    // Trusted only while nothing moves; the branch above marks it stale on the
    // first frame something does.
    gbufferValid = worldHolding
  }
}

/** Clouds, their shadow field and the light shafts. */
function stepClouds(dt, worldHolding) {
  clouds.params.set('sunElevation', terrain.params.get('sunElevation'))
  clouds.params.set('sunAzimuth', terrain.getSunAzimuth())
  // Cloud drift runs on the clouds' own clock, paced by animSpeed (0 under a
  // painting). Frozen while paused.
  clouds.update(camera, controls.paused ? 0 : dt * animSpeed.getCloudSpeed(), dt)
  // Whether the cloud volume and godrays may coast on what they hold. What that
  // lets them skip is their own decision (the volume alone knows whether a
  // relight is owed; see setSceneStatic there). Told every frame, like the art
  // pass.
  clouds.setSceneStatic(worldHolding)
  godrays.setSceneStatic(worldHolding)
  // The cloud pass is not gated on `!controls.paused`: the early return in
  // frame() already means this frame is meant to be drawn, and skipping the
  // cloud pass on a forced redraw left an empty sky after a page load that
  // stayed paused. The pass throttles itself, so this costs nothing on frames
  // that do not need it.
  //
  // The sun-shadow field is handed to terrain, water and godrays AFTER
  // clouds.update (the wind offset and any re-anchor are this frame's) and
  // after the volume exists (it is built lazily). Pushed every frame because
  // the wind offset scrolls continuously; one write into the scene-wide
  // uniforms reaches all three. The beam cut snaps onto the ground's tier
  // ladder (cutLevel() in godrays.frag), which godrays reads from the same set.
  sceneUniforms.setCloudShadowFrame(clouds.getShadowFrame())
  // The march's depth texture is water.js's depth pre-pass, rendered with the
  // water mesh hidden, so it is blind to the water surface and the beam needs
  // its own analytic clip against the sea level (godrays.frag).
  godrays.setSeaLevel(water.getSeaLevel())
  // The weather gate: shafts are a heavy-overcast sight, so overcast decides
  // whether the pass runs at all (godrays.setOvercast, which applies its own
  // onset). It reads the RAW overcast, while animSpeed and audio read the shaped
  // one. With the weather off the scene is the clear look: overcast 0, no shafts.
  godrays.setOvercast(atmosphere.params.get('enabled') ? atmosphere.getOvercast() : 0)
  clouds.renderClouds(renderer)
  // After the clouds, so this frame's relight (including the every-frame ground
  // layer) is in the volume the march reads.
  godrays.render(renderer, camera)
}

/** The painting just went away (the exit dissolve's last frame, or the debug
 *  checkbox): the scene returns to full restlessness the instant it is gone. */
function wakeAfterExit() {
  if (prevArtPassEnabled && !artPass.enabled) dynamics.wake()
  prevArtPassEnabled = artPass.enabled
}

// ─── Resize ───────────────────────────────────────────────────────────────────
// Recompute the canvas size, the camera's shape and every render target sized
// from the drawing buffer. Also run when the pixel-ratio cap changes, since the
// drawing buffer changes with it.
window.addEventListener('resize', resizeCanvas)
function resizeCanvas() {
  const { width, height } = windowSize()
  renderer.setSize(width, height)
  camera.aspect = width / height
  camera.fov = fovFor(camera.aspect)
  camera.updateProjectionMatrix()
  postprocessing.setSize(width, height)
  sizeRenderTargets()
  gbufferValid = false
  controls.markDirty()   // new canvas size needs one frame even while paused
}
