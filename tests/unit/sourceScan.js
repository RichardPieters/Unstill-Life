import { readFileSync, readdirSync, statSync } from 'node:fs'

/**
 * sourceScan.js — text scan of src/ and tests/ for names an owner removed (its
 * hand-written get/set methods, replaced by `<owner>.params`). A hit is a stale
 * caller or comment. Not a test file: the owners' unit tests call it.
 */

// A temporary review note at the top of a changed file may name what it removed.
const REVIEW_NOTE = /^\s*\/\/\s+- (changed|question|follow-up)/

const files = []
const walk = dir => {
  for (const name of readdirSync(dir)) {
    const p = new URL(name, dir)
    if (statSync(p).isDirectory()) walk(new URL(name + '/', dir))
    else if (/\.(js|mjs)$/.test(name)) files.push(p)
  }
}
walk(new URL('../../src/', import.meta.url))
walk(new URL('../../tests/', import.meta.url))
const ROOT = new URL('../../', import.meta.url).pathname
const SELF = new URL(import.meta.url).pathname

/**
 * Lines naming a removed method.
 * @param {string[]} onlyHere  names defined on no other module: any mention hits
 * @param {{ receiver: string, names: string[] }} [shared]  names other owners
 *   still define: only a call on `receiver` (`water.setX`, `this._water?.setX`) hits
 * @param {string} thisTest  the calling test's own path (import.meta.url), skipped
 * @returns {string[]} `path:line: text`
 */
export function removedNameHits(onlyHere, shared, thisTest) {
  const here = new RegExp(`\\b(${onlyHere.join('|')})\\b`)
  const onReceiver = shared
    ? new RegExp(`\\b_?${shared.receiver}\\??\\.(${shared.names.join('|')})\\b`)
    : null
  const hits = []
  for (const f of files) {
    if (f.pathname === SELF || f.pathname === new URL(thisTest).pathname) continue
    readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      if (REVIEW_NOTE.test(line)) return
      if (here.test(line) || (onReceiver && onReceiver.test(line))) {
        hits.push(`${f.pathname.slice(ROOT.length)}:${i + 1}: ${line.trim()}`)
      }
    })
  }
  return hits
}
