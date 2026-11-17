// Retention: which backups stay and which go, read from the chain.
//
// A data set only grows: every backup adds its pieces and nothing removes
// them. `retain` keeps
//   - the newest complete backup, always;
//   - the backups named in `protect` (the one the running VM was restored
//     from), always;
//   - the newest backup each data set holds, always: when the providers of
//     the newer ones are down, it is the newest one left to restore;
//   - the last `keepLast` backups;
//   - per UTC day of the last `keepDays` days, per ISO week of the last
//     `keepWeeks` weeks and per month of the last `keepMonths` months, the
//     newest backup of that day, week or month (a complete one if it has one);
//   - every backup whose date is unknown (nothing is removed on a guess);
// and schedules the removal of the others. With `maxBytes` the backups kept
// only for a day, week or month go, oldest first, until the kept ones and one
// more backup as large as the newest fit (a quota per data set).
//
// Everything here is plain logic over what the chain said, so it is tested
// without a chain. backup.mjs reads the chain and sends the removals.

import { PART_BYTES } from './parts.mjs'

const DAY = 24 * 60 * 60 * 1000

/** What `retain` keeps when the config says nothing, per network. */
export const DEFAULT_RETENTION = Object.freeze({
  mainnet: Object.freeze({ keepLast: 3, keepDays: 7, keepWeeks: 4, keepMonths: 6, maxBytes: null, keepLegacy: false }),
  calibration: Object.freeze({ keepLast: 2, keepDays: 2, keepWeeks: 1, keepMonths: 0, maxBytes: null, keepLegacy: false }),
})

/** Why a backup stays, in the order they are reported. */
export const REASONS = Object.freeze(['newest', 'restored', 'place', 'last', 'undated', 'day', 'week', 'month', 'generation', 'legacy'])

/**
 * The policy from config.retention over the network's defaults, checked.
 * @param {any} retention config.retention (may be missing)
 * @param {'mainnet' | 'calibration'} network
 */
export function retentionPolicy(retention, network) {
  const base = DEFAULT_RETENTION[network === 'mainnet' ? 'mainnet' : 'calibration']
  const p = { ...base, ...(retention ?? {}) }
  for (const k of ['keepLast', 'keepDays', 'keepWeeks', 'keepMonths']) {
    if (!Number.isInteger(p[k]) || p[k] < 0 || p[k] > 1000) throw new RangeError(`retention.${k} must be a whole number from 0 to 1000`)
  }
  if (p.keepLast < 1) throw new RangeError('retention.keepLast must be at least 1')
  if (p.maxBytes != null && !(Number.isSafeInteger(p.maxBytes) && p.maxBytes > 0)) throw new RangeError('retention.maxBytes must be a positive number of bytes')
  if (p.keepLegacy != null && typeof p.keepLegacy !== 'boolean') throw new RangeError('retention.keepLegacy must be true or false')
  return { keepLast: p.keepLast, keepDays: p.keepDays, keepWeeks: p.keepWeeks, keepMonths: p.keepMonths, maxBytes: p.maxBytes ?? null, keepLegacy: p.keepLegacy ?? false }
}

/** The payload size a piece CID (v2) carries, or null. @param {string} cid @param {(cid: string) => number | null} sizeOf */
const sized = (cid, sizeOf) => {
  try {
    const n = sizeOf(cid)
    return Number.isSafeInteger(n) ? n : null
  } catch {
    return null
  }
}

/**
 * One data set's pieces as backups: in piece-id order, a run of full parts
 * (exactly PART_BYTES each) and the piece that ends it are one backup in
 * parts; any other piece is a backup of its own (as parts.mjs uploads them).
 * @param {Array<{ pieceId: bigint | number | string, pieceCid: string, date?: number | null }>} pieces
 * @param {(cid: string) => number | null} sizeOf
 */
export function groupPieces(pieces, sizeOf) {
  const sorted = [...pieces].sort((a, b) => (BigInt(a.pieceId) < BigInt(b.pieceId) ? -1 : BigInt(a.pieceId) > BigInt(b.pieceId) ? 1 : 0))
  const groups = []
  let run = []
  for (const p of sorted) {
    const size = sized(String(p.pieceCid), sizeOf)
    run.push({ pieceId: BigInt(p.pieceId), pieceCid: String(p.pieceCid), size, date: p.date ?? null })
    if (size !== PART_BYTES) {
      groups.push(run)
      run = []
    }
  }
  if (run.length) groups.push(run)
  return groups
}

/**
 * The backups the data sets hold: a backup is the same pieces in the same
 * order; a data set holds a copy of it with all of them. A run of parts that
 * is only the beginning of a longer backup elsewhere (a copy that lost its
 * last parts) is not a backup of its own: its pieces go with that backup's
 * removal in that data set. A backup's date is the earliest date of its
 * pieces, null when none has one. Newest first: by date, undated ones last
 * (they stay anyway), then by the highest piece id a copy gave it (piece ids
 * grow within a data set, not across them). `order` is that rank, 1 the
 * oldest. Complete with `copies` copies (what the config asks for, at most
 * the number of data sets; by default every data set).
 * @param {Array<{ dataSetId: bigint | number | string, pieces: Array<{ pieceId: any, pieceCid: string, date?: number | null }> }>} sets
 * @param {{ sizeOf: (cid: string) => number | null, copies?: number | null }} o
 * @returns {Array<{ key: string, pieceCid: string, parts: number, size: number | null, date: number | null, order: number, complete: boolean, copies: Array<{ dataSetId: string, pieceIds: bigint[] }> }>}
 */
export function backupsOnChain(sets, { sizeOf, copies = null }) {
  const wanted = Math.min(copies > 0 ? copies : sets.length, sets.length)
  const byKey = new Map()
  // Snapshot packs (pieces with `snapshot` = { gen, seq, part, parts }):
  // grouped by generation and number, never by size.
  const snaps = new Map()
  const held = new Map()
  for (const ds of sets) {
    const id = String(ds.dataSetId)
    const here = new Map()
    for (const p of ds.pieces) {
      if (!p.snapshot) continue
      const k = `${p.snapshot.gen}/${p.snapshot.seq}`
      here.set(k, [...(here.get(k) ?? []), p])
    }
    const full = new Set()
    for (const [k, ps] of here) {
      const { gen, seq, parts } = ps[0].snapshot
      const s = snaps.get(k) ?? { gen, seq, parts, cids: [], order: 0, dates: [], copies: [] }
      const sorted = [...ps].sort((a, b) => (BigInt(a.pieceId) < BigInt(b.pieceId) ? -1 : 1))
      for (const p of sorted) {
        s.cids[p.snapshot.part] ??= String(p.pieceCid)
        if (Number.isFinite(p.date)) s.dates.push(p.date)
        s.order = Math.max(s.order, Number(p.pieceId))
      }
      s.copies.push({ dataSetId: id, pieceIds: sorted.map((p) => BigInt(p.pieceId)) })
      if (new Set(ps.map((p) => p.snapshot.part)).size === parts) full.add(k)
      snaps.set(k, s)
    }
    held.set(id, full)
  }
  for (const ds of sets) {
    for (const run of groupPieces(ds.pieces.filter((p) => !p.snapshot), sizeOf)) {
      const key = run.map((p) => p.pieceCid).join(' ')
      const b = byKey.get(key) ?? { key, run, order: 0, dates: [], copies: [] }
      b.order = Math.max(b.order, Number(run.at(-1).pieceId))
      for (const p of run) if (Number.isFinite(p.date)) b.dates.push(p.date)
      b.copies.push({ dataSetId: String(ds.dataSetId), pieceIds: run.map((p) => p.pieceId) })
      byKey.set(key, b)
    }
  }
  const all = [...byKey.values()]
  const longer = (b) => all.find((o) => o !== b && o.run.length > b.run.length && b.run.every((p, i) => o.run[i].pieceCid === p.pieceCid))
  const out = []
  for (const b of all) {
    const whole = (b.run.length > 1 || b.run[0].size === PART_BYTES) && longer(b)
    if (whole) {
      // Its pieces are a fragment of `whole`: removed with it, never a backup.
      whole.fragments = [...(whole.fragments ?? []), ...b.copies]
      continue
    }
    out.push(b)
  }
  // A data set can restore a snapshot only with every pack of its generation up to it.
  const restorable = (s) => [...held.values()].filter((full) => Array.from({ length: s.seq + 1 }, (_, i) => `${s.gen}/${i}`).every((k) => full.has(k))).length
  const snapshots = [...snaps.values()].map((s) => {
    const sizes = s.cids.map((c) => (c ? sized(c, sizeOf) : null))
    return {
      key: s.cids.filter(Boolean).join(' '),
      pieceCid: s.cids[0] ?? s.cids.find(Boolean),
      parts: s.parts,
      size: sizes.length === s.parts && sizes.every((n) => n != null) ? sizes.reduce((a, n) => a + n, 0) : null,
      date: s.dates.length ? Math.min(...s.dates) : null,
      order: s.order,
      complete: restorable(s) >= wanted,
      copies: s.copies,
      gen: s.gen,
      seq: s.seq,
    }
  })
  return [
    ...out.map((b) => {
      const sizes = b.run.map((p) => p.size)
      return {
        key: b.key,
        pieceCid: b.run[0].pieceCid,
        parts: b.run.length,
        size: sizes.every((n) => n != null) ? sizes.reduce((a, n) => a + n, 0) : null,
        date: b.dates.length ? Math.min(...b.dates) : null,
        order: b.order,
        complete: b.copies.length >= wanted,
        copies: [...b.copies, ...(b.fragments ?? [])],
      }
    }),
    ...snapshots,
  ]
    .sort((a, b) => (a.date ?? -Infinity) - (b.date ?? -Infinity) || a.order - b.order)
    .map((b, i) => ({ ...b, order: i + 1 }))
    .reverse()
}

/** UTC day, ISO week and month of a time, as bucket keys. @param {number} t */
export function calendarKeys(t) {
  const d = new Date(t)
  const day = d.toISOString().slice(0, 10)
  // ISO week: the Thursday of this week decides the year.
  const thursday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 3 - ((d.getUTCDay() + 6) % 7)))
  const week = Math.ceil(((thursday - Date.UTC(thursday.getUTCFullYear(), 0, 1)) / DAY + 1) / 7)
  return { day, week: `${thursday.getUTCFullYear()}-W${String(week).padStart(2, '0')}`, month: day.slice(0, 7) }
}

/** The start of the month `n` months before the month of `now` (UTC). */
const monthsBack = (now, n) => {
  const d = new Date(now)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - n + 1, 1)
}

/**
 * Which backups stay and which go.
 * @param {Array<{ key: string, pieceCid: string, size: number | null, date: number | null, order: number, complete: boolean }>} backups as backupsOnChain returns them
 * @param {{ keepLast: number, keepDays: number, keepWeeks: number, keepMonths: number, maxBytes: number | null }} policy
 * @param {{ now: number, protect?: Iterable<string> }} o protect: piece CIDs (any part) of backups that must stay
 * @returns {{ keep: Array<any>, remove: Array<any>, keptBytes: number | null, overBudget: boolean }}
 */
export function planRetention(backups, policy, { now, protect = [] }) {
  const sorted = [...backups].sort((a, b) => b.order - a.order)
  const guard = new Set([...protect].map(String))
  const why = new Map(sorted.map((b) => [b, new Set()]))
  const add = (b, reason) => b && why.get(b).add(reason)

  add(sorted.find((b) => b.complete), 'newest')
  for (const b of sorted) if (guard.has(b.pieceCid) || b.key.split(' ').some((c) => guard.has(c))) add(b, 'restored')
  // The newest backup of each data set (fragments of a backup count too:
  // what is left of it there may still be all that data set has).
  const places = new Set()
  for (const b of sorted) {
    for (const c of b.copies ?? []) {
      if (places.has(c.dataSetId)) continue
      places.add(c.dataSetId)
      add(b, 'place')
    }
  }
  for (const b of sorted.slice(0, policy.keepLast)) add(b, 'last')
  for (const b of sorted) if (!Number.isFinite(b.date)) add(b, 'undated')

  const windows = [
    ['day', now - policy.keepDays * DAY, policy.keepDays],
    ['week', now - policy.keepWeeks * 7 * DAY, policy.keepWeeks],
    ['month', monthsBack(now, policy.keepMonths), policy.keepMonths],
  ]
  for (const [unit, since, n] of windows) {
    if (!n) continue
    const pick = new Map()
    for (const b of sorted) {
      if (!Number.isFinite(b.date) || b.date < since) continue
      const k = calendarKeys(b.date)[unit]
      const had = pick.get(k)
      // The newest of its day/week/month, a complete one before a partial one.
      if (!had || (!had.complete && b.complete)) pick.set(k, b)
    }
    for (const b of pick.values()) add(b, unit)
  }

  // Within the quota: the ones kept only for a day, week or month go first,
  // oldest first, until the kept ones and room for one more backup fit.
  let overBudget = false
  const sizeKnown = sorted.every((b) => b.size != null)
  const keptBytes = () => sorted.filter((b) => why.get(b).size).reduce((n, b) => n + b.size, 0)
  if (policy.maxBytes != null && sizeKnown) {
    const room = sorted[0]?.size ?? 0
    const calendarOnly = (b) => why.get(b).size && [...why.get(b)].every((r) => r === 'day' || r === 'week' || r === 'month')
    for (const b of [...sorted].reverse()) {
      if (keptBytes() + room <= policy.maxBytes) break
      if (calendarOnly(b)) why.get(b).clear()
    }
    overBudget = keptBytes() + room > policy.maxBytes
  }

  // Backups of the old kind (full, no snapshot metadata) stay while the
  // snapshots have not been restored once (keepLegacy).
  if (policy.keepLegacy) for (const b of sorted) if (b.gen == null) add(b, 'legacy')
  // A snapshot needs every pack before it in its generation: whatever a kept
  // snapshot builds on stays too. Packs after the newest kept one may go.
  const upTo = new Map()
  for (const b of sorted) if (b.gen != null && why.get(b).size) upTo.set(b.gen, Math.max(upTo.get(b.gen) ?? -1, b.seq))
  for (const b of sorted) if (b.gen != null && !why.get(b).size && b.seq <= (upTo.get(b.gen) ?? -1)) add(b, 'generation')

  const order = (r) => REASONS.indexOf(r)
  const keep = []
  const remove = []
  for (const b of sorted) {
    const reasons = [...why.get(b)].sort((x, y) => order(x) - order(y))
    if (reasons.length) keep.push({ ...b, reasons })
    else remove.push(b)
  }
  return { keep, remove, keptBytes: sizeKnown ? keptBytes() : null, overBudget }
}

/**
 * The removals per data set: every piece id of every copy of the backups to
 * remove (all parts in one SchedulePieceRemovals per data set), without the
 * ones already scheduled.
 * @param {Array<{ copies: Array<{ dataSetId: string, pieceIds: bigint[] }> }>} remove
 * @param {Map<string, Set<string>>} [scheduled] data set id → piece ids already scheduled for removal
 * @returns {Map<string, bigint[]>}
 */
export function removalsByDataSet(remove, scheduled = new Map()) {
  const out = new Map()
  for (const b of remove) {
    for (const c of b.copies) {
      const already = scheduled.get(c.dataSetId) ?? new Set()
      const ids = c.pieceIds.filter((id) => !already.has(String(id)))
      if (ids.length) out.set(c.dataSetId, [...(out.get(c.dataSetId) ?? []), ...ids])
    }
  }
  for (const [k, ids] of out) out.set(k, [...new Set(ids.map(String))].map(BigInt).sort((a, b) => (a < b ? -1 : 1)))
  return out
}

/**
 * Dates of pieces from the PDP explorer's subgraph (when each was added),
 * checked against the chain's own order: within a data set, a piece with a
 * higher id was added later. Dates that break that order are dropped (the
 * backups they belong to then count as undated and stay).
 * @param {Array<{ pieceId: bigint, date: number | null }>} pieces of one data set
 */
export function consistentDates(pieces) {
  const sorted = [...pieces].sort((a, b) => (a.pieceId < b.pieceId ? -1 : 1))
  let last = -Infinity
  let broken = false
  for (const p of sorted) {
    if (!Number.isFinite(p.date)) continue
    if (p.date < last) broken = true
    last = p.date
  }
  return broken ? pieces.map((p) => ({ ...p, date: null })) : pieces
}

/** Short lines for a plan: date, size, why. No ids. @param {{ keep: any[], remove: any[] }} plan */
export function describePlan(plan) {
  const gib = (n) => (n == null ? '?' : `${(n / 2 ** 30).toFixed(2)} GiB`)
  const when = (t) => (Number.isFinite(t) ? new Date(t).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : 'date unknown')
  return [
    ...plan.keep.map((b) => `keep    ${when(b.date)}  ${gib(b.size)}  ${b.complete ? '' : '(partial) '}${b.reasons.join(', ')}`),
    ...plan.remove.map((b) => `remove  ${when(b.date)}  ${gib(b.size)}  ${b.complete ? '' : '(partial)'}`),
  ]
}

/**
 * Which data sets to end after the backups moved to other providers for
 * good: those at a provider the config no longer names. Nothing is ended
 *   - unless the config names providers (`providerIds`);
 *   - unless the newest backup is on chain at `copies` of the named
 *     providers' data sets (default: as many as it names);
 *   - while a data set holds a protected backup (the one a machine started
 *     from) or a backup without a date that no named provider holds (it may
 *     be newer than it looks).
 * @param {Array<{ dataSetId: string, providerId: string }>} sets the account's live data sets
 * @param {Array<{ pieceCid: string, key: string, date: number | null, copies: Array<{ dataSetId: string }> }>} backups as backupsOnChain returns them
 * `only`: end data sets at these providers only (others the config dropped stay).
 * @param {{ providerIds: Array<number | string>, copies?: number | null, protect?: Iterable<string>, only?: Array<number | string> | null }} o
 * @returns {{ ready: boolean, why: string | null, retire: Array<{ dataSetId: string, providerId: string, backups: number }>, blocked: Array<{ dataSetId: string, providerId: string, why: string }> }}
 */
export function retirePlan(sets, backups, { providerIds, copies = null, protect = [], only = null }) {
  const named = new Set((providerIds ?? []).map(String))
  if (!named.size) return { ready: false, why: 'the config names no providers (providerIds)', retire: [], blocked: [] }
  const fresh = new Set(sets.filter((s) => named.has(String(s.providerId))).map((s) => String(s.dataSetId)))
  const picked = only?.length ? new Set(only.map(String)) : null
  if (picked && [...picked].some((p) => named.has(p))) return { ready: false, why: 'a provider to end is still named in providerIds', retire: [], blocked: [] }
  const old = sets.filter((s) => !named.has(String(s.providerId)) && (!picked || picked.has(String(s.providerId))))
  if (!old.length) return { ready: true, why: null, retire: [], blocked: [] }
  const atFresh = (b) => b.copies.filter((c) => fresh.has(String(c.dataSetId))).length
  const dated = backups.filter((b) => Number.isFinite(b.date)).sort((a, b) => b.date - a.date)
  const newest = dated[0]
  const want = copies > 0 ? copies : named.size
  if (!newest || atFresh(newest) < want) {
    return { ready: false, why: `the newest backup is not yet at ${want} of the named providers`, retire: [], blocked: old.map((s) => ({ dataSetId: String(s.dataSetId), providerId: String(s.providerId), why: 'newest backup not moved yet' })) }
  }
  const guard = new Set([...protect].map(String))
  const isProtected = (b) => b.key.split(' ').some((c) => guard.has(c))
  const retire = []
  const blocked = []
  for (const s of old) {
    const id = String(s.dataSetId)
    const here = backups.filter((b) => b.copies.some((c) => String(c.dataSetId) === id))
    const only = (b) => atFresh(b) === 0
    const why = here.some((b) => isProtected(b) && only(b)) ? 'holds the backup a machine started from, which no named provider holds' : here.some((b) => !Number.isFinite(b.date) && only(b)) ? 'holds an undated backup that no named provider holds' : null
    if (why) blocked.push({ dataSetId: id, providerId: String(s.providerId), why })
    else retire.push({ dataSetId: id, providerId: String(s.providerId), backups: here.length })
  }
  return { ready: true, why: null, retire, blocked }
}
