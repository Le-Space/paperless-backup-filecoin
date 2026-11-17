// Uploading one snapshot pack (snapshot.mjs) to every copy.
//
// Like parts.mjs: the primary stores the pack's parts, the other copies pull
// them, and each data set adds them in one AddPieces. Two differences:
//   - every piece carries its public snapshot metadata (pa, gen, seq);
//   - a copy that lacks earlier packs of the generation (a provider that
//     missed one, or a provider new to the generation) first pulls them from
//     a copy that has them, and adds them in the same AddPieces: a snapshot
//     is restorable from a copy only with every pack before it.
// A copy whose missing packs no other copy serves is left out (it counts as
// missing; the next baseline puts it back). Plain logic over contexts handed
// in, tested without a chain.

import { tryFrom as pieceFrom } from '@filoz/synapse-core/piece'

/**
 * @param {any[]} contexts synapse StorageContexts, primary first
 * @param {{ index: number, offset: number, size: number }[]} ranges the pack's parts
 * @param {(range: { offset: number, size: number }) => any} open a fresh stream of one range
 * @param {{
 *   metadataFor: (part: number, parts: number) => Record<string, string>,
 *   missingFor: (providerId: string) => Array<{ seq: number, pieceCids: string[], urls: string[] | null, metadata: Array<Record<string, string>> }>,
 *   log?: (...a: any[]) => void,
 * }} o
 */
export async function uploadPack(contexts, ranges, open, { metadataFor, missingFor, log = () => {} }) {
  const [primary] = contexts
  const pieceCids = []
  for (const range of ranges) {
    log(`pack part ${range.index + 1}/${ranges.length}: ${range.size} bytes to provider ${primary.provider.id} …`)
    let stored
    try {
      stored = await primary.store(open(range))
    } catch (err) {
      throw Object.assign(new Error(`Failed to store part ${range.index + 1}/${ranges.length} on primary provider ${primary.provider.id}`, { cause: err }), { providerId: primary.provider.id })
    }
    if (Number(stored.size) !== range.size) throw new Error(`provider ${primary.provider.id} stored ${stored.size} bytes of part ${range.index + 1}, not ${range.size}`)
    pieceCids.push(stored.pieceCid)
  }
  const fresh = pieceCids.map((pieceCid, i) => ({ pieceCid, pieceMetadata: metadataFor(i, pieceCids.length), from: (cid) => primary.getPieceUrl(cid) }))

  const failedAttempts = []
  const ready = []
  for (const [i, ctx] of contexts.entries()) {
    const role = i === 0 ? 'primary' : 'secondary'
    const lack = missingFor(String(ctx.provider.id))
    if (lack.some((p) => !p.urls)) {
      failedAttempts.push({ providerId: ctx.provider.id, role, error: `lacks ${lack.length} earlier pack(s) of the generation that no copy serves` })
      continue
    }
    const older = lack.flatMap((p) => p.pieceCids.map((cid, j) => ({ pieceCid: pieceFrom(cid), pieceMetadata: p.metadata[j], url: p.urls[j] })))
    if (older.some((p) => !p.pieceCid)) {
      failedAttempts.push({ providerId: ctx.provider.id, role, error: 'an earlier pack has a malformed piece CID' })
      continue
    }
    const pieces = [...older.map(({ pieceCid, pieceMetadata }) => ({ pieceCid, pieceMetadata })), ...fresh.map(({ pieceCid, pieceMetadata }) => ({ pieceCid, pieceMetadata }))]
    // The primary already holds the new parts; every copy pulls what it lacks.
    const pulls = [...older, ...(role === 'primary' ? [] : fresh.map((p) => ({ ...p, url: p.from(p.pieceCid) })))]
    if (!pulls.length) {
      ready.push({ ctx, role, pieces, extraData: undefined, repaired: 0 })
      continue
    }
    try {
      // The signature for the commit comes first: the provider adds what it pulled with it.
      const extraData = await ctx.presignForCommit(pieces)
      const urlOf = new Map(pulls.map((p) => [String(p.pieceCid), p.url]))
      if (older.length) log(`provider ${ctx.provider.id}: pulling ${lack.length} earlier pack(s) of the generation it lacks …`)
      const res = await ctx.pull({ pieces: pulls.map((p) => p.pieceCid), from: (cid) => urlOf.get(String(cid)), extraData })
      if (res.status === 'complete') ready.push({ ctx, role, pieces, extraData, repaired: lack.length })
      else failedAttempts.push({ providerId: ctx.provider.id, role, error: `pull failed for ${res.pieces.filter((p) => p.status !== 'complete').length} of ${pulls.length} pieces` })
    } catch (err) {
      failedAttempts.push({ providerId: ctx.provider.id, role, error: String(err?.message ?? err).slice(0, 300) })
    }
  }

  const settled = await Promise.allSettled(ready.map(({ ctx, pieces, extraData }) => ctx.commit({ pieces, extraData })))
  const copies = []
  let primaryError
  settled.forEach((s, i) => {
    const { ctx, role, pieces, repaired } = ready[i]
    if (s.status === 'fulfilled' && s.value.pieceIds?.length === pieces.length) {
      const ids = [...s.value.pieceIds]
      const own = ids.slice(ids.length - pieceCids.length)
      copies.push({
        providerId: ctx.provider.id,
        dataSetId: s.value.dataSetId,
        pieceId: own[0],
        pieceIds: own,
        role,
        retrievalUrl: ctx.getPieceUrl(pieceCids[0]),
        retrievalUrls: pieceCids.map((cid) => ctx.getPieceUrl(cid)),
        isNewDataSet: s.value.isNewDataSet,
        ...(repaired ? { repairedPacks: repaired } : {}),
      })
      return
    }
    const error = s.status === 'rejected' ? String(s.reason?.message ?? s.reason).slice(0, 300) : `added ${s.value.pieceIds?.length ?? 0} of ${pieces.length} pieces`
    if (role === 'primary') primaryError = s.status === 'rejected' ? s.reason : new Error(error)
    failedAttempts.push({ providerId: ctx.provider.id, role, error: `Commit failed: ${error}` })
  })
  if (!copies.length) throw Object.assign(new Error(`Failed to commit the pack on primary provider ${primary.provider.id}`, { cause: primaryError }), { providerId: primary.provider.id })
  return { pieceCid: pieceCids[0], pieceCids, size: ranges.reduce((n, r) => n + r.size, 0), requestedCopies: contexts.length, complete: copies.length >= contexts.length, copies, failedAttempts }
}
