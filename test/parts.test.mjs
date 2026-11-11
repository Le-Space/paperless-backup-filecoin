// Backups in parts (parts.mjs): cutting, hashing, uploading to fake storage
// contexts, and putting a backup back together. No chain, no provider; the
// data is made up.
//
//   node --test test/

import { strict as assert } from 'node:assert'
import { createHash, randomBytes } from 'node:crypto'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { describe, it } from 'node:test'
import { Decrypter, Encrypter, generateX25519Identity, identityToRecipient } from 'age-encryption'
import { PART_BYTES, copyPieceIds, copyUrls, entryParts, isMultipart, missingParts, partHasher, partRanges, pieceFields, reassemble, uploadParts } from '../parts.mjs'

const sha = (b) => createHash('sha256').update(b).digest('hex')

async function hashParts(bytes, partBytes, chunk) {
  const h = partHasher(partBytes)
  const chunks = []
  for (let i = 0; i < bytes.length; i += chunk) chunks.push(bytes.subarray(i, i + chunk))
  await pipeline(Readable.from(chunks.length ? chunks : []), h.stream, async function* (src) {
    for await (const _ of src);
  })
  return h.digests()
}

describe('cutting a sealed file into parts', () => {
  it('stays one part at and under PART_BYTES (1,000,000,000 bytes)', () => {
    assert.equal(PART_BYTES, 1_000_000_000)
    assert.deepEqual(partRanges(0), [{ index: 0, offset: 0, size: 0 }])
    assert.deepEqual(partRanges(123), [{ index: 0, offset: 0, size: 123 }])
    assert.deepEqual(partRanges(PART_BYTES), [{ index: 0, offset: 0, size: PART_BYTES }])
  })

  it('splits one byte above, and at exact multiples, into full parts and a last one', () => {
    assert.deepEqual(partRanges(PART_BYTES + 1), [
      { index: 0, offset: 0, size: PART_BYTES },
      { index: 1, offset: PART_BYTES, size: 1 },
    ])
    assert.deepEqual(partRanges(2 * PART_BYTES).map((r) => r.size), [PART_BYTES, PART_BYTES])
    assert.deepEqual(partRanges(2 * PART_BYTES + 7).map((r) => [r.offset, r.size]), [[0, PART_BYTES], [PART_BYTES, PART_BYTES], [2 * PART_BYTES, 7]])
    // The case that failed: a sealed file just above 1 GiB.
    const ranges = partRanges(1_065_418_752)
    assert.equal(ranges.length, 2)
    assert.ok(ranges.every((r) => r.size <= PART_BYTES))
    assert.equal(ranges.reduce((n, r) => n + r.size, 0), 1_065_418_752)
  })

  it('refuses sizes that are not sizes', () => {
    assert.throws(() => partRanges(-1), RangeError)
    assert.throws(() => partRanges(1.5), RangeError)
    assert.throws(() => partRanges(10, 0), RangeError)
  })

  it('hashes each part on the way, whatever the chunks', async () => {
    const bytes = randomBytes(95)
    for (const size of [0, 1, 9, 10, 11, 30, 95]) {
      const data = bytes.subarray(0, size)
      const ranges = partRanges(size, 10)
      const want = ranges.map((r) => sha(data.subarray(r.offset, r.offset + r.size)))
      for (const chunk of [1, 3, 10, 64]) assert.deepEqual(await hashParts(data, 10, chunk), want, `size ${size}, chunks of ${chunk}`)
    }
  })
})

describe('the ledger entry', () => {
  const single = { name: 'paperless-2026-01-01', pieceCid: 'bafkzcibcaa', size: 12, sealedSha256: 'a'.repeat(64), copies: [{ providerId: 1, dataSetId: 3, pieceId: 4, retrievalUrl: 'https://sp1.example.com/piece/bafkzcibcaa' }] }

  it('of a backup under the limit keeps the old format: no parts, no pieceIds', () => {
    const fields = pieceFields({ sealedBytes: 12, ranges: partRanges(12), partSha256: ['a'.repeat(64)] }, { pieceCid: 'bafkzcibcaa', copies: [] })
    assert.deepEqual(fields, { pieceCid: 'bafkzcibcaa', size: 12 })
    assert.equal(isMultipart(single), false)
    assert.deepEqual(entryParts(single), [{ pieceCid: 'bafkzcibcaa', offset: 0, size: 12, sha256: 'a'.repeat(64) }])
    assert.deepEqual(copyPieceIds(single.copies[0]), [4])
    assert.deepEqual(copyUrls(single.copies[0]), [single.copies[0].retrievalUrl])
  })

  it('of a backup in parts lists them in order, the first one also as pieceCid', () => {
    const ranges = partRanges(25, 10)
    const fields = pieceFields({ sealedBytes: 25, ranges, partSha256: ['1', '2', '3'].map((c) => c.repeat(64)) }, { pieceCid: 'bafkp1', pieceCids: ['bafkp1', 'bafkp2', 'bafkp3'], copies: [] })
    assert.deepEqual(fields, {
      pieceCid: 'bafkp1',
      size: 25,
      parts: [
        { pieceCid: 'bafkp1', offset: 0, size: 10, sha256: '1'.repeat(64) },
        { pieceCid: 'bafkp2', offset: 10, size: 10, sha256: '2'.repeat(64) },
        { pieceCid: 'bafkp3', offset: 20, size: 5, sha256: '3'.repeat(64) },
      ],
    })
    const entry = { ...fields }
    assert.ok(isMultipart(entry))
    assert.deepEqual(missingParts(entry, new Set(['bafkp1', 'bafkp2', 'bafkp3'])), [])
    assert.deepEqual(missingParts(entry, new Set(['bafkp1', 'bafkp3'])).map((p) => p.pieceCid), ['bafkp2'], 'a copy without one part is not a copy')
  })
})

// A storage context as synapse's StorageContext behaves for store, pull,
// presignForCommit and commit; it records what it was asked.
function fakeContext(id, { storeFails = false, pullFails = false, commitFails = false, dataSetId = null } = {}) {
  const calls = { store: [], presign: [], pull: [], commit: [] }
  let nextPieceId = 10n
  return {
    calls,
    provider: { id: BigInt(id) },
    getPieceUrl: (cid) => `https://sp${id}.example.com/piece/${cid}`,
    async store(stream) {
      const chunks = []
      for await (const c of stream) chunks.push(c)
      const bytes = Buffer.concat(chunks)
      calls.store.push(bytes)
      if (storeFails) throw new Error('Size exceeds maximum allowed size')
      return { pieceCid: `bafk-${sha(bytes).slice(0, 12)}`, size: bytes.length }
    },
    async presignForCommit(pieces) {
      calls.presign.push(pieces.map((p) => String(p.pieceCid)))
      return `0xsigned${id}`
    },
    async pull({ pieces, from, extraData }) {
      calls.pull.push({ pieces: pieces.map(String), from: pieces.map(from), extraData })
      return { status: pullFails ? 'failed' : 'complete', pieces: pieces.map((pieceCid) => ({ pieceCid, status: pullFails ? 'failed' : 'complete' })) }
    },
    async commit({ pieces, extraData }) {
      calls.commit.push({ pieces: pieces.map((p) => String(p.pieceCid)), extraData })
      if (commitFails) throw new Error('commit reverted')
      const pieceIds = pieces.map(() => nextPieceId++)
      return { pieceIds, dataSetId: dataSetId ?? BigInt(100 + id), isNewDataSet: dataSetId == null }
    },
  }
}

describe('uploading the parts', () => {
  const file = randomBytes(25)
  const ranges = partRanges(file.length, 10)
  const open = ({ offset, size }) => Readable.from([file.subarray(offset, offset + size)])

  it('stores every part on the primary, the secondaries pull all, and each data set adds all in one AddPieces', async () => {
    const [a, b, c] = [fakeContext(1), fakeContext(2, { dataSetId: 7n }), fakeContext(3)]
    const result = await uploadParts([a, b, c], ranges, open)
    assert.deepEqual(a.calls.store.map((x) => x.length), [10, 10, 5])
    assert.deepEqual(Buffer.concat(a.calls.store), file)
    assert.equal(b.calls.store.length + c.calls.store.length, 0, 'secondaries pull, nothing is uploaded twice')
    assert.equal(result.pieceCids.length, 3)
    for (const ctx of [a, b, c]) {
      assert.equal(ctx.calls.commit.length, 1, 'one commit per data set')
      assert.deepEqual(ctx.calls.commit[0].pieces, result.pieceCids.map(String), 'all parts, in order')
    }
    assert.deepEqual(b.calls.presign, [result.pieceCids.map(String)])
    assert.equal(b.calls.commit[0].extraData, '0xsigned2', 'a secondary commits with what it presigned')
    assert.equal(a.calls.commit[0].extraData, undefined)
    assert.deepEqual(b.calls.pull[0].from, result.pieceCids.map((cid) => `https://sp1.example.com/piece/${cid}`))
    assert.equal(result.complete, true)
    assert.equal(result.size, 25)
    assert.deepEqual(result.copies.map((x) => [Number(x.providerId), x.role, x.pieceIds.length]), [[1, 'primary', 3], [2, 'secondary', 3], [3, 'secondary', 3]])
    assert.equal(result.copies[1].dataSetId, 7n)
    assert.equal(result.copies[0].pieceId, result.copies[0].pieceIds[0])
    assert.deepEqual(result.copies[2].retrievalUrls, result.pieceCids.map((cid) => `https://sp3.example.com/piece/${cid}`))
  })

  it('a secondary that cannot pull or commit costs that copy only', async () => {
    const result = await uploadParts([fakeContext(1), fakeContext(2, { pullFails: true }), fakeContext(3, { commitFails: true })], ranges, open)
    assert.equal(result.complete, false)
    assert.deepEqual(result.copies.map((x) => Number(x.providerId)), [1])
    assert.deepEqual(result.failedAttempts.map((f) => Number(f.providerId)), [2, 3])
    assert.match(result.failedAttempts[0].error, /pull failed for 3 of 3 parts/)
  })

  it('a primary that refuses a part fails the upload, naming the provider (the caller tries the next)', async () => {
    const b = fakeContext(2)
    await assert.rejects(uploadParts([fakeContext(1, { storeFails: true }), b], ranges, open), (err) => {
      assert.match(err.message, /part 1\/3 on primary provider 1/)
      assert.equal(err.providerId, 1n)
      return true
    })
    assert.equal(b.calls.pull.length, 0)
  })

  it('no commit at all is a failure', async () => {
    await assert.rejects(uploadParts([fakeContext(1, { commitFails: true })], ranges, open), /Failed to commit the parts on primary provider 1/)
  })
})

describe('putting a backup back together', () => {
  // A small backup sealed with age, cut into parts of 100 bytes.
  async function sealedBackup(plainBytes = 700, partBytes = 100) {
    const identity = await generateX25519Identity()
    const e = new Encrypter()
    e.addRecipient(await identityToRecipient(identity))
    const plain = randomBytes(plainBytes)
    const sealed = Buffer.from(await e.encrypt(plain))
    const ranges = partRanges(sealed.length, partBytes)
    const parts = ranges.map((r, i) => ({ pieceCid: `bafkpart${i}`, offset: r.offset, size: r.size, sha256: sha(sealed.subarray(r.offset, r.offset + r.size)) }))
    const entry = { pieceCid: parts[0].pieceCid, size: sealed.length, sealedSha256: sha(sealed), plainSha256: sha(plain), parts }
    const bytesOf = (p) => sealed.subarray(p.offset, p.offset + p.size)
    return { identity, plain, sealed, entry, bytesOf }
  }
  const collect = () => {
    const chunks = []
    return { chunks, write: (b) => void chunks.push(Buffer.from(b)) }
  }

  it('concatenates the parts in order, checks every hash, and the result decrypts', async () => {
    const { identity, plain, sealed, entry, bytesOf } = await sealedBackup()
    assert.ok(entry.parts.length > 3)
    const out = collect()
    const n = await reassemble(entry, async (p) => bytesOf(p), out)
    assert.equal(n, sealed.length)
    assert.deepEqual(Buffer.concat(out.chunks), sealed)
    const d = new Decrypter()
    d.addIdentity(identity)
    assert.deepEqual(Buffer.from(await d.decrypt(Buffer.concat(out.chunks))), plain)
  })

  it('a part no copy delivers fails clearly, naming it', async () => {
    const { entry, bytesOf } = await sealedBackup()
    await assert.rejects(reassemble(entry, async (p, i) => (i === 2 ? null : bytesOf(p)), collect()), new RegExp(`part 3/${entry.parts.length} \\(bafkpart2\\): no copy delivered it`))
  })

  it('a corrupt part fails on its own SHA-256, a short one on its size', async () => {
    const { entry, bytesOf } = await sealedBackup()
    const flipped = (p) => {
      const b = Buffer.from(bytesOf(p))
      b[5] ^= 1
      return b
    }
    await assert.rejects(reassemble(entry, async (p, i) => (i === 1 ? flipped(p) : bytesOf(p)), collect()), /part 2\/\d+ \(bafkpart1\): does not match its SHA-256/)
    await assert.rejects(reassemble(entry, async (p, i) => (i === 1 ? bytesOf(p).subarray(1) : bytesOf(p)), collect()), /part 2\/\d+ \(bafkpart1\): 99 bytes, the ledger says 100/)
  })

  it('parts in the wrong order fail the whole checksum when the parts carry none', async () => {
    const { entry, bytesOf } = await sealedBackup()
    const noPartHashes = { ...entry, parts: entry.parts.map(({ sha256, ...p }) => p) }
    const swapped = (p, i) => bytesOf(noPartHashes.parts[i === 0 ? 1 : i === 1 ? 0 : i])
    await assert.rejects(reassemble(noPartHashes, async (p, i) => swapped(p, i), collect()), /does not match the ledger checksum/)
  })

  it('a single-piece entry (the old format) is one part checked against sealedSha256', async () => {
    const { sealed } = await sealedBackup(50, 10_000)
    const entry = { pieceCid: 'bafkone', size: sealed.length, sealedSha256: sha(sealed) }
    const out = collect()
    await reassemble(entry, async () => sealed, out)
    assert.deepEqual(Buffer.concat(out.chunks), sealed)
    await assert.rejects(reassemble(entry, async () => Buffer.concat([sealed.subarray(0, -1), Buffer.from([sealed.at(-1) ^ 1])]), collect()), /SHA-256/)
  })
})
