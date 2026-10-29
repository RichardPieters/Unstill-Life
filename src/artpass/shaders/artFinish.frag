/**
 * artFinish.frag — the painting's surface, lit.
 *
 * Separate from the stroke pass because the relief needs a real height FIELD,
 * not a per-fragment number. Taking the normal from dFdx/dFdy of a sum computed
 * inside the stroke shader gives a derivative over a 2x2 quad — two samples,
 * one pixel apart, of a quantity that jumps wherever the candidate set changes.
 * That reads as confusing noise rather than as paint.
 *
 * So the stroke pass accumulates thickness and the compose pass writes it into
 * the alpha of the paint buffer, and this pass differentiates it with a Sobel over a real neighbourhood. A
 * Sobel is a derivative-of-a-smoothed-signal, far steadier than a central
 * difference, which matters because the height field carries genuine
 * high-frequency detail — bristle grooves — that a central difference would
 * turn into salt-and-pepper normals. The sampling radius is exposed: small
 * reads every groove, large reads only the stacking of whole strokes.
 *
 * The lamp is fixed to the CANVAS, not to the scene's sun. Relief belongs to
 * the object — the painting — and a viewer who tilts it sees the light move
 * with the room, not with the depicted afternoon.
 */

//#include hash
//#include format
//#include noise

in  vec2 vUv;
out vec4 fragColor;

uniform sampler2D uPaint;      // RGB = colour, ALPHA = thickness / HEIGHT_MAX
uniform vec2  uRes;

uniform float uWeaveDepth;     // how much the weave displaces the surface
// Priming (artPass.js's playReveal): 0 before the canvas has arrived, ramping
// to 1 as it fades in, then held there for the rest of the reveal and beyond.
uniform float uRevealWeave;
// The exit's closing sweep (artPassReveal.js's _tickExit): 1 is a canvas fully
// present, 0 none of it. The painting's SURFACE has to leave along with the
// last of the paint — without this a fully dissolved frame is still being
// crevice-darkened and tone-compressed as though it were paint, and the
// moment the pass switches itself off the picture visibly pops back.
uniform float uExitFade;
uniform float uHeightScale;    // world height per unit of accumulated paint
// The entrance animation (artPass.js's playReveal): 1 is normal operation.
// Trails the marks' own arrival — coverage completes, THEN the paint visibly
// thickens under the lamp, rather than gaining depth the instant it lands.
uniform float uRevealRelief;
uniform float uNormalRadius;   // Sobel radius: bristle detail vs stroke stacking
uniform float uLightAz;        // studio lamp, radians
uniform float uLightEl;
uniform float uAmbient;
uniform float uDiffuse;
uniform float uSpecular;
uniform float uSpecPower;
uniform float uCrevice;        // occlusion where almost no paint reached
uniform float uHighKey;        // tonal band: nothing reaches white or black
uniform float uDebug;          // 1 = a diagnostic view is showing

float heightAt(vec2 uv) {
  return texture(uPaint, uv).a * HEIGHT_MAX;
}

/** Total surface height: the paint, plus the weave the paint sits on. */
float surfaceAt(vec2 uv, vec2 frag) {
  float h = heightAt(uv) * uHeightScale * uRevealRelief;
  // Thick paint fills the weave in, so the canvas only shows where paint is
  // thin. That is the whole reason a scumbled passage reads as canvas and a
  // loaded one reads as paint.
  float weaveAmt = uWeave * uRevealWeave * uExitFade;
  if (weaveAmt > 0.0 && uWeaveDepth > 0.0) {
    float fill = clamp(h * 2.0, 0.0, 1.0);
    h += (weaveAt(frag) - 0.5) * uWeaveDepth * weaveAmt * (1.0 - fill);
  }
  return h;
}

void main() {
  vec2 frag = vUv * uRes;
  vec3 col = texture(uPaint, vUv).rgb;

  // A diagnostic must arrive unlit and untouched. Shading a debug view does not
  // merely look odd — it changes the values a probe reads back off the canvas.
  if (uDebug > 0.5) { fragColor = vec4(col, 1.0); return; }

  float r = max(uNormalRadius, 0.5);
  vec2 px = r / uRes;

  float h00 = surfaceAt(vUv + vec2(-px.x, -px.y), frag + vec2(-r, -r));
  float h10 = surfaceAt(vUv + vec2(0.0, -px.y), frag + vec2(0.0, -r));
  float h20 = surfaceAt(vUv + vec2(px.x, -px.y), frag + vec2(r, -r));
  float h01 = surfaceAt(vUv + vec2(-px.x, 0.0), frag + vec2(-r, 0.0));
  float h21 = surfaceAt(vUv + vec2(px.x, 0.0), frag + vec2(r, 0.0));
  float h02 = surfaceAt(vUv + vec2(-px.x, px.y), frag + vec2(-r, r));
  float h12 = surfaceAt(vUv + vec2(0.0, px.y), frag + vec2(0.0, r));
  float h22 = surfaceAt(vUv + vec2(px.x, px.y), frag + vec2(r, r));

  float gx = (h20 + 2.0 * h21 + h22) - (h00 + 2.0 * h01 + h02);
  float gy = (h02 + 2.0 * h12 + h22) - (h00 + 2.0 * h10 + h20);
  // Divide by the sampling distance so the normal does not depend on the radius
  // slider — the radius should change WHICH detail is seen, not how steep it is.
  gx /= (8.0 * r);
  gy /= (8.0 * r);

  vec3 n = normalize(vec3(-gx, -gy, 1.0));

  float ca = cos(uLightAz), sa = sin(uLightAz);
  float ce = cos(uLightEl), se = sin(uLightEl);
  vec3 L = normalize(vec3(ca * ce, sa * ce, se));
  vec3 V = vec3(0.0, 0.0, 1.0);
  vec3 H = normalize(L + V);

  // Diffuse is CENTRED on the flat-paint response, so raising it lightens the
  // ridges and darkens the troughs without also lifting the whole picture.
  // Uncentred, the strength slider doubles as an exposure control.
  float flat0 = clamp(dot(vec3(0.0, 0.0, 1.0), L), 0.0, 1.0);
  float diff = clamp(dot(n, L), 0.0, 1.0) - flat0;
  float spec = pow(clamp(dot(n, H), 0.0, 1.0), max(uSpecPower, 1.0));
  float specFlat = pow(clamp(dot(vec3(0.0, 0.0, 1.0), H), 0.0, 1.0), max(uSpecPower, 1.0));

  col *= uAmbient + (1.0 - uAmbient) * (1.0 + uDiffuse * diff);
  col += uSpecular * (spec - specFlat);

  // Occlusion only where almost no paint reached — the genuine troughs between
  // strokes, not the shallow side of every ridge.
  float bare = clamp(1.0 - texture(uPaint, vUv).a * HEIGHT_MAX * 1.5, 0.0, 1.0);
  col *= 1.0 - uCrevice * 0.35 * bare * uExitFade;

  // The references live in a narrow tonal band and buy their apparent contrast
  // from hue opposition instead. Nothing reaches white or black.
  if (uHighKey > 0.0) {
    col = mix(col, mix(vec3(0.13), vec3(0.93), col), uHighKey * uExitFade);
  }

  fragColor = vec4(col, 1.0);
}
