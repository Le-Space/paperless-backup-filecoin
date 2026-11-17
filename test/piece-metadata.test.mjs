// Reading piece metadata from Warm Storage's storage slots (piece-metadata.mjs).
// No chain: the slot words are built here.
//
//   node --test test/

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { keccak256, toHex } from 'viem'
import { decodeStringSlot, pieceMetadataSlot, readPieceMetadata } from '../piece-metadata.mjs'

/** A short Solidity string as its storage word. */
const shortWord = (s) => {
  const b = Buffer.alloc(32)
  Buffer.from(s).copy(b)
  b[31] = Buffer.from(s).length * 2
  return toHex(b)
}

describe('piece metadata slots', () => {
  it('decodes short strings and an unset slot', async () => {
    assert.equal(await decodeStringSlot(shortWord('snap/1'), '0x0'), 'snap/1')
    assert.equal(await decodeStringSlot(toHex(0n, { size: 32 }), '0x0'), '')
  })
  it('decodes a long string from the words after keccak(slot)', async () => {
    const s = 'x'.repeat(40)
    const slot = toHex(5n, { size: 32 })
    const word = toHex(BigInt(s.length * 2 + 1), { size: 32 })
    const got = await decodeStringSlot(word, slot, async (at, n) => {
      assert.equal(at, keccak256(slot))
      assert.equal(n, 2)
      const b = Buffer.alloc(64)
      Buffer.from(s).copy(b)
      return [toHex(b.subarray(0, 32)), toHex(b.subarray(32))]
    })
    assert.equal(got, s)
  })
  it('gives each data set, piece and key its own slot', () => {
    const a = pieceMetadataSlot(1n, 2n, 'gen')
    assert.notEqual(a, pieceMetadataSlot(1n, 3n, 'gen'))
    assert.notEqual(a, pieceMetadataSlot(2n, 2n, 'gen'))
    assert.notEqual(a, pieceMetadataSlot(1n, 2n, 'seq'))
    assert.equal(a, pieceMetadataSlot('1', '2', 'gen'))
  })
  it('reads the keys of several pieces with plain calls, leaving out unset ones', async () => {
    const store = new Map([
      [pieceMetadataSlot(7n, 1n, 'pa'), shortWord('snap/1')],
      [pieceMetadataSlot(7n, 1n, 'gen'), shortWord('0123456789abcdef')],
      [pieceMetadataSlot(7n, 1n, 'seq'), shortWord('0')],
    ])
    const client = { readContract: async ({ functionName, args }) => (functionName === 'extsload' ? store.get(args[0]) ?? toHex(0n, { size: 32 }) : []) }
    const m = await readPieceMetadata(client, '0x0000000000000000000000000000000000000001', 7n, [1n, 2n], ['pa', 'gen', 'seq'])
    assert.deepEqual(m.get('1'), { pa: 'snap/1', gen: '0123456789abcdef', seq: '0' })
    assert.deepEqual(m.get('2'), {})
  })
})
