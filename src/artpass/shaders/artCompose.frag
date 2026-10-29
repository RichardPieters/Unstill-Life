/**
 * artCompose.frag — lay the strokes over the ground.
 *
 * The stroke pass (artPaint.frag) draws strokes only: premultiplied paint and
 * how much of each pixel they cover. This pass puts the ground underneath,
 *
 *   colour = ground * (1 - coverage) + paint
 *
 * and writes the finished paint buffer everything downstream reads (finish,
 * hold, dissolve). It is the part of the picture that changes while the strokes
 * stand still — the ground fading from the live frame to its configured look
 * during the entrance, the priming wash, the canvas weave arriving, the weather
 * drifting the sky and ground colours — and it is one cheap pass, so those
 * changes cost one pass per frame instead of a redraw of every stroke.
 *
 * It also draws the diagnostic views, which replace the paint outright.
 */

uniform vec2  uRes;

//#include hash
//#include format
//#include frame
//#include noise
//#include scene
//#include lattice
//#include orient

in  vec2 vUv;
layout(location = 0) out vec4 fragColor;
layout(location = 1) out vec4 fragId;

uniform sampler2D uBeauty;     // the frame the strokes were painted from
uniform sampler2D uStrokes;    // attachment 0 of the stroke pass
uniform sampler2D uStrokeId;   // attachment 1

// What lies under the strokes. With the ground set to the rendered frame the
// scene reads straight through wherever paint is thin, and the result looks
// like a photograph with dots on it rather than like paint.
uniform float uGroundMode;     // 0 frame · 1 blurred · 2 solid · 3 segment solids
uniform sampler2D uGround;     // the prepared ground, from artGround.frag
uniform vec3  uGroundColor;    // the solid / toned canvas

// ── entrance animation (artPassReveal.js) ───────────────────────────────────
// At rest they are fully revealed, which makes normal operation a no-op.
uniform float uRevealGround;   // 0 = the live frame, 1 = the configured ground
// The priming step — before any mark exists. Both hold at their settled value
// once priming ends and the marks step begins.
uniform float uRevealWeave;    // 0 = no canvas weave yet, 1 = fully arrived
uniform float uRevealLighten;  // 0 = untouched, ramps toward uGroundColor

uniform float uDebugView;      // 0 paint · 1 orientation · 2 depth · 3 segments · 4 edges

void main() {
  vec2 uv = vUv;
  vec2 frag = uv * uRes;

  // Mode 0 keeps the ground inside the mixture — gaps read as field rather than
  // as holes and coverage cannot bias the average — but it also lets the
  // untouched frame show through. The other modes break that tie deliberately.
  // Modes 1 and 3 are prepared by artGround.frag: a gathered blur, because a
  // mip chain cannot reject a tap and so smears far terrain into the ridges
  // standing in front of it. Modes 0 and 2 need no gather — one is the frame,
  // the other a constant.
  vec3 ground;
  if (uGroundMode < 0.5) {
    ground = frameAt(uBeauty, uv);
  } else if (uGroundMode < 1.5 || uGroundMode > 2.5) {
    ground = texture(uGround, uv).rgb;
  } else {
    ground = uGroundColor;
  }

  // Reveal: crossfade from the live frame toward whatever ground mode is
  // actually configured. At 1 (normal operation) this is a no-op.
  if (uRevealGround < 0.999) {
    ground = mix(frameAt(uBeauty, uv), ground, clamp(uRevealGround, 0.0, 1.0));
  }

  // Priming: the whole scene washes toward the toned canvas before any mark
  // exists. Applied AFTER the ground-reveal mix above, on top of whatever it
  // produced — during priming itself uRevealGround is still 0, so this washes
  // the plain live frame; once marks begin, it keeps washing whatever ground
  // mode has since taken over.
  if (uRevealLighten > 0.001) {
    ground = mix(ground, uGroundColor, clamp(uRevealLighten, 0.0, 1.0));
  }

  // Bare canvas shows in the gaps, tinted by its own weave. uRevealWeave holds
  // it at zero until priming has faded it in — a canvas with nothing painted
  // and no weave yet reads as a blank wash arriving, not as fabric.
  vec3 canvasTone = ground * mix(1.0, 0.82 + 0.36 * weaveAt(frag), uWeave * uRevealWeave);

  vec4 strokes = texture(uStrokes, uv);
  vec4 id = texture(uStrokeId, uv);
  float coverage = id.a;

  vec3 col = canvasTone * (1.0 - coverage) + strokes.rgb;
  // A pixel with no visible paint gets no relief, and a fully covered one is
  // untouched. The stroke pass sums a candidate's height whenever its dot
  // merely reaches the pixel (an order-based cut would jump across every rim),
  // which is right for the strokes that cover the pixel and wrong for a gap
  // between them: scaling by the same coverage the colour was composited with
  // ties the two together.
  float height = clamp(strokes.a * coverage, 0.0, 1.0);
  float strokeId = id.r;
  vec2 anchor = id.gb;

  // ── diagnostics ────────────────────────────────────────────────────────────
  // Each of these replaces the paint outright. They also write zero height and
  // own no stroke, so a diagnostic never arrives embossed — shading one does not
  // merely look odd, it changes the values a probe reads back off the canvas.
  if (uDebugView > 0.5) {
    height = 0.0;
    strokeId = NO_STROKE_ID;
    anchor = vec2(0.0);
  }
  if (uDebugView > 0.5 && uDebugView < 1.5) {
    float ang = orientationAt(uv);
    col = vec3(0.5 + 0.5 * cos(2.0 * ang), 0.5 + 0.5 * sin(2.0 * ang), 0.5);
  } else if (uDebugView > 1.5 && uDebugView < 2.5) {
    col = vec3(depth01(uv));                                  // near black → far white
  } else if (uDebugView > 2.5 && uDebugView < 3.5) {
    // The three-way segment the whole pass runs on. Blue sky, cyan water,
    // green land — so a G-buffer that failed to render reads as solid blue
    // rather than as "edge alignment quietly does nothing".
    col = (coverAt(uv) < 0.5) ? vec3(0.1, 0.2, 0.8)
        : (waterAt(uv) > 0.5) ? vec3(0.1, 0.8, 0.8) : vec3(0.2, 0.7, 0.2);
  } else if (uDebugView > 3.5) {
    // The occlusion-edge distance field. Red where a stroke of the current size
    // would be aligned, fading out at the reach; white on the edge itself.
    // Without this view an empty or misaligned field is indistinguishable from
    // the feature simply being switched off.
    vec3 e = nearestEdge(uv);
    float reach = uCellPx * uDotScale * uEdgeReach / max(uAspectRatio, 1.0);
    if (e.z < 1.5) col = vec3(1.0);
    else col = mix(vec3(0.95, 0.2, 0.0), vec3(0.05, 0.07, 0.12),
                   clamp(e.z / max(reach, 1.0), 0.0, 1.0));
  }

  fragColor = vec4(col, height);
  fragId = vec4(strokeId, anchor, 1.0);
}
