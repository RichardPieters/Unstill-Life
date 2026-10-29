import { describe, test, expect } from 'vitest'
import { inject } from '../../src/shared/shaderCompose.js'

describe('inject', () => {
  test('replaces the marker line with its include', () => {
    expect(inject('// M', [['// M', 'X']])).toBe('X')
  })
  test('replaces multiple markers in order', () => {
    const src = '// noise\n// fbm'
    expect(inject(src, [['// noise', 'N'], ['// fbm', 'F']])).toBe('N\nF')
  })
  test('leaves source unchanged when a marker is absent', () => {
    expect(inject('no markers here', [['// M', 'X']])).toBe('no markers here')
  })
  test('replaces only the first occurrence of a marker', () => {
    expect(inject('// M\n// M', [['// M', 'X']])).toBe('X\n// M')
  })
  test('no pairs → identity', () => {
    expect(inject('unchanged', [])).toBe('unchanged')
  })
  test('keeps surrounding lines intact', () => {
    expect(inject('before\n// M\nafter', [['// M', 'X\nY']])).toBe('before\nX\nY\nafter')
  })

  // ── The whole-line contract ────────────────────────────────────────────────
  // Prose left on a marker line would land right after the include's LAST
  // line. For a GLSL include ending in `}` that is a stray token at file scope:
  // the shader fails to compile, the pass renders nothing, and the only trace
  // is a console warning. Consuming the whole line makes that unrepresentable.
  test('consumes trailing prose on the marker line', () => {
    expect(inject('// M — what it holds', [['// M', 'void f() {}']])).toBe('void f() {}')
  })
  test('consumes leading text on the marker line', () => {
    expect(inject('  // M', [['// M', 'X']])).toBe('X')
  })
  test('a real include ending in a brace leaves no stray tokens after it', () => {
    const out = inject('uniform float u;\n// inc.glsl injected by mod.js — geometry helpers\nvoid main() {}',
                       [['// inc.glsl injected by mod.js', 'float f(float x) {\n  return x;\n}']])
    expect(out).toBe('uniform float u;\nfloat f(float x) {\n  return x;\n}\nvoid main() {}')
    expect(out).not.toContain('geometry helpers')
  })

  // GLSL is not a replacement pattern: `$&`, `$1` and friends must survive
  // verbatim rather than being expanded by String.replace.
  test('does not interpret $ patterns in the include', () => {
    expect(inject('// M', [['// M', 'a $& b $1 c']])).toBe('a $& b $1 c')
  })

  // Markers are comments containing regex metacharacters (`/`, `.`, `*`).
  test('treats regex metacharacters in the marker literally', () => {
    expect(inject('// a.b*c injected', [['// a.b*c injected', 'X']])).toBe('X')
    expect(inject('// aXbYc injected', [['// a.b*c injected', 'X']])).toBe('// aXbYc injected')
  })
})
