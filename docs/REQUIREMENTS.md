# Unstill Life — Requirements

## Artistic Intent

A browser-based generative landscape painting for projection. Leitmotif: **Vanitas** — transience.

The piece is not interactive in the conventional sense. It *watches* its audience. It starts as a held, still painting. Restlessness in the room wakes the painting into a living, moving landscape; sustained stillness lets that landscape settle again and congeal back into a painting. The picture is never finished: stillness fixes it, unrest dissolves it.

## Functional Requirements

**Terrain**
- Procedurally generated landscape, continuously evolving over time
- Erosion effects emphasize contrast between mountain ridges and plains
- Surface colour derived from height, slope and biome zonation (forest, meadow, rock, snow, shoreline)
- Forest cover placed by terrain logic, not by noise

**Dynamics**
- Slow, wave-like transformation; its pace follows a momentum that eases toward a level set by viewer attention
- `restlessness` decays while attention stays above a threshold and climbs back while it does not; reaching zero FREEZES the landscape and paints over it: a divisionist post-process grows a painted lattice onto the held frame, turning the moving landscape into a still painting
- The landscape moves again, and the painting dissolves off it, once attention drops back past the threshold

**Sky and weather**
- Animated volumetric clouds convey passing time; cloud shadows fall on terrain and water; light shafts appear under heavy cloud
- A slow weather walk (overcast, haze) runs on its own clock, paced by the scene's momentum so it stalls whenever the scene does; it changes light, colour, fog and cloud cover together

**Audio**
- Naturalistic, generated soundscape — wind, trees, surf, birds — whose balance is a portrait of what is currently on screen; no melody, no loops
- A dry paint layer scores the moment the scene freezes into a painting

**Interaction**
- Viewer attention from the microphone (stillness and quietness of the room, measured as spectral flux with the installation's own speaker leak removed), or a manual slider
- Falls back to a constant default when no sensor is available

**Aesthetics**
- Painterly look: a divisionist post-process grows a hand-painted-looking lattice over the frozen landscape once it settles
- Reduced-palette colour treatment with posterised light steps on the landscape itself, underneath the painted layer
- Fixed elevated camera by default; a debug-only free camera exists for development
- Targets full-screen projection output

## Constraints

- Runs in the browser (WebGL 2 via three.js), no server required
- Generative/AI-assisted development is expected (seminar requirement)
- No asset files for the landscape or its sound

## Where to Find the How

Module map, coupling and GLSL layout: `docs/architecture.md`. Per-module algorithms and decisions: each module's own header comment. Coding and workflow rules: `docs/process/agent_rules.md`. Future ideas: `docs/process/IDEAS.md`.
