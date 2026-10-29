// dataMapSample.glsl — shared smoothstepped data-map coordinate helper.
//
// Smoothsteps the fractional part of a data-map UV so bilinear filtering
// becomes C1-continuous — removes the diagonal texel-cell derivative kinks
// plain bilinear leaves on smooth slopes (after Inigo Quilez's "improved texture
// interpolation", https://iquilezles.org/articles/texture/). Used by both terrain.vert
// (displacement + normal read) and derive.frag (the gradient bake). Depends on
// the includer's own `uDataMapTexel` uniform.
vec2 smoothDataUV(vec2 uv) {
  vec2 t = uv / uDataMapTexel - 0.5;
  vec2 i = floor(t);
  vec2 f = t - i;
  f = f * f * (3.0 - 2.0 * f);
  return (i + 0.5 + f) * uDataMapTexel;
}
