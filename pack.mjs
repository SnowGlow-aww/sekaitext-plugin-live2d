// Packages the built plugin into a distributable .sekplugin (a zip of
// manifest.json + dist/* flattened to the archive root). Run after `vite build`:
//   node pack.mjs            → dist-plugins/<id>-<version>.sekplugin
//   node pack.mjs <outDir>   → <outDir>/<id>-<version>.sekplugin
// Archive layout matches what the SekaiText host's Install expects: manifest.json
// at root, entry.js + assets alongside (NOT nested under dist/).
import { execFileSync } from 'child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync } from 'fs'
import { join, dirname, relative } from 'path'
import { fileURLToPath } from 'url'
import { tmpdir } from 'os'

const root = dirname(fileURLToPath(import.meta.url))
const outDir = process.argv[2] ? join(root, process.argv[2]) : join(root, 'dist-plugins')
const distDir = join(root, 'dist')
const manifestPath = join(root, 'manifest.json')
const packagePath = join(root, 'package.json')
const packageLockPath = join(root, 'package-lock.json')

if (!existsSync(manifestPath)) {
  console.error('[pack] missing manifest.json'); process.exit(1)
}
if (!existsSync(distDir)) {
  console.error('[pack] not built (no dist/). Run: npm run build'); process.exit(1)
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const packageJSON = JSON.parse(readFileSync(packagePath, 'utf8'))
const packageLock = JSON.parse(readFileSync(packageLockPath, 'utf8'))
const id = manifest.id
const version = manifest.version
if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || typeof manifest.name !== 'string' || !manifest.name.trim()) {
  throw new Error('[pack] manifest id/name is invalid')
}
if (!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(version)) {
  throw new Error('[pack] manifest version must be stable strict semver')
}
if (packageJSON.version !== version) throw new Error('[pack] package.json and manifest.json versions differ')
if (packageLock.version !== version || packageLock.packages?.['']?.version !== version) {
  throw new Error('[pack] package-lock.json root versions differ')
}
mkdirSync(outDir, { recursive: true })
const outFile = join(outDir, `${id}-${version}.sekplugin`)

// Stage manifest.json + dist/* into a temp dir, then zip its contents at root.
const stage = mkdtempSync(join(tmpdir(), `sekplugin-${id}-${version}-`))

function copyTree(src, dst) {
  mkdirSync(dst, { recursive: true })
  for (const name of readdirSync(src).sort()) {
    const sp = join(src, name), dp = join(dst, name)
    if (statSync(sp).isDirectory()) copyTree(sp, dp)
    else copyFileSync(sp, dp)
  }
}
copyTree(distDir, stage)
copyFileSync(manifestPath, join(stage, 'manifest.json'))

function archiveFiles(dir, prefix = '') {
  const files = []
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name)
    const archivePath = prefix ? `${prefix}/${name}` : name
    if (statSync(path).isDirectory()) files.push(...archiveFiles(path, archivePath))
    else files.push(archivePath)
  }
  return files
}

try {
  const fixedTime = new Date('2000-01-01T00:00:00Z')
  const files = archiveFiles(stage)
  for (const name of files) {
    const path = join(stage, name)
    chmodSync(path, 0o644)
    utimesSync(path, fixedTime, fixedTime)
  }
  rmSync(outFile, { force: true })
  execFileSync('zip', ['-X', '-q', outFile, ...files], {
    cwd: stage,
    env: { ...process.env, TZ: 'UTC' },
    stdio: 'inherit',
  })
} finally {
  rmSync(stage, { recursive: true, force: true })
}
console.log(`[pack] wrote ${relative(root, outFile)}`)
