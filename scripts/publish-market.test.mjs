import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  assertVersionReplacement,
  commitIfChanged,
  compareStableVersions,
  metadataPayload,
  packagePayload,
  snapshotPayload,
  verifyExistingIndex,
} from './publish-market.mjs'

const releaseWorkflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')

function signedMarketFixture(manifestOverrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'trusted-publisher-test-'))
  const stage = join(root, 'stage')
  const plugins = join(root, 'plugins')
  mkdirSync(stage)
  mkdirSync(plugins)
  const manifest = { id: 'demo', name: 'Demo', version: '1.2.3', entry: 'entry.js', ...manifestOverrides }
  writeFileSync(join(stage, 'manifest.json'), JSON.stringify(manifest))
  writeFileSync(join(stage, 'entry.js'), 'export function setup() {}\n')
  const archive = join(plugins, 'demo-1.2.3.sekplugin')
  execFileSync('zip', ['-X', '-q', archive, 'manifest.json', 'entry.js'], { cwd: stage })
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const entry = {
    id: manifest.id, name: manifest.name, version: manifest.version,
    description: manifest.description ?? '', author: manifest.author ?? '', icon: manifest.icon ?? '',
    minHostVersion: manifest.minHostVersion ?? '',
    download: 'https://example.test/plugins/demo-1.2.3.sekplugin',
    sha256: createHash('sha256').update(readFileSync(archive)).digest('hex'),
    homepage: 'https://example.test/demo', publisher: 'sekaitext-official', keyId: 'test-key',
    signatureAlgorithm: 'ed25519',
  }
  entry.packageSignature = sign(null, packagePayload(entry), privateKey).toString('base64')
  const trustMap = { 'test-key': publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64') }
  return { root, entry, trustMap, privateKey }
}

test('stable version comparison is numeric', () => {
  assert.equal(compareStableVersions('10.0.0', '2.99.99'), 1)
  assert.equal(compareStableVersions('1.2.3', '1.2.3'), 0)
  assert.equal(compareStableVersions('1.2.2', '1.2.3'), -1)
})

test('publication rejects downgrade and equal-version byte replacement', () => {
  const existing = { id: 'demo', version: '2.0.0', sha256: 'a'.repeat(64) }
  assert.throws(
    () => assertVersionReplacement(existing, { id: 'demo', version: '1.9.9', sha256: 'b'.repeat(64) }),
    /refusing to replace newer/,
  )
  assert.throws(
    () => assertVersionReplacement(existing, { id: 'demo', version: '2.0.0', sha256: 'b'.repeat(64) }),
    /immutable/,
  )
  assert.doesNotThrow(
    () => assertVersionReplacement(existing, { id: 'demo', version: '2.0.0', sha256: existing.sha256 }),
  )
})

test('publisher refuses to bless a market entry whose prior signature is invalid', () => {
  const { root, entry, trustMap } = signedMarketFixture()
  assert.doesNotThrow(() => verifyExistingIndex({ version: 2, plugins: [entry] }, root, trustMap))
  entry.packageSignature = Buffer.alloc(64).toString('base64')
  assert.throws(
    () => verifyExistingIndex({ version: 2, plugins: [entry] }, root, trustMap),
    /existing packageSignature verification failed/,
  )
})

test('publisher enforces display limits in UTF-8 bytes', () => {
  const valid = signedMarketFixture({ name: `${'界'.repeat(66)}aa` })
  assert.doesNotThrow(() => verifyExistingIndex({ version: 2, plugins: [valid.entry] }, valid.root, valid.trustMap))

  const invalid = signedMarketFixture({ name: '界'.repeat(67) })
  assert.throws(
    () => verifyExistingIndex({ version: 2, plugins: [invalid.entry] }, invalid.root, invalid.trustMap),
    /name is invalid/,
  )
})

test('v3 snapshot rejects removal at an unchanged sequence', () => {
  const { root, entry, trustMap, privateKey } = signedMarketFixture()
  const otherStage = join(root, 'other-stage')
  mkdirSync(otherStage)
  writeFileSync(join(otherStage, 'manifest.json'), JSON.stringify({ id: 'other', name: 'Other', version: '2.0.0', entry: 'entry.js' }))
  writeFileSync(join(otherStage, 'entry.js'), 'export function setup() {}\n')
  const otherArchive = join(root, 'plugins', 'other-2.0.0.sekplugin')
  execFileSync('zip', ['-X', '-q', otherArchive, 'manifest.json', 'entry.js'], { cwd: otherStage })
  const other = {
    id: 'other', name: 'Other', version: '2.0.0', description: '', author: '', icon: '', minHostVersion: '',
    download: 'https://example.test/plugins/other-2.0.0.sekplugin',
    sha256: createHash('sha256').update(readFileSync(otherArchive)).digest('hex'),
    homepage: 'https://example.test/other', publisher: 'sekaitext-official', keyId: 'test-key',
    signatureAlgorithm: 'ed25519', sequence: 10, expiresAt: '2030-01-01T00:00:00Z',
  }
  other.packageSignature = sign(null, packagePayload(other), privateKey).toString('base64')
  other.metadataSignature = sign(null, metadataPayload(other), privateKey).toString('base64')
  Object.assign(entry, {
    sequence: 10,
    expiresAt: '2030-01-01T00:00:00Z',
  })
  entry.metadataSignature = sign(null, metadataPayload(entry), privateKey).toString('base64')
  const index = {
    version: 3,
    plugins: [entry, other],
    publisher: 'sekaitext-official',
    keyId: 'test-key',
    signatureAlgorithm: 'ed25519',
    sequence: 10,
    expiresAt: entry.expiresAt,
  }
  index.snapshotSignature = sign(null, snapshotPayload(index), privateKey).toString('base64')
  assert.doesNotThrow(() => verifyExistingIndex(index, root, trustMap))

  const changedMembership = structuredClone(index)
  changedMembership.plugins.pop()
  assert.throws(
    () => verifyExistingIndex(changedMembership, root, trustMap),
    /snapshotSignature verification failed/,
  )
})

test('only a clean index is a commit no-op; commit failures propagate', () => {
  const root = mkdtempSync(join(tmpdir(), 'market-commit-test-'))
  execFileSync('git', ['init', '-q'], { cwd: root })
  let called = false
  assert.equal(commitIfChanged(root, 'unused', () => { called = true }), false)
  assert.equal(called, false)

  writeFileSync(join(root, 'index.json'), '{}\n')
  execFileSync('git', ['add', 'index.json'], { cwd: root })
  assert.throws(
    () => commitIfChanged(root, 'publish', () => { throw new Error('commit hook rejected') }),
    /commit hook rejected/,
  )
})

test('same-tag release reruns cannot overwrite published plugin bytes', () => {
  const publisher = releaseWorkflow.indexOf('uses: softprops/action-gh-release@')
  assert.ok(publisher >= 0)
  assert.match(releaseWorkflow.slice(publisher, publisher + 500), /overwrite_files:\s*false/)
})
