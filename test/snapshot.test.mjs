// Snapshots (snapshot.mjs): packs, keyed ids, generations, restore. No chain;
// every file, name and key here is made up.
//
//   node --test test/

import { strict as assert } from 'node:assert'
import { describe, it, before, after } from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Decrypter, Encrypter, generateX25519Identity, identityToRecipient } from 'age-encryption'
import {
  ByteReader,
  EXTRA_PREFIX,
  PREFIX_BYTES,
  blobId,
  classifyPrefix,
  decodeHeader,
  dedupKeyFrom,
  emptyState,
  encodeHeader,
  incrementalConfig,
  keyCheck,
  missingPieces,
  nextState,
  packPrefix,
  packStream,
  parsePieceMetadata,
  pieceMetadata,
  planSnapshot,
  readHeader,
  rebaseReason,
  restoreSnapshot,
  safePath,
  scanFiles,
  stateFromRestore,
} from '../snapshot.mjs'

const KEY = dedupKeyFrom('11'.repeat(32))
const NOW = Date.UTC(2026, 10, 17, 12)
const DAY = 24 * 3600 * 1000
const sha = (b) => createHash('sha256').update(b).digest('hex')
const opts = { key: KEY, now: NOW, rebaseDays: 30, rebaseRatio: 0.3 }

let root
before(() => {
  root = mkdtempSync(join(tmpdir(), 'snap-test-'))
})
after(() => rmSync(root, { recursive: true, force: true }))

/** A made-up export folder. */
function exportDir(name, files) {
  const dir = join(root, name)
  for (const [p, content] of Object.entries(files)) {
    mkdirSync(join(dir, ...p.split('/').slice(0, -1)), { recursive: true })
    writeFileSync(join(dir, ...p.split('/')), content)
  }
  return dir
}

/** Every file under dir as { path: content }. */
function readTree(dir, rel = '') {
  const out = {}
  for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) Object.assign(out, readTree(dir, r))
    else out[r] = readFileSync(join(dir, r)).toString('latin1')
  }
  return out
}

async function collect(iter) {
  const chunks = []
  for await (const c of iter) chunks.push(Buffer.from(c))
  return Buffer.concat(chunks)
}

async function* chunked(buf, size = 7777) {
  for (let i = 0; i < buf.length; i += size) yield buf.subarray(i, i + size)
}

const bigPdf = Buffer.alloc(300_000, 7)
const initial = {
  'manifest.json': '[{"model":"documents.tag","pk":1}]',
  'metadata.json': '{"version":"3.2.1"}',
  'originals/0000001.pdf': bigPdf,
  'archive/0000001-archive.pdf': 'archived pdf one',
  'thumbnails/0000001-thumbnail.webp': 'thumb one',
  'json/0000001-manifest.json': '{"title":"made up one"}',
  'originals/0000002.pdf': 'same bytes as another',
  'originals/0000003.pdf': 'same bytes as another',
}

describe('config and keys', () => {
  it('is off by default and checks its values', () => {
    assert.equal(incrementalConfig(undefined).enabled, false)
    assert.equal(incrementalConfig(true).enabled, true)
    assert.throws(() => incrementalConfig({ rebaseDays: 0 }), /rebaseDays/)
    assert.throws(() => incrementalConfig({ enabled: 'yes' }), /enabled/)
  })
  it('keys ids: not the plain hash, and another key gives other ids', () => {
    const h = sha('a made-up document')
    const id = blobId(KEY, h)
    assert.match(id, /^[0-9a-f]{32}$/)
    assert.notEqual(id, h.slice(0, 32))
    assert.notEqual(id, blobId(dedupKeyFrom('22'.repeat(32)), h))
    assert.equal(id, blobId(dedupKeyFrom('11'.repeat(32)), h))
  })
  it('derives the dedup key from hex or from an identity string, never as is', () => {
    assert.notDeepEqual(dedupKeyFrom('11'.repeat(32)), Buffer.from('11'.repeat(32), 'hex'))
    assert.equal(dedupKeyFrom('AGE-SECRET-KEY-1MADEUP').length, 32)
    assert.throws(() => dedupKeyFrom(''), /secret/)
  })
  it('refuses odd paths', () => {
    for (const p of ['../x', '/etc/x', 'a/../b', 'a//b', '', 'a\\b', 'a/./b']) assert.equal(safePath(p), false, p)
    assert.equal(safePath('originals/2026/a made-up name.pdf'), true)
  })
})

describe('piece metadata', () => {
  it('round-trips, also for parts, and fits the contract limits', () => {
    const m = pieceMetadata({ gen: '0123456789abcdef', seq: 12 })
    assert.deepEqual(m, { pa: 'snap/1', gen: '0123456789abcdef', seq: '12' })
    assert.ok(Object.keys(m).length <= 3)
    for (const [k, v] of Object.entries(m)) assert.ok(k.length <= 32 && v.length <= 96)
    assert.deepEqual(parsePieceMetadata(m), { gen: '0123456789abcdef', seq: 12, part: 0, parts: 1 })
    assert.deepEqual(parsePieceMetadata(pieceMetadata({ gen: '0123456789abcdef', seq: 0, part: 1, parts: 2 })), { gen: '0123456789abcdef', seq: 0, part: 1, parts: 2 })
  })
  it('is null for pieces of the old kind and for anything malformed', () => {
    for (const m of [undefined, {}, { ipfsRootCID: 'x' }, { pa: 'snap/1', gen: 'xyz', seq: '1' }, { pa: 'snap/1', gen: '0123456789abcdef', seq: '01' }, { pa: 'snap/1 3/2', gen: '0123456789abcdef', seq: '1' }]) {
      assert.equal(parsePieceMetadata(m), null, JSON.stringify(m))
    }
  })
})

describe('the public prefix', () => {
  it('names generation and number in 64 bytes, and reads back', () => {
    const p = packPrefix({ gen: '0123456789abcdef', seq: 7 })
    assert.equal(p.length, PREFIX_BYTES)
    assert.match(p.toString(), /^PA-SNAP\/1 0123456789abcdef 7 +\n$/)
    assert.deepEqual(classifyPrefix(p), { gen: '0123456789abcdef', seq: 7 })
  })
  it('tells a full backup (age header) from a pack, and refuses anything else', () => {
    assert.equal(classifyPrefix(Buffer.from('age-encryption.org/v1\n-> X25519 made-up')), 'full')
    assert.equal(classifyPrefix(Buffer.alloc(64)), null)
    assert.equal(classifyPrefix(packPrefix({ gen: '0123456789abcdef', seq: 1 }).subarray(0, 40)), null)
    const odd = Buffer.from(packPrefix({ gen: '0123456789abcdef', seq: 1 }))
    odd.write('01', 26)
    assert.equal(classifyPrefix(odd), null, 'a number with a leading zero')
    assert.throws(() => packPrefix({ gen: 'xyz', seq: 1 }), /generation/)
  })
})

describe('a generation: baseline, delta, restore', () => {
  it('packs the baseline, dedups equal files, pads, and restores it exactly', async () => {
    const dir = exportDir('gen1', initial)
    const files = await scanFiles(dir)
    const rebase = rebaseReason(emptyState(), opts)
    assert.equal(rebase, 'no generation yet')
    const plan = planSnapshot(files, emptyState(), { key: KEY, rebase, now: NOW, gen: 'aaaaaaaaaaaaaaaa' })
    assert.equal(plan.seq, 0)
    assert.equal(plan.files.length, 8)
    assert.equal(plan.blobs.length, 7, 'two equal files are one blob')
    const pack = await collect(packStream(plan, { pad: 4096 }))
    assert.equal(pack.length % 4096, 0)
    const out = join(root, 'restore1')
    const r = await restoreSnapshot(plan.header, async () => chunked(pack), out)
    assert.equal(r.files, 8)
    assert.deepEqual(readTree(out), readTree(dir))
  })

  it('a delta holds only new content; every snapshot restores to its own state', async () => {
    const dir = exportDir('gen2', initial)
    const st0 = emptyState()
    const p0 = planSnapshot(await scanFiles(dir), st0, { key: KEY, rebase: 'no generation yet', now: NOW, gen: 'bbbbbbbbbbbbbbbb' })
    const pack0 = await collect(packStream(p0, { pad: 1024 }))
    const before = readTree(dir)
    let state = nextState(st0, p0, { key: KEY, piece: { date: new Date(NOW).toISOString(), pieceCids: ['p0'], sizes: [pack0.length], copies: [{ providerId: 1, dataSetId: 9, retrievalUrls: ['https://sp.example/piece/p0'] }] } })
    assert.equal(state.seq, 0)
    assert.equal(state.keyCheck, keyCheck(KEY))

    // A new document, a changed manifest, a deleted one, a renamed (same bytes).
    writeFileSync(join(dir, 'originals', '0000004.pdf'), 'a new made-up document')
    writeFileSync(join(dir, 'manifest.json'), '[{"model":"documents.tag","pk":1},{"model":"documents.tag","pk":2}]')
    rmSync(join(dir, 'thumbnails', '0000001-thumbnail.webp'))
    writeFileSync(join(dir, 'archive', 'renamed-archive.pdf'), 'archived pdf one')
    rmSync(join(dir, 'archive', '0000001-archive.pdf'))
    const files1 = await scanFiles(dir, null, state.files)
    assert.equal(rebaseReason(state, { ...opts, now: NOW + DAY }), null)
    const p1 = planSnapshot(files1, state, { key: KEY, rebase: null, now: NOW + DAY })
    assert.equal(p1.seq, 1)
    assert.equal(p1.gen, 'bbbbbbbbbbbbbbbb')
    assert.deepEqual(p1.blobs.map((b) => b.path).sort(), ['manifest.json', 'originals/0000004.pdf'])
    const pack1 = await collect(packStream(p1, { pad: 1024 }))
    assert.ok(pack1.length < pack0.length / 10)

    const packs = [pack0, pack1]
    const out1 = join(root, 'restore-delta')
    await restoreSnapshot(p1.header, async (seq) => chunked(packs[seq]), out1)
    assert.deepEqual(readTree(out1), readTree(dir))
    const out0 = join(root, 'restore-base')
    await restoreSnapshot(p0.header, async (seq) => chunked(packs[seq]), out0)
    assert.deepEqual(readTree(out0), before)

    state = nextState(state, p1, { key: KEY, piece: { date: new Date(NOW + DAY).toISOString(), pieceCids: ['p1'], sizes: [pack1.length], copies: [{ providerId: 1, dataSetId: 9, retrievalUrls: ['https://sp.example/piece/p1'] }] } })
    assert.equal(state.seq, 1)
    assert.equal(state.pieces.length, 2)
    assert.ok(state.deltaBytes > 0)
  })

  it('goes through age to a recipient like the real backup', async () => {
    const dir = exportDir('gen-age', { 'manifest.json': '[]', 'originals/x.pdf': Buffer.alloc(200_000, 3) })
    const plan = planSnapshot(await scanFiles(dir), emptyState(), { key: KEY, rebase: 'no generation yet', now: NOW })
    const identity = await generateX25519Identity()
    const e = new Encrypter()
    e.addRecipient(await identityToRecipient(identity))
    const plain = await collect(packStream(plan, { pad: 65536 }))
    const sealed = await e.encrypt(plain)
    const d = new Decrypter()
    d.addIdentity(identity)
    const out = join(root, 'restore-age')
    await restoreSnapshot(plan.header, async () => chunked(Buffer.from(await d.decrypt(sealed))), out)
    assert.deepEqual(readTree(out), readTree(dir))
  })

  it('reuses cached hashes for files whose size and mtime did not change', async () => {
    const dir = exportDir('cache', { 'manifest.json': '[]', 'a.pdf': 'made up' })
    const first = await scanFiles(dir)
    const cache = Object.fromEntries(first.map((f) => [f.path, [f.size, f.mtimeMs, 'f'.repeat(64)]]))
    const again = await scanFiles(dir, null, cache)
    assert.ok(again.every((f) => f.sha256 === 'f'.repeat(64)))
    utimesSync(join(dir, 'a.pdf'), new Date(NOW), new Date(NOW))
    assert.equal((await scanFiles(dir, null, cache)).find((f) => f.path === 'a.pdf').sha256, sha('made up'))
  })

  it('takes the extra folder (vault mark) under its own prefix', async () => {
    const dir = exportDir('with-extra', { 'manifest.json': '[]' })
    const extra = exportDir('extra', { 'vault-mark.json': '{"v":1}' })
    const files = await scanFiles(dir, extra)
    assert.deepEqual(files.map((f) => f.path), [`${EXTRA_PREFIX}/vault-mark.json`, 'manifest.json'])
  })
})

describe('refusals', () => {
  it('fails a pack whose bytes do not match the index', async () => {
    const dir = exportDir('tamper', { 'manifest.json': '[]', 'a.pdf': 'made-up content' })
    const plan = planSnapshot(await scanFiles(dir), emptyState(), { key: KEY, rebase: 'x', now: NOW })
    const pack = await collect(packStream(plan, { pad: 512 }))
    const bad = Buffer.from(pack)
    const at = bad.indexOf('made-up content')
    bad[at] ^= 1
    await assert.rejects(restoreSnapshot(plan.header, async () => chunked(bad), join(root, 'tamper-out')), /SHA-256/)
  })
  it('fails a pack with bytes after the padding should be zeros', async () => {
    const dir = exportDir('trail', { 'manifest.json': '[]' })
    const plan = planSnapshot(await scanFiles(dir), emptyState(), { key: KEY, rebase: 'x', now: NOW })
    const pack = await collect(packStream(plan, { pad: 512 }))
    pack[pack.length - 1] = 1
    await assert.rejects(restoreSnapshot(plan.header, async () => chunked(pack), join(root, 'trail-out')), /after its blobs/)
  })
  it('refuses an index with a path that leaves the folder', () => {
    const h = { v: 1, format: 'snap/1', gen: '0123456789abcdef', seq: 0, files: [['../evil', 'a'.repeat(32), 1, 'b'.repeat(64)]], blobs: [] }
    assert.throws(() => decodeHeader(encodeHeader(h)), /bad entry/)
  })
  it('refuses a pack of another generation or out of order', async () => {
    const dir = exportDir('order', { 'manifest.json': '[]' })
    const plan = planSnapshot(await scanFiles(dir), emptyState(), { key: KEY, rebase: 'x', now: NOW, gen: 'cccccccccccccccc' })
    const pack = await collect(packStream(plan, { pad: 512 }))
    const other = { ...plan.header, gen: 'dddddddddddddddd' }
    await assert.rejects(restoreSnapshot(other, async () => chunked(pack), join(root, 'order-out')), /another generation/)
  })
  it('refuses to restore into a folder that is not empty', async () => {
    const dir = exportDir('busy', { 'manifest.json': '[]' })
    const plan = planSnapshot(await scanFiles(dir), emptyState(), { key: KEY, rebase: 'x', now: NOW })
    const pack = await collect(packStream(plan, { pad: 512 }))
    const out = exportDir('busy-out', { 'left.txt': 'x' })
    await assert.rejects(restoreSnapshot(plan.header, async () => chunked(pack), out), /not empty/)
  })
  it('reads the header back from a stream', async () => {
    const dir = exportDir('head', { 'manifest.json': '[]' })
    const plan = planSnapshot(await scanFiles(dir), emptyState(), { key: KEY, rebase: 'x', now: NOW })
    const pack = await collect(packStream(plan))
    const h = await readHeader(new ByteReader(chunked(pack, 3)))
    assert.equal(h.gen, plan.gen)
    assert.deepEqual(h.files, plan.header.files)
  })
})

describe('when to start a new generation', () => {
  const base = (over = {}) => ({ ...emptyState(), gen: '0123456789abcdef', seq: 3, keyCheck: keyCheck(KEY), started: new Date(NOW - 5 * DAY).toISOString(), baseBytes: 1000, deltaBytes: 100, pieces: [{ seq: 0 }, { seq: 1 }, { seq: 2 }, { seq: 3 }], ...over })
  it('continues a young, small generation', () => assert.equal(rebaseReason(base(), opts), null))
  it('rebases when asked, when old, when deltas grew, on another key, without a baseline', () => {
    assert.equal(rebaseReason(base(), { ...opts, force: true }), 'requested')
    assert.match(rebaseReason(base({ started: new Date(NOW - 31 * DAY).toISOString() }), opts), /30 days/)
    assert.match(rebaseReason(base({ deltaBytes: 400 }), opts), /30 %/)
    assert.equal(rebaseReason(base({ keyCheck: 'other' }), opts), 'another dedup key')
    assert.match(rebaseReason(base({ pieces: [{ seq: 2 }] }), opts), /no baseline/)
  })
})

describe('copies that lack packs', () => {
  it('names, per provider, the packs it lacks and where to get them', () => {
    const state = {
      ...emptyState(),
      pieces: [
        { seq: 0, pieceCids: ['b1', 'b2'], sizes: [10, 5], copies: [{ providerId: 1, retrievalUrls: ['u/b1', 'u/b2'] }, { providerId: 2, retrievalUrls: ['v/b1', 'v/b2'] }] },
        { seq: 1, pieceCids: ['d1'], sizes: [3], copies: [{ providerId: 1, retrievalUrls: ['u/d1'] }] },
      ],
    }
    const lack = missingPieces(state, [{ providerId: 1 }, { providerId: 2 }, { providerId: 3 }])
    assert.deepEqual(lack.get('1'), [])
    assert.deepEqual(lack.get('2').map((p) => [p.seq, p.urls]), [[1, ['u/d1']]])
    assert.deepEqual(lack.get('3').map((p) => p.seq), [0, 1])
  })
  it('a restored machine continues the generation it came from', () => {
    const target = { gen: '0123456789abcdef', seq: 2, files: [] }
    const st = stateFromRestore(target, { key: KEY, pieces: [{ seq: 0 }, { seq: 1 }, { seq: 2 }, { seq: 3 }], blobs: { a: 0 }, written: {}, baseBytes: 10, started: new Date(NOW).toISOString() })
    assert.equal(st.seq, 3, 'next pack after the newest one on chain')
    assert.equal(rebaseReason(st, { ...opts, now: NOW + DAY }), null)
  })
})
