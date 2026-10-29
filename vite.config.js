import { defineConfig } from 'vite'
import { readFileSync, readdirSync } from 'node:fs'

// Third-party licences require their notices to travel with the built piece, not
// only with the repository: emit them into dist/ next to the page.
const NOTICE_FILES = ['THIRD_PARTY_NOTICES.md', 'COPYRIGHT.md']
const LICENCE_DIR = 'LICENSES'

function shipNotices() {
  return {
    name: 'ship-notices',
    apply: 'build',
    generateBundle() {
      const files = [
        ...NOTICE_FILES,
        ...readdirSync(LICENCE_DIR).map((name) => `${LICENCE_DIR}/${name}`),
      ]
      for (const fileName of files) {
        this.emitFile({ type: 'asset', fileName, source: readFileSync(fileName) })
      }
    },
  }
}

export default defineConfig({
  plugins: [shipNotices()],
  // Target modern evergreen browsers — projection piece, no legacy support needed.
  // ES2022 required for top-level await in main.js.
  build: {
    target: 'es2022',
  },
  // Vitest reads this block; the unit tests run in Node, without a browser.
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.js'],
    coverage: {
      provider: 'v8',
      include: ['src/dynamics/dynamics.js', 'src/interaction/interaction.js'],
    },
  },
})
