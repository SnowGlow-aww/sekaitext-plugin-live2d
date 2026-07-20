import { execFileSync } from 'node:child_process'
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const PACKAGE_HEADER = 'SekaiText-Plugin-Signature-V1\n'
const METADATA_HEADER = 'SekaiText-Plugin-Metadata-Signature-V2\n'
const SNAPSHOT_HEADER = 'SekaiText-Plugin-Market-Snapshot-V1\n'
const ALLOWED_INDEX_KEYS = new Set([
  'version', 'plugins', 'publisher', 'keyId', 'signatureAlgorithm', 'sequence',
  'expiresAt', 'snapshotSignature',
])
const ALLOWED_ENTRY_KEYS = new Set([
  'id', 'name', 'version', 'description', 'author', 'icon', 'minHostVersion',
  'download', 'sha256', 'homepage', 'publisher', 'keyId', 'signatureAlgorithm',
  'packageSignature', 'sequence', 'expiresAt', 'metadataSignature',
])
const ALLOWED_MANIFEST_KEYS = new Set(['id', 'name', 'version', 'description', 'author', 'entry', 'minHostVersion', 'icon'])
const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/

function check(condition, message) {
  if (!condition) throw new Error(message)
}

export function compareStableVersions(left, right) {
  check(SEMVER.test(left ?? '') && SEMVER.test(right ?? ''), 'versions must be stable strict semver')
  const a = left.split('.').map(BigInt)
  const b = right.split('.').map(BigInt)
  for (let i = 0; i < 3; i++) {
    if (a[i] < b[i]) return -1
    if (a[i] > b[i]) return 1
  }
  return 0
}

export function assertVersionReplacement(existing, candidate) {
  if (!existing) return
  const comparison = compareStableVersions(candidate.version, existing.version)
  check(comparison >= 0, `${candidate.id}: refusing to replace newer v${existing.version} with older v${candidate.version}`)
  if (comparison === 0) {
    check(candidate.sha256 === existing.sha256, `${candidate.id}: version ${candidate.version} is immutable and already has different bytes`)
  }
}

function exactObject(value, keys, label) {
  check(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`)
  for (const key of Object.keys(value)) check(keys.has(key), `${label} has unknown property ${key}`)
}

function base64(value, label, size) {
  check(typeof value === 'string' && value.length > 0, `${label} is missing`)
  const decoded = Buffer.from(value, 'base64')
  check(decoded.toString('base64') === value && (!size || decoded.length === size), `${label} is not canonical Base64`)
  return decoded
}

function boundedString(value, maxBytes, label, { optional = false, nonBlank = false } = {}) {
  if (optional && value === undefined) return
  check(
    typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= maxBytes && (!nonBlank || value.trim()),
    `${label} is invalid`,
  )
}

function field(name, value) {
  check(typeof value === 'string', `${name} must be a string`)
  return `${name}:${Buffer.byteLength(value)}:${value}\n`
}

export function packagePayload(entry) {
  return Buffer.from(PACKAGE_HEADER +
    field('publisher', entry.publisher) + field('keyId', entry.keyId) +
    field('algorithm', entry.signatureAlgorithm) + field('id', entry.id) +
    field('version', entry.version) + field('download', entry.download) +
    field('sha256', entry.sha256))
}

export function metadataPayload(entry) {
  return Buffer.from(METADATA_HEADER +
    field('publisher', entry.publisher) + field('keyId', entry.keyId) +
    field('algorithm', entry.signatureAlgorithm) + field('id', entry.id) +
    field('name', entry.name) + field('version', entry.version) +
    field('description', entry.description ?? '') + field('author', entry.author ?? '') +
    field('icon', entry.icon ?? '') + field('minHostVersion', entry.minHostVersion ?? '') +
    field('download', entry.download) + field('sha256', entry.sha256) +
    field('homepage', entry.homepage ?? '') + field('sequence', String(entry.sequence)) +
    field('expiresAt', entry.expiresAt))
}

export function snapshotPayload(index) {
  let payload = SNAPSHOT_HEADER +
    field('publisher', index.publisher) + field('keyId', index.keyId) +
    field('algorithm', index.signatureAlgorithm) + field('version', String(index.version)) +
    field('sequence', String(index.sequence)) + field('expiresAt', index.expiresAt) +
    field('pluginCount', String(index.plugins.length))
  for (const entry of index.plugins) {
    payload += field('pluginId', entry.id) + field('metadataSignature', entry.metadataSignature)
  }
  return Buffer.from(payload)
}

export function marketExpiry(now = Date.now()) {
  const expiry = new Date(now + 180 * 24 * 60 * 60 * 1000)
  expiry.setUTCMilliseconds(0)
  return expiry.toISOString().replace('.000Z', 'Z')
}

function httpsURL(value, label) {
  let url
  try { url = new URL(value) } catch { throw new Error(`${label} is not an absolute URL`) }
  check(url.protocol === 'https:' && !url.username && !url.password && !url.hash, `${label} must use HTTPS without credentials or fragments`)
  return url
}

function safeEnv() {
  const env = { ...process.env }
  delete env.PLUGIN_SIGNING_PRIVATE_KEY
  return env
}

function parseTrustMap(raw) {
  let trustMap
  try { trustMap = JSON.parse(raw) } catch { throw new Error('SEKAITEXT_PLUGIN_PUBLIC_KEYS must be a JSON object') }
  check(trustMap && typeof trustMap === 'object' && !Array.isArray(trustMap) && Object.keys(trustMap).length > 0, 'official app plugin trust map is empty')
  for (const [keyId, value] of Object.entries(trustMap)) {
    check(/^[A-Za-z0-9._-]{1,64}$/.test(keyId), `trust map keyId is invalid: ${keyId}`)
    base64(value, `trust map key ${keyId}`, 32)
  }
  return trustMap
}

function trustedPublicKey(trustMap, keyId) {
  const raw = base64(trustMap[keyId] ?? '', `trusted public key ${keyId}`, 32)
  return createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]),
    format: 'der',
    type: 'spki',
  })
}

function run(command, args, options = {}) {
  return execFileSync(command, args, { stdio: 'inherit', env: safeEnv(), ...options })
}

export function hasStagedChanges(marketDir) {
  try {
    execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', marketDir, 'diff', '--cached', '--quiet'], {
      env: safeEnv(),
      stdio: 'ignore',
    })
    return false
  } catch (error) {
    if (error?.status === 1) return true
    throw error
  }
}

export function commitIfChanged(marketDir, message, commit = () => run(
  'git', ['-c', 'core.hooksPath=/dev/null', '-C', marketDir, 'commit', '-m', message],
)) {
  if (!hasStagedChanges(marketDir)) return false
  commit()
  return true
}

function readArchiveManifest(archive, expected) {
  const names = execFileSync('unzip', ['-Z1', archive], { encoding: 'utf8', env: safeEnv() }).trim().split(/\r?\n/)
  check(names.filter((name) => name === 'manifest.json').length === 1, `${expected.id}: archive needs one root manifest.json`)
  check(names.includes('entry.js'), `${expected.id}: archive is missing root entry.js`)
  const manifest = JSON.parse(execFileSync('unzip', ['-p', archive, 'manifest.json'], { encoding: 'utf8', env: safeEnv(), maxBuffer: 1024 * 1024 }))
  exactObject(manifest, ALLOWED_MANIFEST_KEYS, `${expected.id} manifest`)
  check(/^[A-Za-z0-9_-]{1,64}$/.test(manifest.id ?? ''), `${expected.id}: manifest id is invalid`)
  boundedString(manifest.name, 200, `${expected.id}: manifest name`, { nonBlank: true })
  boundedString(manifest.description, 4000, `${expected.id}: manifest description`, { optional: true })
  boundedString(manifest.author, 200, `${expected.id}: manifest author`, { optional: true })
  boundedString(manifest.icon, 100, `${expected.id}: manifest icon`, { optional: true })
  check(SEMVER.test(manifest.version ?? '') && manifest.entry === 'entry.js', `${expected.id}: manifest version/entry is invalid`)
  if (manifest.minHostVersion) check(SEMVER.test(manifest.minHostVersion), `${expected.id}: minHostVersion is invalid`)
  check(manifest.id === expected.id && manifest.version === expected.version, `${expected.id}: archive id/version mismatch`)
  for (const key of ['name', 'description', 'author', 'icon', 'minHostVersion']) {
    check((manifest[key] ?? '') === (expected[key] ?? ''), `${expected.id}: manifest ${key} differs from index`)
  }
}

function validatePayloads(index, marketDir) {
  exactObject(index, ALLOWED_INDEX_KEYS, 'index')
  check(index.version === 2 || index.version === 3, 'index.version must be 2 or 3 before upgrade')
  check(Array.isArray(index.plugins) && index.plugins.length > 0 && index.plugins.length <= 1000, 'plugins must be a non-empty bounded array')
  const seen = new Set()
  for (const entry of index.plugins) {
    exactObject(entry, ALLOWED_ENTRY_KEYS, `entry ${entry?.id ?? '(unknown)'}`)
    check(/^[A-Za-z0-9_-]{1,64}$/.test(entry.id ?? '') && !seen.has(entry.id), 'invalid or duplicate plugin id')
    seen.add(entry.id)
    boundedString(entry.name, 200, `${entry.id}: name`, { nonBlank: true })
    boundedString(entry.description, 4000, `${entry.id}: description`, { optional: true })
    boundedString(entry.author, 200, `${entry.id}: author`, { optional: true })
    boundedString(entry.icon, 100, `${entry.id}: icon`, { optional: true })
    check(SEMVER.test(entry.version ?? ''), `${entry.id}: version must be stable strict semver`)
    if (entry.minHostVersion) check(SEMVER.test(entry.minHostVersion), `${entry.id}: minHostVersion must be stable strict semver`)
    const download = httpsURL(entry.download, `${entry.id}: download`)
    if (entry.homepage) httpsURL(entry.homepage, `${entry.id}: homepage`)
    check(/^[0-9a-f]{64}$/.test(entry.sha256 ?? ''), `${entry.id}: sha256 is invalid`)
    const expectedName = `${entry.id}-${entry.version}.sekplugin`
    check(basename(download.pathname) === expectedName, `${entry.id}: filename must exactly match id/version`)
    const archive = join(marketDir, 'plugins', expectedName)
    check(existsSync(archive), `${entry.id}: archive is missing`)
    check(createHash('sha256').update(readFileSync(archive)).digest('hex') === entry.sha256, `${entry.id}: archive digest mismatch`)
    readArchiveManifest(archive, entry)
  }
}

export function verifyExistingIndex(index, marketDir, trustMap, { allowExpired = true } = {}) {
  validatePayloads(index, marketDir)
  if (index.version === 2) {
    for (const key of ['publisher', 'keyId', 'signatureAlgorithm', 'sequence', 'expiresAt', 'snapshotSignature']) {
      check(index[key] == null, `index.${key} is forbidden in v2`)
    }
  } else {
    check(index.publisher === 'sekaitext-official', 'index.publisher is invalid')
    check(/^[A-Za-z0-9._-]{1,64}$/.test(index.keyId ?? ''), 'index.keyId is invalid')
    check(index.signatureAlgorithm === 'ed25519', 'index.signatureAlgorithm is invalid')
    check(Number.isSafeInteger(index.sequence) && index.sequence > 0, 'index.sequence is invalid')
    const expiry = new Date(index.expiresAt)
    check(!Number.isNaN(expiry.valueOf()) && expiry.toISOString().replace('.000Z', 'Z') === index.expiresAt, 'index.expiresAt is invalid')
    if (!allowExpired) check(expiry > new Date(), 'index.expiresAt must be in the future')
    base64(index.snapshotSignature, 'index.snapshotSignature', 64)
  }
  for (const entry of index.plugins) {
    check(entry.publisher === 'sekaitext-official', `${entry.id}: publisher is invalid`)
    check(/^[A-Za-z0-9._-]{1,64}$/.test(entry.keyId ?? ''), `${entry.id}: keyId is invalid`)
    check(entry.signatureAlgorithm === 'ed25519', `${entry.id}: signatureAlgorithm is invalid`)
    const publicKey = trustedPublicKey(trustMap, entry.keyId)
    const packageSignature = base64(entry.packageSignature, `${entry.id}: packageSignature`, 64)
    check(verify(null, packagePayload(entry), publicKey, packageSignature), `${entry.id}: existing packageSignature verification failed`)
    if (index.version === 2) {
      check(entry.sequence == null && entry.expiresAt == null && entry.metadataSignature == null, `${entry.id}: v3 fields are forbidden in v2`)
      continue
    }
    check(Number.isSafeInteger(entry.sequence) && entry.sequence > 0, `${entry.id}: sequence is invalid`)
    const expiry = new Date(entry.expiresAt)
    check(!Number.isNaN(expiry.valueOf()) && expiry.toISOString().replace('.000Z', 'Z') === entry.expiresAt, `${entry.id}: expiresAt is invalid`)
    if (!allowExpired) check(expiry > new Date(), `${entry.id}: expiresAt must be in the future`)
    const metadataSignature = base64(entry.metadataSignature, `${entry.id}: metadataSignature`, 64)
    check(verify(null, metadataPayload(entry), publicKey, metadataSignature), `${entry.id}: existing metadataSignature verification failed`)
    check(
      entry.publisher === index.publisher && entry.keyId === index.keyId &&
        entry.signatureAlgorithm === index.signatureAlgorithm && entry.sequence === index.sequence &&
        entry.expiresAt === index.expiresAt,
      `${entry.id}: v3 signing metadata does not match the snapshot`,
    )
  }
  if (index.version === 3) {
    const publicKey = trustedPublicKey(trustMap, index.keyId)
    const signature = base64(index.snapshotSignature, 'index.snapshotSignature', 64)
    check(verify(null, snapshotPayload(index), publicKey, signature), 'index.snapshotSignature verification failed')
  }
}

function validateAndSign(index, marketDir, privateKey, keyId, sequence, expiresAt, trustMap) {
  validatePayloads(index, marketDir)
  index.version = 3
  index.publisher = 'sekaitext-official'
  index.keyId = keyId
  index.signatureAlgorithm = 'ed25519'
  index.sequence = sequence
  index.expiresAt = expiresAt
  for (const entry of index.plugins) {
    entry.publisher = 'sekaitext-official'
    entry.keyId = keyId
    entry.signatureAlgorithm = 'ed25519'
    entry.sequence = sequence
    entry.expiresAt = expiresAt
    entry.packageSignature = sign(null, packagePayload(entry), privateKey).toString('base64')
    entry.metadataSignature = sign(null, metadataPayload(entry), privateKey).toString('base64')
  }
  index.snapshotSignature = sign(null, snapshotPayload(index), privateKey).toString('base64')
  verifyExistingIndex(index, marketDir, trustMap, { allowExpired: false })
}

function main() {
  const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'))
  const packageJSON = JSON.parse(readFileSync('package.json', 'utf8'))
  exactObject(manifest, ALLOWED_MANIFEST_KEYS, 'manifest')
  check(SEMVER.test(manifest.version ?? '') && packageJSON.version === manifest.version, 'package and manifest versions must be identical stable semver')
  check(process.env.GITHUB_REF_NAME === `v${manifest.version}`, `tag must be exactly v${manifest.version}`)
  const artifact = join('dist-plugins', `${manifest.id}-${manifest.version}.sekplugin`)
  check(existsSync(artifact), `missing exact artifact ${artifact}`)
  const keyId = process.env.PLUGIN_SIGNING_KEY_ID ?? ''
  check(/^[A-Za-z0-9._-]{1,64}$/.test(keyId), 'PLUGIN_SIGNING_KEY_ID is invalid')
  const privateKey = createPrivateKey({ key: base64(process.env.PLUGIN_SIGNING_PRIVATE_KEY ?? '', 'private key'), format: 'der', type: 'pkcs8' })
  check(privateKey.asymmetricKeyType === 'ed25519', 'private key is not Ed25519')
  const trustMap = parseTrustMap(process.env.SEKAITEXT_PLUGIN_PUBLIC_KEYS ?? '')
  const publicKey = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64')
  check(base64(trustMap[keyId] ?? '', `trust map key ${keyId}`, 32).toString('base64') === publicKey, 'private key does not match official app trust map')
  const token = process.env.MANIFEST_REPO_TOKEN ?? ''
  check(token, 'MANIFEST_REPO_TOKEN is missing')
  const requestedSequence = Number(process.env.MARKET_SEQUENCE)
  check(Number.isSafeInteger(requestedSequence) && requestedSequence > 0, 'MARKET_SEQUENCE must be a positive safe integer')
  const homepage = httpsURL(process.env.PLUGIN_HOMEPAGE ?? '', 'PLUGIN_HOMEPAGE').toString().replace(/\/$/, '')
  const root = mkdtempSync(join(tmpdir(), 'sekaitext-market-publish-'))
  try {
    for (let attempt = 1; attempt <= 5; attempt++) {
      const marketDir = join(root, `attempt-${attempt}`)
      run('git', ['-c', 'core.hooksPath=/dev/null', 'clone', '--depth', '1', `https://x-access-token:${token}@github.com/SnowGlow-aww/sekaitext-plugins.git`, marketDir])
      const indexPath = join(marketDir, 'index.json')
      const index = JSON.parse(readFileSync(indexPath, 'utf8'))
      verifyExistingIndex(index, marketDir, trustMap)
      mkdirSync(join(marketDir, 'plugins'), { recursive: true })
      const filename = basename(artifact)
      const target = join(marketDir, 'plugins', filename)
      cpSync(artifact, target)
      const entry = {
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        description: manifest.description ?? '',
        author: manifest.author ?? '',
        icon: manifest.icon ?? '',
        minHostVersion: manifest.minHostVersion ?? '',
        download: `https://raw.githubusercontent.com/SnowGlow-aww/sekaitext-plugins/main/plugins/${filename}`,
        sha256: createHash('sha256').update(readFileSync(target)).digest('hex'),
        homepage,
      }
      const oldIndex = index.plugins.findIndex((item) => item.id === entry.id)
      assertVersionReplacement(oldIndex >= 0 ? index.plugins[oldIndex] : null, entry)
      if (oldIndex >= 0) index.plugins[oldIndex] = entry
      else index.plugins.push(entry)
      const previousSequence = Math.max(0, ...index.plugins.map((item) => Number.isSafeInteger(item.sequence) ? item.sequence : 0))
      const sequence = Math.max(requestedSequence, previousSequence + 1)
      const expiresAt = marketExpiry()
      validateAndSign(index, marketDir, privateKey, keyId, sequence, expiresAt, trustMap)
      writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`, { mode: 0o644 })
      run('git', ['-c', 'core.hooksPath=/dev/null', '-C', marketDir, 'config', 'user.name', 'github-actions[bot]'])
      run('git', ['-c', 'core.hooksPath=/dev/null', '-C', marketDir, 'config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com'])
      run('git', ['-c', 'core.hooksPath=/dev/null', '-C', marketDir, 'add', `plugins/${filename}`, 'index.json'])
      if (!commitIfChanged(marketDir, `${manifest.id}: publish v${manifest.version}`)) {
        console.log('Market already contains this exact release.')
        return
      }
      try {
        run('git', ['-c', 'core.hooksPath=/dev/null', '-C', marketDir, 'push', 'origin', 'HEAD:main'])
        console.log(`Published ${filename} with market sequence ${sequence}.`)
        return
      } catch (error) {
        if (attempt === 5) throw error
        console.warn(`Concurrent market update detected; retrying from fresh main (${attempt}/5).`)
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try { main() } catch (error) {
    console.error(`[publish-market] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
