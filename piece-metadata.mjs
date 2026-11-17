// A piece's metadata, read from the chain.
//
// Warm Storage keeps each piece's metadata (the keys and values the client
// signed with AddPieces) in its own storage, and its view contract has no
// getter for it (only for data sets). It does expose `extsload`, which its own
// view library uses to read storage, so this reads the slots the same way:
//
//   dataSetPieceMetadata  mapping(dataSetId => mapping(pieceId => mapping(string key => string value)))
//                         at slot 13 (FilecoinWarmStorageServiceLayout.sol)
//   value slot = keccak256(bytes(key) ++ keccak256(pieceId ++ keccak256(dataSetId ++ 13)))
//
// Solidity strings: below 32 bytes in the slot itself (length * 2 in the low
// byte), longer ones as length * 2 + 1 with the bytes at keccak256(slot).
// An unset key reads as "". The slot number is a constant of the deployed
// contract's layout; a layout change makes every value read as "" or
// garbage, which callers treat as "not a snapshot piece" — and `retain` then
// keeps the generation's pieces as backups of the old kind it cannot place
// (see retention.mjs: it removes nothing it cannot read).

import { encodeAbiParameters, encodePacked, hexToBytes, keccak256, parseAbi, toHex } from 'viem'

export const PIECE_METADATA_SLOT = 13n

const ABI = parseAbi(['function extsload(bytes32 slot) view returns (bytes32)', 'function extsloadStruct(bytes32 slot, uint256 size) view returns (bytes32[])'])

/** The storage slot of one piece's value for `key`. */
export function pieceMetadataSlot(dataSetId, pieceId, key) {
  const dataSetLevel = keccak256(encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [BigInt(dataSetId), PIECE_METADATA_SLOT]))
  const pieceLevel = keccak256(encodeAbiParameters([{ type: 'uint256' }, { type: 'bytes32' }], [BigInt(pieceId), dataSetLevel]))
  return keccak256(encodePacked(['string', 'bytes32'], [key, pieceLevel]))
}

/**
 * A Solidity string from its slot word (and, when long, the words it points to).
 * @param {`0x${string}`} word @param {(slot: `0x${string}`, words: number) => Promise<`0x${string}`[]>} [readLong]
 */
export async function decodeStringSlot(word, slot, readLong) {
  const w = BigInt(word)
  if ((w & 1n) === 0n) {
    const len = Number((w & 0xffn) >> 1n)
    if (len > 31) throw new Error('not a string slot')
    return Buffer.from(hexToBytes(toHex(w, { size: 32 }))).subarray(0, len).toString('utf8')
  }
  const len = Number(w >> 1n)
  if (len > 4096) throw new Error('metadata value too long')
  if (!readLong) throw new Error('a long metadata value needs extsloadStruct')
  const words = await readLong(keccak256(slot), Math.ceil(len / 32))
  return Buffer.concat(words.map((x) => Buffer.from(hexToBytes(x)))).subarray(0, len).toString('utf8')
}

/**
 * The values of `keys` for each piece, read with plain calls (no key needed).
 * @param {any} client a viem public client of the chain
 * @param {`0x${string}`} fwss the Warm Storage contract (chain.contracts.fwss.address)
 * @param {bigint | string} dataSetId
 * @param {Array<bigint | string>} pieceIds
 * @param {string[]} keys
 * @returns {Promise<Map<string, Record<string, string>>>} piece id → { key: value } (unset keys left out)
 */
export async function readPieceMetadata(client, fwss, dataSetId, pieceIds, keys) {
  const out = new Map()
  const calls = []
  for (const id of pieceIds) for (const key of keys) calls.push({ id: String(id), key, slot: pieceMetadataSlot(dataSetId, id, key) })
  const words = await Promise.all(calls.map((c) => client.readContract({ address: fwss, abi: ABI, functionName: 'extsload', args: [c.slot] })))
  const readLong = (slot, n) => client.readContract({ address: fwss, abi: ABI, functionName: 'extsloadStruct', args: [slot, BigInt(n)] })
  for (const [i, c] of calls.entries()) {
    const value = await decodeStringSlot(words[i], c.slot, readLong)
    const m = out.get(c.id) ?? {}
    if (value) m[c.key] = value
    out.set(c.id, m)
  }
  return out
}
