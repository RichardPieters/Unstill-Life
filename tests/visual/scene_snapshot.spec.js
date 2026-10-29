import { test, expect } from '@playwright/test'
import { boot } from './helpers.js'

// Guards the scene-snapshot feature against DRIFT as the code grows. These are
// the two structural guards from sceneSnapshot.js:
//  - completeness: the capture sweeps ALL uniform objects (a heightmap-only key
//    proves >1 material is covered) + the enumerated non-uniform JS state.
//  - round-trip fidelity: capture -> perturb every layer -> apply -> everything
//    restores. A newly-added visual field that is NOT captured makes this red.
// Property/invariant tier — no committed pixel or height snapshot.

test('capture covers all three terrain materials + water JS state + envelope', async ({ page }) => {
  await boot(page, { pause: true })
  const snap = await page.evaluate(() => window.__d.captureSnapshot())

  // Terrain's state is by classification: its rows by key, the integrated
  // uniforms by name, the drift headings, the scene set's authored values.
  expect(snap.terrain.format).toBe(2)
  expect(snap.terrain.params).toHaveProperty('ridgeAmt')             // a material row
  expect(snap.terrain.params).toHaveProperty('strength')             // a heightmap-pass row
  expect(typeof snap.terrain.params.segments).toBe('number')
  expect(typeof snap.terrain.integrated.uTime).toBe('number')
  expect(snap.terrain.integrated.uFBM1DriftOffset).toHaveProperty('x')
  expect(snap.terrain.params).not.toHaveProperty('seaLevel')         // persist:false
  expect(typeof snap.terrain.scene.fogCurve).toBe('number')
  expect(typeof snap.terrain.scene.cloudShadowAmt).toBe('number')
  expect(typeof snap.water.driver.seaLevel).toBe('number')          // non-uniform JS state
  expect(typeof snap.water.params.reflectScale).toBe('number')
  expect(typeof snap.formWalker.u.ocean).toBe('number')             // form walker latents
  expect(typeof snap.formWalker.target.snowline).toBe('number')
  expect(typeof snap.terrain.params['sp:conifer:radius']).toBe('number')   // per-species rows
  expect(snap.terrain.params['sp:conifer:color']).toMatch(/^#[0-9a-f]{6}$/i)
  expect(snap.version).toBe(1)
  expect(snap.camera).toHaveProperty('yaw')
  expect(snap.render).toHaveProperty('w')

  // Clouds: the rows (a bake row, a march row, the posterize scale and the
  // budgets) and the scrolling state by name; the grid-derived uniforms are not
  // captured.
  expect(snap.clouds.format).toBe(2)
  expect(snap.clouds.params).toHaveProperty('drawDistance')
  expect(snap.clouds.params).toHaveProperty('densityScale')
  expect(typeof snap.clouds.params.rollLayersPerFrame).toBe('number')
  expect(snap.clouds.integrated).toHaveProperty('uWindOffset')
  expect(snap.clouds.integrated).not.toHaveProperty('uCellSize')

  // Art pass (artPass.js): every row by key: the sliders (a prepass one, a
  // paint one, a finish one), the colours as hex strings, the radio choices and
  // the held ones that no uniform carries (beta/cull drive a CPU solve baked
  // into a texture).
  expect(snap.artPass.format).toBe(2)
  expect(snap.artPass.params).toHaveProperty('cell')
  expect(snap.artPass.params).toHaveProperty('heightScale')      // held: the derived uniform is not captured
  expect(snap.artPass.params).toHaveProperty('groundBlur')
  expect(snap.artPass.params).toHaveProperty('segFog')
  expect(typeof snap.artPass.enabled).toBe('boolean')
  expect(typeof snap.artPass.params.groundMode).toBe('number')
  expect(typeof snap.artPass.params.beta).toBe('number')
  expect(snap.artPass.params.colSky).toMatch(/^#[0-9a-f]{6}$/i)

  // Dynamics (dynamics.js): its three tuning settings.
  expect(typeof snap.dynamics.momentumTau).toBe('number')
  expect(typeof snap.dynamics.settleIntervalAtMaxAttention).toBe('number')
  expect(typeof snap.dynamics.unfreezeAttention).toBe('number')

  // animSpeed (animSpeed.js): the pace and the weather's hurry on waves and
  // clouds.
  expect(typeof snap.animSpeed.targetSpeed).toBe('number')
  expect(typeof snap.animSpeed.waveWeatherGain).toBe('number')
  expect(typeof snap.animSpeed.cloudWeatherGain).toBe('number')

  // Weather (atmosphere.js). The two scalars, their in-flight walk targets and
  // the authored heavy ends — a snapshot missing any of
  // them restores a sky that walks off it on the first tick.
  expect(typeof snap.atmosphere.u.overcast).toBe('number')
  expect(typeof snap.atmosphere.u.haze).toBe('number')
  expect(typeof snap.atmosphere.target.overcast).toBe('number')
  expect(typeof snap.atmosphere.heavy.shadowValue).toBe('number')
  expect(typeof snap.atmosphere.enabled).toBe('boolean')
})

test('capture -> perturb every layer -> apply restores exactly', async ({ page }) => {
  await boot(page, { pause: true })
  const A = await page.evaluate(() => JSON.parse(JSON.stringify(window.__d.captureSnapshot())))

  // Perturb across every layer: a uniform on two different materials, geometry,
  // water JS state, and the camera pose.
  await page.evaluate(({ segDown, spRadius0 }) => {
    const d = window.__d
    // The form's five held positions (the writes they make are the owners' own state).
    d.applyFormPositions({ ocean: 0.71, mountains: 0.23, snowline: 0.12, cloudScatter: 0.88, cloudDensity: 0.77 })
    d.terrain._material.uniforms.uRidgeAmt.value = 0.87
    d.terrain._heightmapMaterial.uniforms.uErosionStrength.value += 0.17
    d.terrain.setSegments(segDown)   // geometry (down = smaller/faster rebuild)
    d.water._driver.importState({ seaLevel: d.water.getSeaLevel() - 12 })
    d.water.params.set('reflectScale', Math.max(0.05, d.water.params.get('reflectScale') - 0.3))
    d.terrain.params.set('sp:conifer:radius', spRadius0 * 0.5 + 0.05)
    d.terrain.params.set('sp:conifer:color', '#123456')
    d.flyCamera.setPose({ pos: [10, 200, 10], yaw: 1.1, pitch: -0.3 })
    // The walker drives the macro form off the first tick after a restore, so
    // its latents have to come back too or a resumed snapshot walks away.
    d.formWalker.importState({ u: { ocean: 0.11, mountains: 0.22, snowline: 0.33 },
                               target: { ocean: 0.44, mountains: 0.55, snowline: 0.66 } })
    // Its drift range, speed and on switch are the Form drift settings.
    d.formWalker.params.set('calmSpread', 0.13)
    d.formWalker.params.set('followRate', 0.037)
    d.formWalker.params.set('enabled', !d.formWalker.params.get('enabled'))
    // Clouds: a light-volume uniform, a grid uniform, and non-uniform JS state
    // (the roll budget).
    d.clouds.params.set('coverage', 0.91)
    d.clouds.snapEases()                          // a snapshot holds the drawn value
    d.clouds.params.set('drawDistance', 2500)
    d.clouds.params.set('rollLayersPerFrame', 9)
    // Art pass: a row on the paint material, one on the finish material, the
    // held ones (relief height, ground blur, prepass scale, beta) and the
    // colour and radio choice.
    d.artPass.params.set('cell', 11)
    d.artPass.params.set('diffuse', 2.4)
    d.artPass.params.set('heightScale', 2.3)
    d.artPass.params.set('groundBlur', 1.4)
    d.artPass.params.set('prepassScale', 0.9)
    d.artPass.params.set('colSky', '#123456')
    d.artPass.params.set('beta', 0.41)
    d.artPass.params.set('groundMode', 3)
    d.artPass.enabled = true
    // Dynamics: all three config sliders.
    d.dynamics.params.set('momentumTau', 3.5)
    d.dynamics.params.set('settleIntervalAtMaxAttention', 45)
    d.dynamics.params.set('unfreezeAttention', 0.6)
    d.animSpeed.params.set('targetSpeed', 2.2)
    d.animSpeed.params.set('waveWeatherGain', 0.35)
    d.animSpeed.params.set('cloudWeatherGain', 2.7)
    // Weather: the master toggle, both walked scalars with their targets, and
    // one authored heavy end.
    d.atmosphere.params.set('enabled', true)
    d.atmosphere.importState({ u: { overcast: 0.81, haze: 0.19 },
                               target: { overcast: 0.62, haze: 0.37 } })
    d.atmosphere.params.set('heavy.shadowValue', 0.42)
  }, { segDown: Math.max(50, A.terrain.params.segments - 100), spRadius0: A.terrain.params['sp:conifer:radius'] })

  const report = await page.evaluate(a => window.__d.applySnapshot(a), A)
  expect(report.unknown).toEqual([])

  const C = await page.evaluate(() => JSON.parse(JSON.stringify(window.__d.captureSnapshot())))
  expect(C.terrain.params.ridgeAmt).toBeCloseTo(A.terrain.params.ridgeAmt, 5)
  expect(C.terrain.params.strength).toBeCloseTo(A.terrain.params.strength, 5)
  expect(C.terrain.params.segments).toBe(A.terrain.params.segments)
  expect(C.water.driver.seaLevel).toBeCloseTo(A.water.driver.seaLevel, 3)
  expect(C.water.params.reflectScale).toBeCloseTo(A.water.params.reflectScale, 5)
  expect(C.terrain.params['sp:conifer:radius']).toBeCloseTo(A.terrain.params['sp:conifer:radius'], 5)
  expect(C.terrain.params['sp:conifer:color']).toBe(A.terrain.params['sp:conifer:color'])
  expect(C.camera.pos[1]).toBeCloseTo(A.camera.pos[1], 2)
  expect(C.camera.yaw).toBeCloseTo(A.camera.yaw, 3)
  for (const k of ['ocean', 'mountains', 'snowline']) {
    expect(C.formWalker.u[k]).toBeCloseTo(A.formWalker.u[k], 6)
    expect(C.formWalker.target[k]).toBeCloseTo(A.formWalker.target[k], 6)
  }
  for (const k of ['ocean', 'mountains', 'snowline', 'cloudScatter', 'cloudDensity']) {
    expect(C.form[k], `form.${k}`).toBeCloseTo(A.form[k], 6)
  }
  expect(C.formWalker.calmSpread).toBeCloseTo(A.formWalker.calmSpread, 6)
  expect(C.formWalker.followRate).toBeCloseTo(A.formWalker.followRate, 6)
  expect(C.formWalker.enabled).toBe(A.formWalker.enabled)
  expect(C.artPass.params.cell).toBeCloseTo(A.artPass.params.cell, 5)
  expect(C.artPass.params.diffuse).toBeCloseTo(A.artPass.params.diffuse, 5)
  // The relief height is the slider as it was, not its derived uniform (which
  // carries the relief scale); the ground blur and prepass scale travel too.
  expect(C.artPass.params.heightScale).toBeCloseTo(A.artPass.params.heightScale, 6)
  expect(C.artPass.params.groundBlur).toBeCloseTo(A.artPass.params.groundBlur, 6)
  expect(C.artPass.params.prepassScale).toBeCloseTo(A.artPass.params.prepassScale, 6)
  expect(C.artPass.params.colSky).toBe(A.artPass.params.colSky)
  expect(C.artPass.params.beta).toBeCloseTo(A.artPass.params.beta, 5)
  expect(C.artPass.params.groundMode).toBe(A.artPass.params.groundMode)
  expect(C.artPass.enabled).toBe(A.artPass.enabled)
  expect(C.clouds.params.coverage).toBeCloseTo(A.clouds.params.coverage, 5)
  expect(C.clouds.params.drawDistance).toBeCloseTo(A.clouds.params.drawDistance, 5)
  expect(C.clouds.params.rollLayersPerFrame).toBe(A.clouds.params.rollLayersPerFrame)
  expect(C.dynamics.momentumTau).toBeCloseTo(A.dynamics.momentumTau, 5)
  expect(C.dynamics.settleIntervalAtMaxAttention).toBeCloseTo(A.dynamics.settleIntervalAtMaxAttention, 5)
  expect(C.dynamics.unfreezeAttention).toBeCloseTo(A.dynamics.unfreezeAttention, 5)
  expect(C.animSpeed.targetSpeed).toBeCloseTo(A.animSpeed.targetSpeed, 5)
  expect(C.animSpeed.waveWeatherGain).toBeCloseTo(A.animSpeed.waveWeatherGain, 5)
  expect(C.animSpeed.cloudWeatherGain).toBeCloseTo(A.animSpeed.cloudWeatherGain, 5)
  for (const k of ['overcast', 'haze']) {
    expect(C.atmosphere.u[k]).toBeCloseTo(A.atmosphere.u[k], 6)
    expect(C.atmosphere.target[k]).toBeCloseTo(A.atmosphere.target[k], 6)
  }
  expect(C.atmosphere.heavy.shadowValue).toBeCloseTo(A.atmosphere.heavy.shadowValue, 5)
  expect(C.atmosphere.enabled).toBe(A.atmosphere.enabled)
})

test('an unknown row key or integrated uniform is reported, not silently dropped', async ({ page }) => {
  await boot(page, { pause: true })
  const A = await page.evaluate(() => window.__d.captureSnapshot())
  A.terrain.params.renamedGoneAway = 1.23
  A.terrain.integrated.uRenamedGoneAway = 1.23
  const report = await page.evaluate(a => window.__d.applySnapshot(a), A)
  expect(report.unknown).toContain('renamedGoneAway')
  expect(report.unknown).toContain('uRenamedGoneAway')
})

/**
 * Clicking the panel's actual Export button, not window.__d.captureSnapshot().
 *
 * The button and window.__d share one deps object (debugPanel.js's
 * controls.snapshotDeps); a second copy could silently miss modules while
 * every test above, which goes through window.__d, kept passing. Guards the
 * button itself, the surface a person exports through and the one nothing
 * else here exercises.
 */
test('the panel Export button captures the same state window.__d does', async ({ page }) => {
  await boot(page, { pause: true })
  // The control bar hides until the pointer nears the bottom edge (fullscreen.js).
  await page.mouse.move(200, await page.evaluate(() => window.innerHeight - 10))
  await page.click('#toggle-debug')   // the panel starts hidden; the button is inert until shown
  await page.click('#snap-export')
  const fromButton = await page.evaluate(() => JSON.parse(document.getElementById('snap-json').value))
  const fromHandle = await page.evaluate(() => window.__d.captureSnapshot())

  for (const key of ['artPass', 'dynamics', 'animSpeed']) {
    expect(fromButton, `Export button omitted ${key}`).toHaveProperty(key)
  }
  expect(fromButton.dynamics).toEqual(fromHandle.dynamics)
  expect(fromButton.animSpeed).toEqual(fromHandle.animSpeed)
  expect(fromButton.artPass.enabled).toBe(fromHandle.artPass.enabled)
})
