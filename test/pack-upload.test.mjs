// Uploading a pack (pack-upload.mjs) to fake contexts: metadata on every
// piece, copies that lack earlier packs pull them first. No chain; CIDs and
// URLs are made up (real piece CIDs, from made-up bytes).
//
//   node --test test/

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { calculate } from '@filoz/synapse-core/piece'
import { uploadPack } from '../pack-upload.mjs'

const cid = async (s) => calculate(new TextEncoder().encode(s.padEnd(200, '.')))

function fakeContext(id, { failPull = false, failCommit = false } = {}) {
  let nextId = 100n
  const ctx = {
    provider: { id },
    stored: [],
    pulled: [],
    committed: null,
    async store(stream) {
      const parts = []
      for await (const c of stream) parts.push(Buffer.from(c))
      const bytes = Buffer.concat(parts)
      const pieceCid = await calculate(new Uint8Array(bytes))
      this.stored.push(pieceCid)
      return { pieceCid, size: bytes.length }
    },
    async presignForCommit(pieces) {
      return `0xsig${id}-${pieces.length}`
    },
    async pull({ pieces, from, extraData }) {
      this.pulled.push({ pieces: pieces.map(String), urls: pieces.map((p) => from(p)), extraData })
      return failPull ? { status: 'failed', pieces: pieces.map((p) => ({ pieceCid: p, status: 'failed' })) } : { status: 'complete', pieces: pieces.map((p) => ({ pieceCid: p, status: 'complete' })) }
    },
    async commit({ pieces, extraData }) {
      if (failCommit) throw new Error('made-up commit failure')
      this.committed = { pieces, extraData }
      return { dataSetId: BigInt(id * 10), pieceIds: pieces.map(() => nextId++), isNewDataSet: false }
    },
    getPieceUrl: (c) => `https://sp${id}.example/piece/${c}`,
  }
  return ctx
}

const stream = (s) => (async function* () {
  yield new TextEncoder().encode(s)
})()

describe('uploading one pack', () => {
  it('stores on the primary, the others pull, every piece carries its metadata', async () => {
    const contexts = [fakeContext(1), fakeContext(2), fakeContext(3)]
    const body = 'a made-up sealed pack'.padEnd(300, '#')
    const res = await uploadPack(contexts, [{ index: 0, offset: 0, size: body.length }], () => stream(body), {
      metadataFor: () => ({ pa: 'snap/1', gen: '0123456789abcdef', seq: '4' }),
      missingFor: () => [],
    })
    assert.equal(res.copies.length, 3)
    assert.equal(res.complete, true)
    assert.equal(contexts[0].pulled.length, 0, 'the primary pulls nothing')
    assert.deepEqual(contexts[1].pulled[0].urls, [`https://sp1.example/piece/${res.pieceCids[0]}`])
    for (const c of contexts) assert.deepEqual(c.committed.pieces[0].pieceMetadata, { pa: 'snap/1', gen: '0123456789abcdef', seq: '4' })
    assert.deepEqual(res.copies[0].pieceIds, [100n])
  })

  it('a copy that lacks earlier packs pulls them and adds them in the same AddPieces', async () => {
    const old = String(await cid('an earlier made-up pack'))
    const contexts = [fakeContext(1), fakeContext(2)]
    const body = 'the new made-up pack'.padEnd(300, '#')
    const res = await uploadPack(contexts, [{ index: 0, offset: 0, size: body.length }], () => stream(body), {
      metadataFor: () => ({ pa: 'snap/1', gen: '0123456789abcdef', seq: '1' }),
      missingFor: (id) => (id === '2' ? [{ seq: 0, pieceCids: [old], urls: ['https://sp1.example/piece/old'], metadata: [{ pa: 'snap/1', gen: '0123456789abcdef', seq: '0' }] }] : []),
    })
    const repaired = contexts[1]
    assert.deepEqual(repaired.pulled[0].pieces, [old, String(res.pieceCid)])
    assert.deepEqual(repaired.pulled[0].urls, ['https://sp1.example/piece/old', `https://sp1.example/piece/${res.pieceCid}`])
    assert.deepEqual(repaired.committed.pieces.map((p) => p.pieceMetadata.seq), ['0', '1'])
    const copy = res.copies.find((c) => c.providerId === 2)
    assert.deepEqual(copy.pieceIds, [101n], 'its own piece ids name the new pack only')
    assert.equal(copy.repairedPacks, 1)
  })

  it('the primary pulls what it lacks too, with the signature it commits with', async () => {
    const old = String(await cid('another earlier made-up pack'))
    const contexts = [fakeContext(1)]
    const body = 'x'.repeat(300)
    await uploadPack(contexts, [{ index: 0, offset: 0, size: body.length }], () => stream(body), {
      metadataFor: () => ({ pa: 'snap/1', gen: '0123456789abcdef', seq: '2' }),
      missingFor: () => [{ seq: 1, pieceCids: [old], urls: ['https://sp9.example/piece/old'], metadata: [{ seq: '1' }] }],
    })
    assert.deepEqual(contexts[0].pulled[0].pieces, [old])
    assert.equal(contexts[0].committed.extraData, contexts[0].pulled[0].extraData)
  })

  it('leaves out a copy whose missing packs no copy serves, and one whose pull failed', async () => {
    const contexts = [fakeContext(1), fakeContext(2), fakeContext(3, { failPull: true })]
    const body = 'y'.repeat(300)
    const res = await uploadPack(contexts, [{ index: 0, offset: 0, size: body.length }], () => stream(body), {
      metadataFor: () => ({ pa: 'snap/1', gen: '0123456789abcdef', seq: '3' }),
      missingFor: (id) => (id === '2' ? [{ seq: 0, pieceCids: ['x'], urls: null, metadata: [{}] }] : []),
    })
    assert.deepEqual(res.copies.map((c) => c.providerId), [1])
    assert.equal(res.complete, false)
    assert.equal(res.failedAttempts.length, 2)
  })

  it('fails when no copy commits', async () => {
    const contexts = [fakeContext(1, { failCommit: true })]
    await assert.rejects(
      uploadPack(contexts, [{ index: 0, offset: 0, size: 300 }], () => stream('z'.repeat(300)), { metadataFor: () => ({}), missingFor: () => [] }),
      /Failed to commit the pack/,
    )
  })
})
