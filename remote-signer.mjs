// Remote signer: the VM holds no payer and no session key. The Le Space
// treasury pays every data set; a session key of the treasury (the "signer")
// signs each backup step, but only after Le Space Credits has checked it
// (POST {creditsUrl}/v1/backup/sign). The VM holds only its backup key, which
// signs the request: one line that binds the product, the account, the time
// and the exact EIP-712 digest it asks the service to sign.
//
// The account built here stands in for the session key in synapse: it signs
// typed data (CreateDataSet, AddPieces, SchedulePieceRemovals) and nothing
// else.

import { hashTypedData, isAddress, isAddressEqual, recoverTypedDataAddress } from 'viem'
import { privateKeyToAccount, toAccount } from 'viem/accounts'
import { EIP712Types, getStorageDomain } from '@filoz/synapse-core/typed-data'
import { epochToDate } from '@filoz/synapse-core/utils'

/** The signed line's version; the service bumps it when its shape changes. */
export const SIGN_SCHEME = 'ls-backup-sign/v1'
/** The steps the service signs. It never terminates a data set. */
export const KINDS = Object.freeze(['CreateDataSet', 'AddPieces', 'SchedulePieceRemovals'])
/** The only data-set metadata keys the service signs. */
export const DATA_SET_KEYS = Object.freeze(['app', 'customer', 'withIPFSIndexing'])

/** What each refusal of the service means, for the error line. */
const REFUSALS = {
  SIGNATURE: 'the backup key is not (or no longer) authorized for this account; authorize this VM again in the app',
  REPLAY: 'the service saw this request already; retry in a second',
  STALE: "this machine's clock is more than 5 minutes off; fix the time",
  NO_BACKUP: 'no backup paid for now; buy backup months in the app (removing old pieces still works)',
  COPIES: 'the account has its maximum number of data sets (copies); lower "copies" or reuse the existing ones',
  QUOTA: 'the backup quota is full; prune old backups or buy a larger plan',
  METADATA: 'the data set metadata is not the one the service signs (only app = label, customer = tag, optionally withIPFSIndexing; no withCDN)',
  PROVIDER: 'the storage provider is not approved by the storage service',
  DATA_SET: 'that data set does not belong to this account',
  ENDED: 'Le Space ended this data set; it takes no more pieces, and the next run creates a new data set for that provider',
  TERMS: 'the current terms are not accepted; accept them in the app',
}

export class RemoteSignerError extends Error {
  /** @param {string} message @param {{ code?: string, status?: number, cause?: unknown }} [o] */
  constructor(message, { code, status, cause } = {}) {
    super(message, cause ? { cause } : undefined)
    this.name = 'RemoteSignerError'
    this.code = code
    this.status = status
  }
}

/** The line the backup key signs (EIP-191) for one request. */
export const signLine = ({ product, account, timestamp, digest }) =>
  `${SIGN_SCHEME}\n${product}\n${account.toLowerCase()}\n${timestamp}\n${digest}`

/** The message as JSON carries it: bigints as decimal strings. */
export const toWire = (message) => JSON.parse(JSON.stringify(message, (_, v) => (typeof v === 'bigint' ? v.toString() : v)))

/** The digest the service signs: synapse-core's domain and types, nothing else. */
export const digestOf = ({ chain, kind, message }) =>
  hashTypedData({ domain: getStorageDomain({ chain }), types: EIP712Types, primaryType: kind, message })

/** A data set's metadata in remote-signer mode: only what the service signs. */
export function backupMetadata({ label, tag, withIPFSIndexing = false }) {
  return { app: label, customer: tag, ...(withIPFSIndexing ? { withIPFSIndexing: '' } : {}) }
}

/** Is this data set (from findDataSets, owned by the payer) one of this account's backups? */
export const isOwnDataSet = (ds, { label, tag }) => ds?.metadata?.app === label && ds?.metadata?.customer === tag

/**
 * When a data set's storage ends: null while it runs, else its end epoch and
 * that epoch as a date. A data set the payer terminated (pdpEndEpoch != 0)
 * stays live on chain until then, but takes no more pieces.
 */
export function dataSetEnd(ds, chain) {
  const epoch = BigInt(ds?.pdpEndEpoch ?? 0n)
  if (epoch === 0n) return null
  return { epoch, date: epochToDate(Number(epoch), chain.genesisTimestamp) }
}

/**
 * This account's data sets among the payer's (from findDataSets): live on
 * chain and named by label and tag, each with `ended` (see dataSetEnd).
 */
export const ownDataSetsOf = (all, { label, tag, chain }) =>
  all.filter((ds) => ds.isLive && isOwnDataSet(ds, { label, tag })).map((ds) => ({ ...ds, ended: dataSetEnd(ds, chain) }))

/** How list, status and verify name a data set's state. */
export const dataSetState = (ds) => (ds.ended ? `ended ${ds.ended.date.toISOString().slice(0, 10)} (epoch ${ds.ended.epoch})` : 'live')

/** Checks remoteSigner from config.json; returns it with the creditsUrl normalised. */
export function checkConfig(rs) {
  const problems = []
  if (!rs || typeof rs !== 'object') return fail(['remoteSigner must be an object'])
  for (const k of ['account', 'payer', 'signer']) if (!isAddress(rs[k] ?? '')) problems.push(`remoteSigner.${k} is not an address`)
  if (typeof rs.product !== 'string' || !rs.product) problems.push('remoteSigner.product is missing')
  if (!/^[0-9a-f]{32}$/.test(rs.tag ?? '')) problems.push('remoteSigner.tag is not 32 lowercase hex digits')
  if (typeof rs.label !== 'string' || !rs.label) problems.push('remoteSigner.label is missing')
  let url
  try {
    url = new URL(rs.creditsUrl)
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) problems.push('remoteSigner.creditsUrl must be https')
  } catch {
    problems.push('remoteSigner.creditsUrl is not a URL')
  }
  if (problems.length) return fail(problems)
  return { ...rs, creditsUrl: url.toString().replace(/\/+$/, '') }

  function fail(list) {
    throw new RemoteSignerError(list.join('\n'), { code: 'CONFIG' })
  }
}

/** The backup key from its file: 0x + 64 hex digits (the 0x may be left out). */
export function parseBackupKey(raw) {
  const key = String(raw ?? '').trim()
  const hex = key.startsWith('0x') ? key : `0x${key}`
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) throw new RemoteSignerError('BACKUP_KEY_FILE does not hold a 32-byte hex private key', { code: 'CONFIG' })
  return hex
}

/**
 * The signer as a viem account: address = the treasury's session key; its
 * signTypedData asks the service.
 *
 * @param {{
 *   chain: any, creditsUrl: string, product: string, account: string,
 *   signer: string, payer: string, backupKey: `0x${string}`,
 *   fetch?: typeof fetch, now?: () => number, log?: (...a: any[]) => void
 * }} o
 */
export function createRemoteSigner({ chain, creditsUrl, product, account, signer, payer, backupKey, fetch: doFetch = globalThis.fetch, now = () => Date.now(), log }) {
  const backup = privateKeyToAccount(backupKey)
  const endpoint = `${creditsUrl.replace(/\/+$/, '')}/v1/backup/sign`

  // The service takes one request per backup key and second (its replay
  // guard keys on the timestamp), so requests go one at a time, each with a
  // later second than the one before.
  let queue = Promise.resolve()
  let lastTimestamp = 0
  const nextTimestamp = async () => {
    let t = Math.floor(now() / 1000)
    while (t <= lastTimestamp) {
      await new Promise((r) => setTimeout(r, 1000 - (now() % 1000) + 5))
      t = Math.floor(now() / 1000)
    }
    lastTimestamp = t
    return t
  }

  async function ask({ domain, types, primaryType, message }) {
    if (!KINDS.includes(primaryType)) throw new RemoteSignerError(`the remote signer signs no ${primaryType}`, { code: 'KIND' })
    const digest = digestOf({ chain, kind: primaryType, message })
    // What synapse asked to sign must be what the service will sign: same
    // domain (no other verifyingContract), same types.
    const { EIP712Domain: _, ...askedTypes } = types ?? {}
    const asked = hashTypedData({ domain, types: askedTypes, primaryType, message })
    if (asked !== digest) throw new RemoteSignerError(`the ${primaryType} request differs from the storage service's domain or types`, { code: 'DOMAIN' })

    const timestamp = await nextTimestamp()
    const signature = await backup.signMessage({ message: signLine({ product, account, timestamp, digest }) })
    const body = { product, account, kind: primaryType, message: toWire(message), timestamp, signature }

    let res
    try {
      res = await doFetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    } catch (err) {
      throw new RemoteSignerError(`remote signer ${new URL(endpoint).host} unreachable`, { code: 'NETWORK', cause: err })
    }
    let out = null
    try {
      out = await res.json()
    } catch {}
    if (!res.ok) {
      const code = out?.code ?? 'HTTP'
      const said = out?.error ?? res.statusText ?? ''
      const hint = REFUSALS[code]
      throw new RemoteSignerError(`remote signer refused ${primaryType}: ${code} (HTTP ${res.status}) ${said}${hint ? ` – ${hint}` : ''}`.trim(), { code, status: res.status })
    }
    if (!out || typeof out.signature !== 'string') throw new RemoteSignerError('remote signer answered without a signature', { code: 'ANSWER' })
    if (String(out.digest ?? '').toLowerCase() !== digest.toLowerCase()) throw new RemoteSignerError(`remote signer signed another digest than ${primaryType} asked for`, { code: 'DIGEST' })
    if (!isAddress(out.signer ?? '', { strict: false }) || !isAddressEqual(out.signer, signer)) throw new RemoteSignerError(`remote signer answered as ${out.signer}, not the configured signer`, { code: 'SIGNER' })
    if (!isAddress(out.payer ?? '', { strict: false }) || !isAddressEqual(out.payer, payer)) throw new RemoteSignerError(`remote signer answered for payer ${out.payer}, not the configured payer`, { code: 'PAYER' })
    const recovered = await recoverTypedDataAddress({ domain: getStorageDomain({ chain }), types: EIP712Types, primaryType, message, signature: out.signature }).catch(() => null)
    if (!recovered || !isAddressEqual(recovered, signer)) throw new RemoteSignerError('the remote signature is not by the configured signer', { code: 'SIGNER' })
    log?.(`remote signer signed ${primaryType}`)
    return out.signature
  }

  const signer_ = toAccount({
    address: signer,
    async signMessage() {
      throw new RemoteSignerError('the remote signer signs typed data only', { code: 'KIND' })
    },
    async signTransaction() {
      throw new RemoteSignerError('the remote signer signs typed data only', { code: 'KIND' })
    },
    signTypedData(params) {
      const run = queue.then(() => ask(params))
      queue = run.catch(() => {})
      return run
    },
  })
  return Object.assign(signer_, { backupAddress: backup.address })
}

/** The payer as an account that never signs: the treasury's own key is not here. */
export function payerAccount(payer) {
  const refuse = async () => {
    throw new RemoteSignerError('the payer signs nothing on this machine (remote-signer mode)', { code: 'PAYER' })
  }
  return toAccount({ address: payer, signMessage: refuse, signTransaction: refuse, signTypedData: refuse })
}
