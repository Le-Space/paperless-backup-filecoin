// The remote signer against a mocked POST /v1/backup/sign that checks each
// request as Le Space Credits does (src/lib/server/backup.js): the same
// normalised message, the same EIP-712 digest, the backup key's EIP-191
// signature over the same line, the time window and the replay guard. Keys,
// addresses and tags are made up; nothing goes on chain.
//
//   node --test test/

import { strict as assert } from 'node:assert'
import { createServer } from 'node:http'
import { after, before, beforeEach, describe, it } from 'node:test'
import { createClient, decodeAbiParameters, http, recoverMessageAddress, recoverTypedDataAddress } from 'viem'
import { privateKeyToAccount, signTypedData } from 'viem/accounts'
import { calibration } from '@filoz/synapse-core/chains'
import * as Piece from '@filoz/synapse-core/piece'
import { EIP712Types, getStorageDomain, signAddPieces, signCreateDataSet, signCreateDataSetAbiParameters, signSchedulePieceRemovals } from '@filoz/synapse-core/typed-data'
import { backupMetadata, checkConfig, createRemoteSigner, digestOf, isOwnDataSet, signLine } from '../remote-signer.mjs'

const PRODUCT = 'paperless-anywhere'
const ACCOUNT = '0x00000000000000000000000000000000000000aa'
const PAYER = '0x00000000000000000000000000000000000000cc'
const PROVIDER = '0x00000000000000000000000000000000000000dd'
const OTHER_PROVIDER = '0x00000000000000000000000000000000000000ee'
const BACKUP_KEY = `0x${'33'.repeat(32)}`
const OTHER_KEY = `0x${'44'.repeat(32)}`
const SIGNER_KEY = `0x${'22'.repeat(32)}`
const SIGNER = privateKeyToAccount(SIGNER_KEY).address
const TAG = '0123456789abcdef0123456789abcdef'
const LABEL = 'paperless-backup-test'
const QUOTA = 32n * 2n ** 30n
const WINDOW_S = 300
const chain = calibration
const domain = getStorageDomain({ chain })

// --- the mock service ----------------------------------------------------------

class Refusal extends Error {
  constructor(message, status, code) {
    super(message)
    this.status = status
    this.code = code
  }
}

const big = (v) => {
  if ((typeof v === 'string' && /^(0x[0-9a-fA-F]+|\d+)$/.test(v)) || Number.isSafeInteger(v)) return BigInt(v)
  throw new Refusal('not a whole number', 400, 'MESSAGE')
}
const entries = (list) => {
  if (!Array.isArray(list) || list.length > 16) throw new Refusal('metadata is not a short list', 400, 'MESSAGE')
  return list.map((e) => {
    if (typeof e?.key !== 'string' || typeof e?.value !== 'string') throw new Refusal('metadata entry is not key and value', 400, 'MESSAGE')
    return { key: e.key, value: e.value }
  })
}
const hexString = (v) => {
  if (typeof v !== 'string' || !/^0x([0-9a-fA-F]{2})+$/.test(v)) throw new Refusal('not hex', 400, 'MESSAGE')
  return v
}

// As the service's normalize(): the typed message from JSON, anything else refused.
function normalize(kind, m) {
  if (!m || typeof m !== 'object') throw new Refusal('message missing', 400, 'MESSAGE')
  if (kind === 'CreateDataSet') {
    if (typeof m.payee !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(m.payee)) throw new Refusal('payee is not an address', 400, 'MESSAGE')
    return { clientDataSetId: big(m.clientDataSetId), payee: m.payee.toLowerCase(), metadata: entries(m.metadata) }
  }
  if (kind === 'AddPieces') {
    if (!Array.isArray(m.pieceData) || !m.pieceData.length || m.pieceData.length > 64) throw new Refusal('pieceData is not a short list', 400, 'MESSAGE')
    if (!Array.isArray(m.pieceMetadata) || m.pieceMetadata.length > m.pieceData.length) throw new Refusal('pieceMetadata does not fit the pieces', 400, 'MESSAGE')
    return {
      clientDataSetId: big(m.clientDataSetId),
      nonce: big(m.nonce),
      pieceData: m.pieceData.map((p) => ({ data: hexString(p?.data) })),
      pieceMetadata: m.pieceMetadata.map((p) => ({ pieceIndex: big(p?.pieceIndex), metadata: entries(p?.metadata) })),
    }
  }
  if (!Array.isArray(m.pieceIds) || !m.pieceIds.length || m.pieceIds.length > 256) throw new Refusal('pieceIds is not a short list', 400, 'MESSAGE')
  return { clientDataSetId: big(m.clientDataSetId), pieceIds: m.pieceIds.map(big) }
}

const fromHex = (h) => Uint8Array.from(h.replace(/^0x/, '').match(/../g) ?? [], (x) => parseInt(x, 16))

function mockService({ now }) {
  const state = {
    paid: true,
    terms: true,
    keys: new Set([privateKeyToAccount(BACKUP_KEY).address.toLowerCase()]),
    dataSets: [], // client data set ids (strings) of ACCOUNT
    stored: new Map(),
    seen: new Set(),
    requests: [],
    tamper: null, // 'digest' | 'signer' | 'payer'
  }
  async function sign(r) {
    if (r.product !== PRODUCT) throw new Refusal('this product sells no backup', 409, 'NO_BACKUP')
    if (typeof r.account !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(r.account)) throw new Refusal('account is not an address', 400, 'ADDRESS')
    const kind = ['CreateDataSet', 'AddPieces', 'SchedulePieceRemovals'].find((k) => k === r.kind)
    if (!kind) throw new Refusal('unknown kind', 400, 'KIND')
    const message = normalize(kind, r.message)
    const digest = digestOf({ chain, kind, message })
    const timestamp = Number(r.timestamp)
    if (!Number.isFinite(timestamp)) throw new Refusal('timestamp missing', 401, 'TIMESTAMP')
    if (Math.abs(now() / 1000 - timestamp) > WINDOW_S) throw new Refusal('timestamp outside the window', 401, 'STALE')
    const sig = String(r.signature ?? '')
    const key = /^0x[0-9a-fA-F]{130}$/.test(sig) ? await recoverMessageAddress({ message: signLine({ product: r.product, account: r.account, timestamp, digest }), signature: sig }).catch(() => null) : null
    if (!key || r.account.toLowerCase() !== ACCOUNT.toLowerCase() || !state.keys.has(key.toLowerCase())) throw new Refusal('not a backup key of this account', 401, 'SIGNATURE')
    const seen = `${key.toLowerCase()}:${timestamp}`
    if (state.seen.has(seen)) throw new Refusal('replayed request', 401, 'REPLAY')
    state.seen.add(seen)
    const own = (id) => state.dataSets.includes(id.toString())
    if (kind !== 'SchedulePieceRemovals') {
      if (!state.terms) throw new Refusal('terms not accepted', 412, 'TERMS')
      if (!state.paid) throw new Refusal('no backup paid for now', 409, 'NO_BACKUP')
    }
    if (kind === 'CreateDataSet') {
      const meta = new Map(message.metadata.map((e) => [e.key, e.value]))
      if (meta.size !== message.metadata.length || [...meta.keys()].some((k) => !['app', 'customer', 'withIPFSIndexing'].includes(k))) throw new Refusal('metadata has unknown or repeated keys', 400, 'METADATA')
      if (meta.get('app') !== LABEL || meta.get('customer') !== TAG) throw new Refusal('metadata does not name this backup', 400, 'METADATA')
      if (!own(message.clientDataSetId) && state.dataSets.length >= 3) throw new Refusal('at most 3 data sets', 409, 'COPIES')
      if (message.payee !== PROVIDER.toLowerCase()) throw new Refusal('payee is not an approved provider', 400, 'PROVIDER')
      if (!own(message.clientDataSetId)) state.dataSets.push(message.clientDataSetId.toString())
    } else {
      if (!own(message.clientDataSetId)) throw new Refusal('not a data set of this account', 403, 'DATA_SET')
      if (kind === 'AddPieces') {
        const adding = message.pieceData.reduce((n, p) => n + Piece.tryFrom(fromHex(p.data)).paddedSize, 0n)
        const used = state.stored.get(message.clientDataSetId.toString()) ?? 0n
        if (used + adding > QUOTA) throw new Refusal('backup quota reached', 409, 'QUOTA')
      }
    }
    const signature = await signTypedData({ privateKey: state.tamper === 'signer' ? OTHER_KEY : SIGNER_KEY, domain, types: EIP712Types, primaryType: kind, message })
    const out = { signature, signer: SIGNER, payer: PAYER, digest }
    if (state.tamper === 'digest') out.digest = `0x${'ab'.repeat(32)}`
    if (state.tamper === 'payer') out.payer = ACCOUNT
    if (state.tamper === 'signer') out.signer = SIGNER
    return out
  }
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    let status = 200
    let out
    try {
      if (req.method !== 'POST' || req.url !== '/v1/backup/sign') throw new Refusal('not found', 404, 'NOT_FOUND')
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      state.requests.push(body)
      out = await sign(body)
    } catch (e) {
      status = e.status ?? 500
      out = { error: e.message, code: e.code ?? 'INTERNAL' }
    }
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(out))
  })
  return { state, server }
}

// --- helpers -----------------------------------------------------------------

let clock
const now = () => clock
const tick = () => (clock += 1000)
let service
let url

before(async () => {
  clock = Date.parse('2026-11-09T10:00:00Z')
  service = mockService({ now })
  await new Promise((r) => service.server.listen(0, '127.0.0.1', r))
  url = `http://127.0.0.1:${service.server.address().port}`
})
after(() => new Promise((r) => service.server.close(r)))
beforeEach(() => {
  Object.assign(service.state, { paid: true, terms: true, dataSets: [], stored: new Map(), seen: new Set(), requests: [], tamper: null })
})

// The VM's clock moves a second per request, so tests need not wait.
const remote = (o = {}) =>
  createRemoteSigner({ chain, creditsUrl: url, product: PRODUCT, account: ACCOUNT, signer: SIGNER, payer: PAYER, backupKey: BACKUP_KEY, now: () => tick(), ...o })

// A synapse-like client: synapse-core's own sign functions call this account.
const clientOf = (account) => createClient({ chain, transport: http('http://127.0.0.1:9'), account })

const metadataEntries = Object.entries(backupMetadata({ label: LABEL, tag: TAG })).map(([key, value]) => ({ key, value }))

async function pieceCid(bytes = 1024) {
  return Piece.calculate(new Uint8Array(bytes).fill(7))
}

// --- tests -------------------------------------------------------------------

describe('remote signer', () => {
  it('CreateDataSet: one round-trip, extraData names the payer, signature by the signer', async () => {
    const extraData = await signCreateDataSet(clientOf(remote()), { clientDataSetId: 7n, payee: PROVIDER, payer: PAYER, metadata: metadataEntries })
    const [payer, clientDataSetId, keys, values, signature] = decodeAbiParameters(signCreateDataSetAbiParameters, extraData)
    assert.equal(payer.toLowerCase(), PAYER)
    assert.equal(clientDataSetId, 7n)
    assert.deepEqual(keys, ['app', 'customer'])
    assert.deepEqual(values, [LABEL, TAG])
    const recovered = await recoverTypedDataAddress({ domain, types: EIP712Types, primaryType: 'CreateDataSet', message: { clientDataSetId: 7n, payee: PROVIDER, metadata: metadataEntries }, signature })
    assert.equal(recovered, SIGNER)
    assert.equal(service.state.requests.length, 1)
    const [req] = service.state.requests
    assert.equal(req.kind, 'CreateDataSet')
    assert.equal(req.account, ACCOUNT)
    assert.equal(req.product, PRODUCT)
    assert.equal(req.message.clientDataSetId, '7', 'bigints travel as decimal strings')
    assert.deepEqual(service.state.dataSets, ['7'])
  })

  it('AddPieces: one round-trip for an own data set', async () => {
    service.state.dataSets.push('7')
    const piece = await pieceCid()
    const extraData = await signAddPieces(clientOf(remote()), { clientDataSetId: 7n, nonce: 5n, pieces: [{ pieceCid: piece, metadata: [] }] })
    assert.match(extraData, /^0x[0-9a-f]+$/)
    assert.equal(service.state.requests.length, 1)
    assert.equal(service.state.requests[0].kind, 'AddPieces')
    assert.equal(service.state.requests[0].message.nonce, '5')
  })

  it('SchedulePieceRemovals: one round-trip, also when no backup is paid', async () => {
    service.state.dataSets.push('7')
    service.state.paid = false
    const extraData = await signSchedulePieceRemovals(clientOf(remote()), { clientDataSetId: 7n, pieceIds: [1n, 2n] })
    const [signature] = decodeAbiParameters([{ type: 'bytes' }], extraData)
    const recovered = await recoverTypedDataAddress({ domain, types: EIP712Types, primaryType: 'SchedulePieceRemovals', message: { clientDataSetId: 7n, pieceIds: [1n, 2n] }, signature })
    assert.equal(recovered, SIGNER)
    assert.deepEqual(service.state.requests[0].message.pieceIds, ['1', '2'])
  })

  it('rejects an answer whose digest differs from the local one', async () => {
    service.state.tamper = 'digest'
    await assert.rejects(signCreateDataSet(clientOf(remote()), { clientDataSetId: 7n, payee: PROVIDER, payer: PAYER, metadata: metadataEntries }), { name: 'RemoteSignerError', code: 'DIGEST' })
  })

  it('rejects an answer from another signer or for another payer', async () => {
    service.state.tamper = 'signer'
    await assert.rejects(signCreateDataSet(clientOf(remote()), { clientDataSetId: 7n, payee: PROVIDER, payer: PAYER, metadata: metadataEntries }), { code: 'SIGNER' })
    service.state.tamper = 'payer'
    await assert.rejects(signCreateDataSet(clientOf(remote()), { clientDataSetId: 8n, payee: PROVIDER, payer: PAYER, metadata: metadataEntries }), { code: 'PAYER' })
  })

  it('surfaces a 409 refusal with its code and the service message', async () => {
    service.state.paid = false
    await assert.rejects(signCreateDataSet(clientOf(remote()), { clientDataSetId: 7n, payee: PROVIDER, payer: PAYER, metadata: metadataEntries }), (err) => {
      assert.equal(err.code, 'NO_BACKUP')
      assert.equal(err.status, 409)
      assert.match(err.message, /NO_BACKUP \(HTTP 409\) no backup paid for now/)
      return true
    })
    service.state.paid = true
    service.state.dataSets.push('1', '2', '3')
    await assert.rejects(signCreateDataSet(clientOf(remote()), { clientDataSetId: 9n, payee: PROVIDER, payer: PAYER, metadata: metadataEntries }), { code: 'COPIES', status: 409 })
  })

  it('surfaces the other refusals: metadata, provider, data set, signature, stale', async () => {
    const withCdn = [...metadataEntries, { key: 'withCDN', value: '' }]
    await assert.rejects(signCreateDataSet(clientOf(remote()), { clientDataSetId: 7n, payee: PROVIDER, payer: PAYER, metadata: withCdn }), { code: 'METADATA', status: 400 })
    await assert.rejects(signCreateDataSet(clientOf(remote()), { clientDataSetId: 7n, payee: OTHER_PROVIDER, payer: PAYER, metadata: metadataEntries }), { code: 'PROVIDER', status: 400 })
    await assert.rejects(signSchedulePieceRemovals(clientOf(remote()), { clientDataSetId: 99n, pieceIds: [1n] }), { code: 'DATA_SET', status: 403 })
    await assert.rejects(signSchedulePieceRemovals(clientOf(remote({ backupKey: OTHER_KEY })), { clientDataSetId: 99n, pieceIds: [1n] }), { code: 'SIGNATURE', status: 401 })
    await assert.rejects(signSchedulePieceRemovals(clientOf(remote({ now: () => clock - 3600_000 })), { clientDataSetId: 99n, pieceIds: [1n] }), { code: 'STALE', status: 401 })
  })

  it('signs typed data only, and only with the storage domain', async () => {
    const account = remote()
    await assert.rejects(account.signMessage({ message: 'hello' }), { code: 'KIND' })
    await assert.rejects(account.signTransaction({}), { code: 'KIND' })
    await assert.rejects(signAddPieces(clientOf(account), { clientDataSetId: 7n, nonce: 1n, pieces: [{ pieceCid: await pieceCid(), metadata: [] }], verifyingContract: OTHER_PROVIDER }), { code: 'DOMAIN' })
    assert.equal(service.state.requests.length, 0, 'nothing was sent')
  })

  it('sends concurrent steps one at a time, each in its own second (the replay guard)', async () => {
    service.state.dataSets.push('7')
    // A clock that moves only with real time: the second request must wait.
    const base = Date.now()
    const account = remote({ now: () => clock + (Date.now() - base) })
    const client = clientOf(account)
    await Promise.all([signSchedulePieceRemovals(client, { clientDataSetId: 7n, pieceIds: [1n] }), signSchedulePieceRemovals(client, { clientDataSetId: 7n, pieceIds: [2n] })])
    const [a, b] = service.state.requests.map((r) => r.timestamp)
    assert.notEqual(a, b)
  })
})

describe('config and data sets', () => {
  const good = { creditsUrl: 'https://credits.example.com/', product: PRODUCT, account: ACCOUNT, payer: PAYER, signer: SIGNER, tag: TAG, label: LABEL }

  it('accepts a complete remoteSigner and trims the URL', () => {
    assert.equal(checkConfig(good).creditsUrl, 'https://credits.example.com')
  })

  it('refuses plain http to another host, a bad tag and a missing address', () => {
    assert.throws(() => checkConfig({ ...good, creditsUrl: 'http://credits.example.com' }), /must be https/)
    assert.throws(() => checkConfig({ ...good, tag: 'XYZ' }), /tag/)
    assert.throws(() => checkConfig({ ...good, payer: undefined }), /payer/)
  })

  it('metadata holds only app and customer (and withIPFSIndexing on request), never withCDN', () => {
    assert.deepEqual(backupMetadata({ label: LABEL, tag: TAG }), { app: LABEL, customer: TAG })
    assert.deepEqual(backupMetadata({ label: LABEL, tag: TAG, withIPFSIndexing: true }), { app: LABEL, customer: TAG, withIPFSIndexing: '' })
  })

  it('an own data set names this label and tag', () => {
    assert.ok(isOwnDataSet({ metadata: { app: LABEL, customer: TAG } }, { label: LABEL, tag: TAG }))
    assert.ok(!isOwnDataSet({ metadata: { app: LABEL, customer: 'f'.repeat(32) } }, { label: LABEL, tag: TAG }))
    assert.ok(!isOwnDataSet({ metadata: { app: 'paperless-backup', customer: TAG } }, { label: LABEL, tag: TAG }))
  })
})
