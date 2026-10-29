/**
 * sceneConfig.js — scene-wide constants that several modules must agree on
 *
 * The camera vectors are shared objects: consumers copy them, never mutate.
 */

import * as THREE from 'three'

// World size of the terrain/water planes
export const PLANE_SIZE = 1500

// Fog / aerial-perspective range (world units): where the scene-wide
// uFogNear/uFogFar (sceneUniforms.js) that terrain, water and the art pass read
// START. The weather writes uFogNear from its first apply at boot and leaves
// uFogFar alone. Their fragment shaders apply fog by hand, because
// ShaderMaterial bypasses Three.js's automatic scene fog.
export const FOG_NEAR_START = 400
export const FOG_FAR_START  = 1100

// Camera — landscape-painting framing with the sky filling the upper frame. The
// look-at point lies 100 units along the view ray: about 9.7° below horizontal
// and 0.5° left of straight down −z.
export const CAM_POSITION = new THREE.Vector3(0, 72.36, 741.4)
export const CAM_LOOKAT   = new THREE.Vector3(-0.8699808388830336, 55.46037221020314, 642.8421707122853)

// The adaptive terrain mesh concentrates vertices toward the camera, so its
// reference point IS the camera position.
export const ADAPTIVE_CAM_Z = CAM_POSITION.z
export const ADAPTIVE_CAM_Y = CAM_POSITION.y
