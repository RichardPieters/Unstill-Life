/**
 * artFormat.glsl — the paint buffer's encoding, shared by every program that
 * writes or reads it.
 *
 * The finished paint is two attachments: colour with the paint's thickness in
 * alpha, and which stroke owns each pixel. These two constants are the whole
 * contract; a program that redefined them would still compile and render a
 * plausible, wrong picture.
 */

// The accumulated-paint range the thickness channel represents: alpha is
// thickness / HEIGHT_MAX.
const float HEIGHT_MAX = 8.0;

// fragId.r where no stroke owns a pixel (bare canvas). A stroke id is a hash in
// [0,1), so -1 cannot collide with one.
const float NO_STROKE_ID = -1.0;
