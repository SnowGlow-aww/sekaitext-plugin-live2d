// Packages the built plugin into a distributable .sekplugin (a zip of
// manifest.json + dist/* flattened to the archive root). Run after `vite build`:
//   node pack.mjs            → dist-plugins/<id>-<version>.sekplugin
//   node pack.mjs <outDir>   → <outDir>/<id>-<version>.sekplugin
// Archive layout matches what the SekaiText host's Install expects: manifest.json
// at root, entry.js + assets alongside (NOT nested under dist/).
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, readFileSync, copyFileSync, rmSync, readdirSync, statSync } from 'fs'
import { join, dirname, relative } from 'path'
import { fileURLToPath } from 'url'
import { tmpdir } from 'os'

const root = dirname(fileURLToPath(import.meta.url))
const outDir = process.argv[2] ? join(root, process.argv[2]) : join(root, 'dist-plugins')
const distDir = join(root, 'dist')
const manifestPath = join(root, 'manifest.json')

if (!existsSync(manifestPath)) {
  console.error('[pack] missing manifest.json'); process.exit(1)
}
if (!existsSync(distDir)) {
  console.error('[pack] not built (no dist/). Run: npm run build'); process.exit(1)
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const id = manifest.id || 'plugin'
const version = manifest.version || '0.0.0'
mkdirSync(outDir, { recursive: true })
const outFile = join(outDir, `${id}-${version}.sekplugin`)

// Stage manifest.json + dist/* into a temp dir, then zip its contents at root.
const stage = join(tmpdir(), `sekplugin-${id}-${version}`)
rmSync(stage, { recursive: true, force: true })
mkdirSync(stage, { recursive: true })

function copyTree(src, dst) {
  mkdirSync(dst, { recursive: true })
  for (const name of readdirSync(src)) {
    const sp = join(src, name), dp = join(dst, name)
    if (statSync(sp).isDirectory()) copyTree(sp, dp)
    else copyFileSync(sp, dp)
  }
}
copyTree(distDir, stage)
copyFileSync(manifestPath, join(stage, 'manifest.json'))

rmSync(outFile, { force: true })
execFileSync('zip', ['-r', '-X', '-q', outFile, '.'], { cwd: stage, stdio: 'inherit' })
rmSync(stage, { recursive: true, force: true })
console.log(`[pack] wrote ${relative(root, outFile)}`)
