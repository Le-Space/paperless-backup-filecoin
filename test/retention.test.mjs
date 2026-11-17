// Retention (retention.mjs): which backups stay and which go. No chain; the
// pieces, CIDs and dates are made up.
//
//   node --test test/

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { PART_BYTES } from '../parts.mjs'
import { DEFAULT_RETENTION, backupsOnChain, calendarKeys, consistentDates, describePlan, groupPieces, planRetention, removalsByDataSet, retentionPolicy } from '../retention.mjs'

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 10, 16, 12) // Mon 2026-11-16 12:00 UTC
const GiB = 2 ** 30

/** A made-up backup as backupsOnChain returns it. */
let n = 0
function backup({ daysAgo, complete = true, size = GiB, date } = {}) {
  n++
  return { key: `cid-${n}`, pieceCid: `cid-${n}`, parts: 1, size, date: date !== undefined ? date : NOW - daysAgo * DAY, order: n, complete, copies: [{ dataSetId: '1', pieceIds: [BigInt(n)] }] }
}
/** Newest first, as the chain lists them: built oldest first. */
const history = (...specs) => specs.map(backup).reverse()
const loose = { keepLast: 1, keepDays: 0, keepWeeks: 0, keepMonths: 0, maxBytes: null }

describe('the policy from the config', () => {
  it('takes the network defaults and lets the config override them', () => {
    assert.deepEqual(retentionPolicy(undefined, 'mainnet'), { ...DEFAULT_RETENTION.mainnet })
    assert.deepEqual(retentionPolicy({ keepLast: 5 }, 'calibration'), { ...DEFAULT_RETENTION.calibration, keepLast: 5 })
  })
  it('refuses keepLast 0, negatives, fractions and a bad maxBytes', () => {
    assert.throws(() => retentionPolicy({ keepLast: 0 }, 'mainnet'), /keepLast/)
    assert.throws(() => retentionPolicy({ keepDays: -1 }, 'mainnet'), /keepDays/)
    assert.throws(() => retentionPolicy({ keepWeeks: 1.5 }, 'mainnet'), /keepWeeks/)
    assert.throws(() => retentionPolicy({ maxBytes: 0 }, 'mainnet'), /maxBytes/)
  })
})

describe('what stays', () => {
  it('keeps the last N and removes the older ones', () => {
    const b = history({ daysAgo: 40 }, { daysAgo: 30 }, { daysAgo: 20 }, { daysAgo: 10 }, { daysAgo: 1 })
    const plan = planRetention(b, { ...loose, keepLast: 2 }, { now: NOW })
    assert.deepEqual(plan.keep.map((k) => k.pieceCid), [b[0].pieceCid, b[1].pieceCid])
    assert.deepEqual(plan.remove.map((k) => k.pieceCid), [b[2].pieceCid, b[3].pieceCid, b[4].pieceCid])
  })

  it('never removes the newest complete backup, even behind newer partial ones', () => {
    const b = history({ daysAgo: 9 }, { daysAgo: 5 }, { daysAgo: 2, complete: false }, { daysAgo: 1, complete: false })
    const plan = planRetention(b, loose, { now: NOW })
    const newest = plan.keep.find((k) => k.reasons.includes('newest'))
    assert.equal(newest.pieceCid, b[2].pieceCid)
    assert.ok(plan.remove.some((r) => r.pieceCid === b[3].pieceCid))
  })

  it('never removes the backup the VM was restored from, by any of its parts', () => {
    const b = history({ daysAgo: 300 }, { daysAgo: 200 }, { daysAgo: 1 })
    b[2] = { ...b[2], key: `${b[2].pieceCid} part-two`, parts: 2 }
    const plan = planRetention(b, loose, { now: NOW, protect: ['part-two'] })
    assert.deepEqual(plan.keep.find((k) => k.pieceCid === b[2].pieceCid)?.reasons, ['restored'])
    assert.equal(plan.remove.length, 1)
  })

  it('keeps one per day, week and month in their windows, the newest of each', () => {
    // Two on each of three days, then weekly ones, then monthly ones.
    const b = history(
      { daysAgo: 150 }, { daysAgo: 120 }, { daysAgo: 100 }, { daysAgo: 95 },
      { daysAgo: 21 }, { daysAgo: 14 }, { daysAgo: 13 },
      { daysAgo: 2.4 }, { daysAgo: 2.2 }, { daysAgo: 1.4 }, { daysAgo: 1.2 }, { daysAgo: 0.1 },
    )
    const plan = planRetention(b, { keepLast: 1, keepDays: 3, keepWeeks: 4, keepMonths: 4, maxBytes: null }, { now: NOW })
    const kept = (daysAgo) => plan.keep.find((k) => k.date === NOW - daysAgo * DAY)?.reasons
    assert.deepEqual(kept(0.1), ['newest', 'place', 'last', 'day', 'week', 'month'])
    assert.deepEqual(kept(1.2), ['day', 'week']) // Sunday: the newest of last ISO week
    assert.equal(kept(1.4), undefined)
    assert.deepEqual(kept(2.2), ['day'])
    assert.equal(kept(2.4), undefined)
    assert.ok(kept(13)?.includes('week'))
    assert.equal(kept(14), undefined) // same ISO week as 13 days ago (both in week 45), the newer stays
    assert.ok(kept(21)?.includes('week'))
    assert.ok(kept(95)?.includes('month')) // August: the newest of the month
    assert.equal(kept(100), undefined)
    assert.equal(kept(120), undefined) // July is outside four months back from November
    assert.equal(kept(150), undefined)
  })

  it('prefers a complete backup of a day over a newer partial one', () => {
    const b = history({ daysAgo: 1.4 }, { daysAgo: 1.2, complete: false }, { daysAgo: 0.1 })
    const plan = planRetention(b, { ...loose, keepDays: 3 }, { now: NOW })
    assert.ok(plan.keep.some((k) => k.date === NOW - 1.4 * DAY && k.reasons.includes('day')))
    assert.ok(plan.remove.some((r) => r.date === NOW - 1.2 * DAY))
  })

  it('keeps every backup whose date is unknown', () => {
    const b = history({ date: null }, { date: null }, { daysAgo: 1 })
    const plan = planRetention(b, loose, { now: NOW })
    assert.equal(plan.remove.length, 0)
    assert.deepEqual(plan.keep.map((k) => k.reasons), [['newest', 'place', 'last'], ['undated'], ['undated']])
  })

  it('with maxBytes drops calendar keeps oldest first until one more backup fits', () => {
    const b = history({ daysAgo: 60, size: 10 * GiB }, { daysAgo: 30, size: 10 * GiB }, { daysAgo: 8, size: 10 * GiB }, { daysAgo: 1, size: 5 * GiB })
    const policy = { keepLast: 1, keepDays: 0, keepWeeks: 0, keepMonths: 6, maxBytes: 25 * GiB }
    const plan = planRetention(b, policy, { now: NOW })
    // November's newest is the last one; 8 days ago goes anyway. Kept: 5 (Nov)
    // + 10 (Oct) + 10 (Sep) + 5 room = 30 GiB > 25: September's goes.
    assert.deepEqual(plan.remove.map((r) => r.date), [NOW - 8 * DAY, NOW - 60 * DAY])
    assert.equal(plan.keptBytes, 15 * GiB)
    assert.equal(plan.overBudget, false)
  })

  it('never drops the newest, the restored, the last N or undated ones for the quota, and says so', () => {
    const b = history({ date: null, size: 20 * GiB }, { daysAgo: 30, size: 20 * GiB }, { daysAgo: 1, size: 20 * GiB })
    const plan = planRetention(b, { ...loose, keepMonths: 3, maxBytes: 32 * GiB }, { now: NOW, protect: [b[1].pieceCid] })
    assert.equal(plan.remove.length, 0)
    assert.equal(plan.overBudget, true)
  })

  it('keeps the newest backup of each data set, where the newer ones went elsewhere', () => {
    const b = history({ daysAgo: 30 }, { daysAgo: 20 }, { daysAgo: 10 }, { daysAgo: 1 })
    // The two oldest are also in data set 2 (another provider); the newer ones are not.
    b[2].copies = [...b[2].copies, { dataSetId: '2', pieceIds: [7n] }]
    b[3].copies = [...b[3].copies, { dataSetId: '2', pieceIds: [6n] }]
    const plan = planRetention(b, loose, { now: NOW })
    assert.deepEqual(plan.keep.map((k) => [k.date, k.reasons]), [[NOW - DAY, ['newest', 'place', 'last']], [NOW - 20 * DAY, ['place']]])
  })

  it('removes nothing when nothing is complete and keeps the last N', () => {
    const b = history({ daysAgo: 3, complete: false }, { daysAgo: 1, complete: false })
    const plan = planRetention(b, { ...loose, keepLast: 2 }, { now: NOW })
    assert.equal(plan.remove.length, 0)
  })
})

describe('reading backups from data sets', () => {
  const sizeOf = (cid) => (cid.startsWith('full') ? PART_BYTES : 123)

  it('groups a run of full parts and its last part into one backup, in piece-id order', () => {
    const groups = groupPieces([{ pieceId: 3n, pieceCid: 'small' }, { pieceId: 1n, pieceCid: 'full-a' }, { pieceId: 2n, pieceCid: 'end-a' }], sizeOf)
    assert.deepEqual(groups.map((g) => g.map((p) => p.pieceCid)), [['full-a', 'end-a'], ['small']])
  })

  it('finds the same backup in two data sets, complete, newest first, dated by its earliest piece', () => {
    const sets = [
      { dataSetId: 7n, pieces: [{ pieceId: 0n, pieceCid: 'old', date: 100 }, { pieceId: 1n, pieceCid: 'full-a', date: 200 }, { pieceId: 2n, pieceCid: 'end-a', date: 201 }] },
      { dataSetId: 8n, pieces: [{ pieceId: 5n, pieceCid: 'full-a', date: 202 }, { pieceId: 6n, pieceCid: 'end-a', date: 203 }] },
    ]
    const backups = backupsOnChain(sets, { sizeOf })
    assert.deepEqual(backups.map((b) => [b.pieceCid, b.parts, b.complete, b.date]), [['full-a', 2, true, 200], ['old', 1, false, 100]])
    assert.deepEqual(backups[0].copies, [{ dataSetId: '7', pieceIds: [1n, 2n] }, { dataSetId: '8', pieceIds: [5n, 6n] }])
  })

  it('counts a backup complete with the copies asked for, and orders by date across data sets', () => {
    const sets = [
      { dataSetId: 1, pieces: [{ pieceId: 90, pieceCid: 'a', date: 1000 }, { pieceId: 91, pieceCid: 'b', date: 2000 }] },
      { dataSetId: 2, pieces: [{ pieceId: 3, pieceCid: 'a', date: 1001 }, { pieceId: 4, pieceCid: 'b', date: 2001 }] },
      { dataSetId: 3, pieces: [{ pieceId: 5, pieceCid: 'old', date: 500 }] }, // a third place holds only an old one
    ]
    const backups = backupsOnChain(sets, { sizeOf, copies: 2 })
    assert.deepEqual(backups.map((b) => [b.pieceCid, b.complete, b.order]), [['b', true, 3], ['a', true, 2], ['old', false, 1]])
    assert.equal(backupsOnChain(sets, { sizeOf }).filter((b) => b.complete).length, 0)
  })

  it('removes a lost-tail fragment together with the backup it belongs to', () => {
    const sets = [
      { dataSetId: 1, pieces: [{ pieceId: 1, pieceCid: 'full-a' }, { pieceId: 2, pieceCid: 'full-b' }, { pieceId: 3, pieceCid: 'end' }] },
      { dataSetId: 2, pieces: [{ pieceId: 9, pieceCid: 'full-a' }, { pieceId: 10, pieceCid: 'full-b' }] }, // lost its last part
    ]
    const backups = backupsOnChain(sets, { sizeOf })
    const whole = backups.find((b) => b.pieceCid === 'full-a' && b.parts === 3)
    assert.ok(whole)
    assert.equal(backups.filter((b) => b.pieceCid === 'full-a').length, 1)
    assert.deepEqual(removalsByDataSet([whole]), new Map([['1', [1n, 2n, 3n]], ['2', [9n, 10n]]]))
  })

  it('leaves out piece ids already scheduled for removal', () => {
    const remove = [{ copies: [{ dataSetId: '1', pieceIds: [4n, 5n] }, { dataSetId: '2', pieceIds: [6n] }] }]
    assert.deepEqual(removalsByDataSet(remove, new Map([['1', new Set(['4'])], ['2', new Set(['6'])]])), new Map([['1', [5n]]]))
  })

  it('drops the dates of a data set whose dates go against its piece order', () => {
    const ok = [{ pieceId: 1n, date: 10 }, { pieceId: 2n, date: null }, { pieceId: 3n, date: 30 }]
    assert.deepEqual(consistentDates(ok), ok)
    assert.ok(consistentDates([{ pieceId: 1n, date: 30 }, { pieceId: 2n, date: 10 }]).every((p) => p.date === null))
  })
})

describe('calendar keys and the report', () => {
  it('names the ISO week, also across a year', () => {
    assert.equal(calendarKeys(Date.UTC(2026, 10, 16)).week, '2026-W47')
    assert.equal(calendarKeys(Date.UTC(2027, 0, 1)).week, '2026-W53')
    assert.equal(calendarKeys(Date.UTC(2025, 11, 29)).week, '2026-W01')
    assert.equal(calendarKeys(Date.UTC(2026, 10, 16)).month, '2026-11')
  })

  it('describes a plan by date, size and reason only', () => {
    const b = history({ daysAgo: 30 }, { daysAgo: 1 })
    const lines = describePlan(planRetention(b, loose, { now: NOW }))
    assert.equal(lines.length, 2)
    assert.match(lines[0], /^keep {4}2026-11-15 12:00 UTC {2}1\.00 GiB {2}newest, place, last$/)
    assert.match(lines[1], /^remove {2}2026-10-17/)
    assert.ok(lines.every((l) => !l.includes('cid-')))
  })
})

describe('ending data sets after a move to other providers', async () => {
  const { retirePlan } = await import('../retention.mjs')
  const sets = [
    { dataSetId: '1', providerId: '36' },
    { dataSetId: '2', providerId: '37' },
    { dataSetId: '3', providerId: '43' },
    { dataSetId: '4', providerId: '38' },
  ]
  const b = (pieceCid, date, ...dataSetIds) => ({ pieceCid, key: pieceCid, date, copies: dataSetIds.map((dataSetId) => ({ dataSetId })) })

  it('ends nothing while the config names no providers', () => {
    assert.equal(retirePlan(sets, [b('n', 3, '3', '4')], { providerIds: [] }).ready, false)
  })

  it('ends nothing until the newest backup is at the new providers', () => {
    const p = retirePlan(sets, [b('n', 3, '1', '2', '3'), b('o', 1, '1', '2')], { providerIds: [43, 38] })
    assert.equal(p.ready, false)
    assert.deepEqual(p.retire, [])
    assert.equal(p.blocked.length, 2)
  })

  it('ends the old providers’ data sets once the newest backup is at the new ones', () => {
    const p = retirePlan(sets, [b('n', 3, '3', '4'), b('o', 1, '1', '2')], { providerIds: [43, 38] })
    assert.equal(p.ready, true)
    assert.deepEqual(p.retire, [{ dataSetId: '1', providerId: '36', backups: 1 }, { dataSetId: '2', providerId: '37', backups: 1 }])
  })

  it('takes the copies asked for, not every named provider', () => {
    assert.equal(retirePlan(sets, [b('n', 3, '3')], { providerIds: [43, 38], copies: 1 }).ready, true)
    assert.equal(retirePlan(sets, [b('n', 3, '3')], { providerIds: [43, 38] }).ready, false)
  })

  it('never ends a data set with the start backup or an undated one that only it holds', () => {
    const p = retirePlan(sets, [b('n', 3, '3', '4'), b('start', 1, '1'), b('?', null, '2')], { providerIds: [43, 38], protect: ['start'] })
    assert.deepEqual(p.retire, [])
    assert.deepEqual(p.blocked.map((x) => [x.dataSetId, /started from/.test(x.why) ? 'start' : 'undated']), [['1', 'start'], ['2', 'undated']])
    // Once the new providers hold them too, they no longer block.
    assert.equal(retirePlan(sets, [b('n', 3, '3', '4'), b('start', 1, '1', '3')], { providerIds: [43, 38], protect: ['start'] }).retire.length, 2)
  })

  it('ends only the providers asked for, and never one still named', () => {
    const p = retirePlan(sets, [b('n', 3, '3', '4'), b('o', 1, '1', '2')], { providerIds: [43, 38], only: [36] })
    assert.deepEqual(p.retire.map((r) => r.providerId), ['36'])
    assert.equal(retirePlan(sets, [b('n', 3, '3', '4')], { providerIds: [43, 38], only: [43] }).ready, false)
  })
})

describe('snapshots: a generation stays together', () => {
  const G1 = '1111111111111111'
  const G2 = '2222222222222222'
  /** Pieces of one data set: made-up snapshot packs, oldest first. */
  const packs = (specs, startId = 1) =>
    specs.map(([gen, seq, daysAgo], i) => ({ pieceId: BigInt(startId + i), pieceCid: `snap-${gen.slice(0, 1)}-${seq}`, date: NOW - daysAgo * DAY, snapshot: { gen, seq, part: 0, parts: 1 } }))
  const sizeOf = () => 5 * 2 ** 20

  it('groups packs by generation and number, never by size, and counts a copy only with every pack before it', () => {
    const full = packs([[G1, 0, 3], [G1, 1, 2], [G1, 2, 1]])
    const gap = full.filter((p) => p.snapshot.seq !== 1)
    const b = backupsOnChain([{ dataSetId: '1', pieces: full }, { dataSetId: '2', pieces: gap }], { sizeOf, copies: 2 })
    const bySeq = Object.fromEntries(b.map((x) => [x.seq, x]))
    assert.equal(b.length, 3)
    assert.equal(bySeq[0].complete, true, 'pack 0: both data sets can restore it')
    assert.equal(bySeq[2].complete, false, 'pack 2: one data set lacks pack 1')
    assert.equal(bySeq[2].copies.length, 2, 'removal still reaches both data sets')
  })

  it('keeps every pack a kept snapshot builds on, and removes whole old generations', () => {
    const ds = packs([[G1, 0, 60], [G1, 1, 59], [G1, 2, 58], [G2, 0, 20], [G2, 1, 2], [G2, 2, 1]])
    const backups = backupsOnChain([{ dataSetId: '1', pieces: ds }], { sizeOf, copies: 1 })
    const plan = planRetention(backups, { ...loose, keepLast: 1 }, { now: NOW })
    const kept = plan.keep.map((b) => `${b.gen.slice(0, 1)}/${b.seq}`).sort()
    assert.deepEqual(kept, ['2/0', '2/1', '2/2'])
    assert.ok(plan.keep.find((b) => b.seq === 0).reasons.includes('generation'))
    assert.deepEqual(plan.remove.map((b) => `${b.gen.slice(0, 1)}/${b.seq}`).sort(), ['1/0', '1/1', '1/2'])
  })

  it('keeps a whole older generation while a day/week/month pick lies in it', () => {
    const ds = packs([[G1, 0, 10], [G1, 1, 9], [G2, 0, 1]])
    const backups = backupsOnChain([{ dataSetId: '1', pieces: ds }], { sizeOf, copies: 1 })
    const plan = planRetention(backups, { ...loose, keepDays: 14 }, { now: NOW })
    assert.equal(plan.remove.length, 0)
  })

  it('keeps full backups of the old kind while keepLegacy is on, next to snapshots', () => {
    const legacy = [{ pieceId: 1n, pieceCid: 'full-old', date: NOW - 90 * DAY }]
    const ds = [...legacy, ...packs([[G1, 0, 2], [G1, 1, 1]], 2)]
    const backups = backupsOnChain([{ dataSetId: '1', pieces: ds }], { sizeOf, copies: 1 })
    assert.equal(planRetention(backups, { ...loose, keepLegacy: true }, { now: NOW }).remove.length, 0)
    const without = planRetention(backups, { ...loose, keepLegacy: false }, { now: NOW })
    assert.deepEqual(without.remove.map((b) => b.pieceCid), ['full-old'])
  })

  it('a pack in parts is one snapshot', () => {
    const parts = [0, 1].map((part) => ({ pieceId: BigInt(part + 1), pieceCid: `base-${part}`, date: NOW, snapshot: { gen: G1, seq: 0, part, parts: 2 } }))
    const b = backupsOnChain([{ dataSetId: '1', pieces: parts }], { sizeOf, copies: 1 })
    assert.equal(b.length, 1)
    assert.equal(b[0].key, 'base-0 base-1')
    assert.equal(b[0].complete, true)
  })
})
