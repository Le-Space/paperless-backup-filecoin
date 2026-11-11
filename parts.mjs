// Backups in parts. Some PDP providers take no piece above 1 GiB (with fr32
// expansion), whatever their registry entry says, so an encrypted export
// larger than PART_BYTES is uploaded as several pieces: byte ranges of the
// one sealed file, in order, each at most PART_BYTES. Every part goes to every
// copy, in one AddPieces per data set, and a copy counts only with all parts.
//
// A backup of at most PART_BYTES stays one piece and keeps the ledger format
// it always had (no `parts`, no `pieceIds`), so older tools and images read
// it as before. A backup in parts adds, to the same entry:
//
//   parts:  [{ pieceCid, offset, size, sha256 }, …]   in file order
//   copies: [{ …, pieceId, pieceIds: […], retrievalUrl, retrievalUrls: […] }]
//
// with pieceCid / pieceId / retrievalUrl naming the first part, and size,
// sealedSha256 and plainSha256 the whole file. Everything here is plain
// logic over contexts and streams handed in, so it is tested without a chain.

import { createHash } from 'node:crypto'
import { Transform } from 'node:stream'

/** The largest piece one part may be: below 1 GiB, the strictest provider's limit. */
export const PART_BYTES = 1_000_000_000

/**
 * The byte ranges of a sealed file of `size` bytes: one range when it fits
 * PART_BYTES, else full parts of PART_BYTES and a last, shorter one.
 * @param {number} size @param {number} [partBytes]
 * @returns {{ index: number, offset: number, size: number }[]}
 */
export function partRanges(size, partBytes = PART_BYTES) {
  if (!Number.isSafeInteger(size) || size < 0) throw new RangeError(`not a file size: ${size}`)
  if (!Number.isSafeInteger(partBytes) || partBytes < 1) throw new RangeError(`not a part size: ${partBytes}`)
  if (size <= partBytes) return [{ index: 0, offset: 0, size }]
  const ranges = []
  for (let offset = 0, index = 0; offset < size; offset += partBytes, index++) ranges.push({ index, offset, size: Math.min(partBytes, size - offset) })
  return ranges
}

/**
 * A pass-through stream that hashes the bytes in parts of `partBytes` as they
 * go by (the sealed file is written once, and its parts are hashed on the way).
 * digests() after the end: one SHA-256 (hex) per part, as partRanges cuts them.
 * @param {number} [partBytes]
 */
export function partHasher(partBytes = PART_BYTES) {
  const digests = []
  let hash = createHash('sha256')
  let filled = 0
  let total = 0
  const stream = new Transform({
    transform(chunk, _, done) {
      total += chunk.length
      let at = 0
      while (at < chunk.length) {
        const take = Math.min(partBytes - filled, chunk.length - at)
        hash.update(chunk.subarray(at, at + take))
        filled += take
        at += take
        if (filled === partBytes) {
          digests.push(hash.digest('hex'))
          hash = createHash('sha256')
          filled = 0
        }
      }
      done(null, chunk)
    },
  })
  return {
    stream,
    /** One digest per part of partRanges(total): a file that fits one part has one. */
    digests() {
      const out = [...digests]
      if (filled > 0 || total === 0) out.push(hash.digest('hex'))
      return out
    },
  }
}

/** Is this ledger entry a backup in parts? */
export const isMultipart = (entry) => Array.isArray(entry?.parts) && entry.parts.length > 1

/**
 * The parts of any ledger entry, old or new: a single-piece entry is one part,
 * the whole file, its SHA-256 the sealed file's.
 * @returns {{ pieceCid: string, offset: number, size: number, sha256?: string }[]}
 */
export function entryParts(entry) {
  if (isMultipart(entry)) return entry.parts
  return [{ pieceCid: entry.pieceCid, offset: 0, size: entry.size, sha256: entry.sealedSha256 }]
}

/** The piece ids one copy holds, in part order (old entries: the one pieceId). */
export const copyPieceIds = (copy) => (Array.isArray(copy?.pieceIds) && copy.pieceIds.length ? copy.pieceIds : [copy.pieceId])

/** Where one copy serves each part, in part order (old entries: the one retrievalUrl). */
export const copyUrls = (copy) => (Array.isArray(copy?.retrievalUrls) && copy.retrievalUrls.length ? copy.retrievalUrls : [copy.retrievalUrl])

/**
 * Which parts of `entry` a data set lacks, given the piece CIDs it holds.
 * Empty: the copy is complete. A copy in parts counts only with all of them.
 * @param {any} entry @param {Set<string>} present
 */
export const missingParts = (entry, present) => entryParts(entry).filter((p) => !present.has(p.pieceCid))

/**
 * The ledger entry's fields for a backup: the old format for one piece, the
 * additive parts format for several.
 * @param {{ sealedBytes: number, ranges: { offset: number, size: number }[], partSha256: string[] }} backup
 * @param {{ pieceCid: any, copies: any[] }} result the upload's result
 */
export function pieceFields(backup, result) {
  const fields = { pieceCid: String(result.pieceCid), size: backup.sealedBytes }
  if (!result.pieceCids || result.pieceCids.length < 2) return fields
  return {
    ...fields,
    parts: result.pieceCids.map((cid, i) => ({ pieceCid: String(cid), offset: backup.ranges[i].offset, size: backup.ranges[i].size, sha256: backup.partSha256[i] })),
  }
}

/**
 * Uploads the parts to every context: each part stored on the primary, the
 * secondaries pull all of them from it, then each data set adds all parts in
 * one AddPieces (with a new data set: CreateDataSet and AddPieces). A primary
 * that fails to store a part fails the upload (the caller tries the next
 * primary); a secondary that fails costs that copy only.
 *
 * The result has the shape of synapse's StorageManager.upload, plus
 * `pieceCids` (in part order) and per copy `pieceIds` and `retrievalUrls`.
 *
 * @param {any[]} contexts synapse StorageContexts, primary first
 * @param {{ index: number, offset: number, size: number }[]} ranges
 * @param {(range: { offset: number, size: number }) => any} open a fresh stream of one range
 * @param {{ log?: (...a: any[]) => void }} [o]
 */
export async function uploadParts(contexts, ranges, open, { log = () => {} } = {}) {
  const [primary, ...secondaries] = contexts
  const pieceCids = []
  for (const range of ranges) {
    log(`part ${range.index + 1}/${ranges.length}: ${range.size} bytes to provider ${primary.provider.id} …`)
    let stored
    try {
      stored = await primary.store(open(range))
    } catch (err) {
      throw Object.assign(new Error(`Failed to store part ${range.index + 1}/${ranges.length} on primary provider ${primary.provider.id}`, { cause: err }), { providerId: primary.provider.id })
    }
    if (Number(stored.size) !== range.size) throw new Error(`provider ${primary.provider.id} stored ${stored.size} bytes of part ${range.index + 1}, not ${range.size}`)
    pieceCids.push(stored.pieceCid)
  }
  const pieces = pieceCids.map((pieceCid) => ({ pieceCid }))

  const failedAttempts = []
  const pulled = []
  for (const ctx of secondaries) {
    try {
      // The signature for the commit comes first: the provider adds what it pulled with it.
      const extraData = await ctx.presignForCommit(pieces)
      const res = await ctx.pull({ pieces: pieceCids, from: (cid) => primary.getPieceUrl(cid), extraData })
      if (res.status === 'complete') pulled.push({ ctx, extraData })
      else failedAttempts.push({ providerId: ctx.provider.id, role: 'secondary', error: `pull failed for ${res.pieces.filter((p) => p.status !== 'complete').length} of ${pieceCids.length} parts` })
    } catch (err) {
      failedAttempts.push({ providerId: ctx.provider.id, role: 'secondary', error: String(err?.message ?? err).slice(0, 300) })
    }
  }

  const committing = [{ ctx: primary, role: 'primary' }, ...pulled.map((p) => ({ ...p, role: 'secondary' }))]
  const settled = await Promise.allSettled(committing.map(({ ctx, extraData }) => ctx.commit({ pieces, extraData })))
  const copies = []
  let primaryError
  settled.forEach((s, i) => {
    const { ctx, role } = committing[i]
    if (s.status === 'fulfilled' && s.value.pieceIds?.length === pieceCids.length) {
      copies.push({
        providerId: ctx.provider.id,
        dataSetId: s.value.dataSetId,
        pieceId: s.value.pieceIds[0],
        pieceIds: [...s.value.pieceIds],
        role,
        retrievalUrl: ctx.getPieceUrl(pieceCids[0]),
        retrievalUrls: pieceCids.map((cid) => ctx.getPieceUrl(cid)),
        isNewDataSet: s.value.isNewDataSet,
      })
      return
    }
    const error = s.status === 'rejected' ? String(s.reason?.message ?? s.reason).slice(0, 300) : `added ${s.value.pieceIds?.length ?? 0} of ${pieceCids.length} parts`
    if (role === 'primary') primaryError = s.status === 'rejected' ? s.reason : new Error(error)
    failedAttempts.push({ providerId: ctx.provider.id, role, error: `Commit failed: ${error}` })
  })
  if (!copies.length) throw Object.assign(new Error(`Failed to commit the parts on primary provider ${primary.provider.id}`, { cause: primaryError }), { providerId: primary.provider.id })
  return { pieceCid: pieceCids[0], pieceCids, size: ranges.reduce((n, r) => n + r.size, 0), requestedCopies: contexts.length, complete: copies.length >= contexts.length, copies, failedAttempts }
}

/**
 * Puts a backup back together: each part fetched (`fetchPart` tries the
 * copies), checked against its size and SHA-256, written to `out` in order,
 * and the whole checked against sealedSha256. Throws on the first part that is
 * missing or does not match, naming it.
 * @param {any} entry a ledger entry, single piece or in parts
 * @param {(part: { pieceCid: string, offset: number, size: number, sha256?: string }, index: number) => Promise<Uint8Array | null>} fetchPart
 * @param {{ write: (bytes: Uint8Array) => Promise<void> | void }} out
 */
export async function reassemble(entry, fetchPart, out) {
  const parts = entryParts(entry)
  const whole = createHash('sha256')
  let bytes = 0
  for (const [i, part] of parts.entries()) {
    const label = `part ${i + 1}/${parts.length} (${part.pieceCid})`
    const data = await fetchPart(part, i)
    if (!data) throw new Error(`${label}: no copy delivered it`)
    if (part.size != null && data.length !== part.size) throw new Error(`${label}: ${data.length} bytes, the ledger says ${part.size}`)
    if (part.sha256 && createHash('sha256').update(data).digest('hex') !== part.sha256) throw new Error(`${label}: does not match its SHA-256 in the ledger`)
    whole.update(data)
    bytes += data.length
    await out.write(data)
  }
  if (entry.size != null && bytes !== entry.size) throw new Error(`the parts make ${bytes} bytes, the ledger says ${entry.size}`)
  if (entry.sealedSha256 && whole.digest('hex') !== entry.sealedSha256) throw new Error('the reassembled backup does not match the ledger checksum')
  return bytes
}
