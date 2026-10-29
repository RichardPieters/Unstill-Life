/**
 * shaderCompose.js — the one way a GLSL include reaches a shader.
 *
 * A shader imported with `?raw` carries marker comments (`// noise.glsl
 * injected by terrain.js`) where shared includes go; the owning module splices
 * them in with `inject()` before compiling. Used by terrain, water, clouds,
 * godrays and the art pass; GLSL has no include mechanism of its own here.
 *
 * Pure string transform: no THREE, and no HMR. The modules that hot-reload
 * shaders (terrain, water, cloudsVolume) each keep their own
 * `import.meta.hot.accept`, because Vite fires the accept callback in whichever
 * module imports the `?raw` specifier; godrays, the weather map and the art
 * pass do not hot-reload.
 */

const escapeRegExp = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Replace the first LINE containing each marker with its include, in order.
 * A marker that matches no line leaves the source unchanged.
 *
 * The whole line goes, not just the marker: prose after a marker would
 * otherwise land right after the include's last line, a stray token at file
 * scope that fails the compile and renders the pass black, with the cause only
 * in a console warning. Text before the marker on its line goes too; every
 * marker in this project sits alone on its line.
 *
 * The include is inserted verbatim (a replacer function, so `$&` and `$1` in
 * GLSL are not expanded), and regex metacharacters in the marker match
 * literally.
 *
 * @param {string} source                    shader source containing markers
 * @param {Array<[string, string]>} pairs     [markerComment, glslInclude] pairs
 * @returns {string}
 */
export function inject(source, pairs) {
  let out = source
  for (const [marker, glsl] of pairs) {
    out = out.replace(new RegExp(`^.*${escapeRegExp(marker)}.*$`, 'm'), () => glsl)
  }
  return out
}

/**
 * Splice every `//#include name` marker of `source` with `includes[name]`, in
 * the order the shader lists them. A marker names its include, so the shader
 * file is the only place that says what it needs; an unknown name throws.
 *
 * @param {string} source
 * @param {Record<string, string>} includes  GLSL by name
 */
export function injectIncludes(source, includes) {
  return source.replace(/^[ \t]*\/\/#include[ \t]+(\w+)[ \t]*$/gm, (_, name) => {
    if (!(name in includes)) throw new Error(`injectIncludes: unknown include "${name}"`)
    return includes[name]
  })
}

/**
 * Every uniform name a GLSL source declares, including `uniform float a, b;`
 * and arrays (`uniform vec3 p[16];`). Comments are stripped first, so a
 * commented-out or documented declaration does not count.
 */
export function declaredUniforms(src) {
  const names = []
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  for (const m of code.matchAll(/\buniform\s+\w+\s+([^;]+);/g)) {
    for (const part of m[1].split(',')) {
      const n = part.trim().replace(/\[.*$/, '').trim()
      if (n) names.push(n)
    }
  }
  return names
}

/**
 * The uniforms object of a program, built from the program's own source: every
 * name it declares, each taken from the one pool that has it.
 *
 * The shader is the single statement of what it reads. A name declared but
 * found in no pool, or in two, throws at construction instead of leaving a
 * uniform silently unset; a name in `own` that the shader does not declare
 * throws as well (a stale entry would otherwise sit there, unused, forever).
 * Pools other than `own` are shared by many programs and simply hold more than
 * any one of them declares.
 *
 * @param {string} source  the composed GLSL
 * @param {Record<string, Record<string, {value:any}>>} pools  by pool name; the
 *   `own` pool is checked for staleness
 * @param {string} label   program name, for the error message
 */
export function mountUniforms(source, pools, label = 'program') {
  const declared = new Set(declaredUniforms(source))
  for (const name of Object.keys(pools.own || {})) {
    if (!declared.has(name)) throw new Error(`${label}: "${name}" is listed as its own uniform but the shader does not declare it`)
  }
  const out = {}
  for (const name of declared) {
    const holders = Object.entries(pools).filter(([, pool]) => name in pool)
    if (holders.length === 0) throw new Error(`${label}: the shader declares "${name}" but no uniform pool has it`)
    if (holders.length > 1) throw new Error(`${label}: "${name}" is in ${holders.map(h => h[0]).join(' and ')}; one pool must own it`)
    out[name] = holders[0][1][name]
  }
  return out
}
