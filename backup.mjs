#!/usr/bin/env node
// Encrypted Paperless backup to Filecoin Onchain Cloud.
//
// The Paperless export (documents + database) is encrypted with age on this
// machine and uploaded as one piece to several independent storage providers,
// chosen by id or by region and number of copies (config.json).
// Secrets: the macOS keychain, or files named by WALLET_KEY_FILE / AGE_IDENTITY_FILE.
//
//   node backup.mjs init-key        create the age identity (once)
//   node backup.mjs providers       approved providers, their location, region check
//   node backup.mjs status          wallet, deposit, readiness
//   node backup.mjs fund [months]   deposit USDFC and approve the storage service
//   node backup.mjs plan            export + encrypt, show size and cost, no upload
//   node backup.mjs run             export + encrypt + upload
//   node backup.mjs list            what the ledger holds
//   node backup.mjs verify          is every copy still in its data set?
//   node backup.mjs restore <pieceCid> [out.zip]
//   node backup.mjs prune --yes     delete pieces older than keepWeeks

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { platform } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Decrypter, Encrypter, generateX25519Identity, identityToRecipient } from 'age-encryption'
import { Synapse, calibration, formatUnits, mainnet } from '@filoz/synapse-sdk'
import { getPDPProvidersByIds } from '@filoz/synapse-core/sp-registry'
import { getApprovedProviderIds } from '@filoz/synapse-core/warm-storage'
import { getEndorsedProviderIds } from '@filoz/synapse-core/endorsements'
import { createPublicClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

const HERE = dirname(fileURLToPath(import.meta.url))
const PAPERLESS = process.env.PAPERLESS_DIR ?? join(HERE, '..')
const PAPERLESS_SERVICE = process.env.PAPERLESS_SERVICE ?? 'webserver'
const EXPORT_DIR = join(PAPERLESS, 'export')
const CONFIG_PATH = process.env.BACKUP_CONFIG ?? join(HERE, 'config.json')
const LEDGER_PATH = join(HERE, 'ledger.json')
const KEYCHAIN = {
  wallet: 'paperless-backup-filecoin-wallet',
  identity: 'paperless-backup-age-identity',
}
const MAX_UPLOAD = 68_182_605_824 // 64 GiB padded, the PDP limit
const EU = ['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE']
const EEA = [...EU, 'IS', 'LI', 'NO']
const REGION_PRESETS = { EU, EEA, EUROPE: [...EEA, 'GB', 'CH'] }
const DAY = 24 * 60 * 60 * 1000

if (!existsSync(CONFIG_PATH)) {
  console.error(`error: no ${CONFIG_PATH}; copy config.example.json to config.json`)
  process.exit(1)
}
const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
const chain = config.network === 'calibration' ? calibration : mainnet

function log(...args) {
  console.log(new Date().toISOString(), ...args)
}

function fail(message) {
  console.error(`error: ${message}`)
  process.exit(1)
}

// --- secrets ----------------------------------------------------------------

function keychainRead(service) {
  if (platform() !== 'darwin') return null
  try {
    return execFileSync('security', ['find-generic-password', '-s', service, '-a', process.env.USER, '-w'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return null
  }
}

function walletKey() {
  const fromFile = process.env.WALLET_KEY_FILE
  const key = fromFile ? readFileSync(fromFile, 'utf8').trim() : keychainRead(KEYCHAIN.wallet)
  if (!key) {
    fail(
      `no wallet key. On macOS store it with a hidden prompt:\n` +
        `  security add-generic-password -s ${KEYCHAIN.wallet} -a "$USER" -w\n` +
        `elsewhere point WALLET_KEY_FILE at a file readable only by you`,
    )
  }
  return key.startsWith('0x') ? key : `0x${key}`
}

function ageIdentity() {
  const fromFile = process.env.AGE_IDENTITY_FILE
  if (fromFile) return readFileSync(fromFile, 'utf8').split('\n').find((l) => l.startsWith('AGE-SECRET-KEY-'))
  const id = keychainRead(KEYCHAIN.identity)
  if (!id) fail(`no age identity: run init-key, or set AGE_IDENTITY_FILE`)
  return id
}

// --- ledger -----------------------------------------------------------------

function readLedger() {
  return existsSync(LEDGER_PATH) ? JSON.parse(readFileSync(LEDGER_PATH, 'utf8')) : []
}

function writeLedger(entries) {
  writeFileSync(LEDGER_PATH, JSON.stringify(entries, null, 2) + '\n')
}

const jsonable = (value) => JSON.parse(JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? String(v) : v)))

// --- chain ------------------------------------------------------------------

function synapse() {
  const account = privateKeyToAccount(walletKey())
  return Object.assign(Synapse.create({ account, chain, source: 'paperless-backup' }), { address: account.address })
}

async function chosenContexts(s) {
  const ids = (await resolveProviders()).map((p) => BigInt(p.id))
  return s.storage.createContexts({ providerIds: ids, metadata: config.datasetMetadata })
}

function regionCodes() {
  const regions = [config.regions ?? []].flat()
  return regions.flatMap((r) => REGION_PRESETS[String(r).toUpperCase()] ?? [String(r).toUpperCase()])
}

const inRegion = (p) => !regionCodes().length || regionCodes().includes(p.country)

function operatorOf(url) {
  try {
    return new URL(url).hostname.split('.').slice(-2).join('.')
  } catch {
    return null
  }
}

function countryOf(location) {
  return /(?:^|;)C=([A-Z]{2})/i.exec(location ?? '')?.[1]?.toUpperCase() ?? null
}

async function approvedProviders() {
  const client = createPublicClient({ chain, transport: http() })
  const ids = []
  let cursor
  do {
    const page = await getApprovedProviderIds(client, cursor === undefined ? {} : { cursor })
    ids.push(...page.items)
    cursor = page.nextCursor
  } while (cursor !== undefined && cursor !== null)
  const endorsed = new Set([...(await getEndorsedProviderIds(client))].map(Number))
  const providers = await getPDPProvidersByIds(client, { providerIds: ids })
  return providers.map((p) => ({
    endorsed: endorsed.has(Number(p.id)),
    id: Number(p.id),
    name: p.name,
    location: p.pdp?.location ?? '',
    country: countryOf(p.pdp?.location),
    active: p.isActive,
    serviceURL: p.pdp?.serviceURL,
    operator: operatorOf(p.pdp?.serviceURL),
  }))
}

// Named providers must still be approved, active and inside the regions; without
// names, the first `copies` approved providers in the regions are taken, endorsed
// ones first. Either way the backup stops rather than land somewhere else.
let resolved
async function resolveProviders() {
  if (resolved) return resolved
  const approved = await approvedProviders()
  if (config.providerIds?.length) {
    const byId = new Map(approved.map((p) => [p.id, p]))
    const problems = []
    for (const id of config.providerIds) {
      const p = byId.get(id)
      if (!p) problems.push(`provider ${id} is not (or no longer) approved`)
      else if (!p.active) problems.push(`provider ${id} (${p.name}) is not active`)
      else if (!inRegion(p)) problems.push(`provider ${id} (${p.name}) declares ${p.location || 'no location'}, outside the configured regions`)
    }
    if (problems.length) fail(problems.join('\n'))
    resolved = config.providerIds.map((id) => byId.get(id))
  } else {
    const copies = config.copies ?? 2
    const candidates = approved.filter((p) => p.active && inRegion(p)).sort((a, b) => b.endorsed - a.endorsed || a.id - b.id)
    if (candidates.length < copies) fail(`${copies} copies wanted, but only ${candidates.length} approved provider(s) in the regions: ${candidates.map((p) => p.id).join(', ') || 'none'}`)
    // One copy per operator first (operator = the provider's domain), then per
    // country, then whatever is left.
    const picked = []
    for (const p of candidates) if (!picked.some((q) => q.operator === p.operator)) picked.push(p)
    for (const p of candidates) if (!picked.includes(p) && !picked.some((q) => q.country === p.country)) picked.push(p)
    for (const p of candidates) if (!picked.includes(p)) picked.push(p)
    resolved = picked.slice(0, copies)
  }
  return resolved
}

// --- export + encryption ----------------------------------------------------

function exportPaperless(name) {
  log('exporting Paperless …')
  execFileSync(
    'docker',
    ['compose', 'exec', '-T', '-u', 'paperless', PAPERLESS_SERVICE, 'document_exporter', '../export', '-z', '-zn', name, '--use-filename-format', '--no-thumbnail', '--no-progress-bar'],
    { cwd: PAPERLESS, stdio: ['ignore', 'ignore', 'inherit'] },
  )
  const zip = join(EXPORT_DIR, `${name}.zip`)
  if (!existsSync(zip)) fail(`export did not produce ${zip}`)
  return zip
}

// The plain export holds every document and the mail credentials, so it lives
// only as long as the encryption takes.
async function encryptedExport() {
  if (!config.ageRecipient) fail('no ageRecipient in config.json; run: node backup.mjs init-key')
  const name = `paperless-${new Date().toISOString().slice(0, 10)}`
  const zip = exportPaperless(name)
  try {
    const plain = readFileSync(zip)
    const e = new Encrypter()
    e.addRecipient(config.ageRecipient)
    const sealed = await e.encrypt(plain)
    if (sealed.byteLength > MAX_UPLOAD) fail(`encrypted export is ${sealed.byteLength} bytes, above the 64 GiB limit`)
    return {
      name,
      sealed,
      plainBytes: plain.byteLength,
      plainSha256: createHash('sha256').update(plain).digest('hex'),
      sealedSha256: createHash('sha256').update(sealed).digest('hex'),
    }
  } finally {
    rmSync(zip, { force: true })
  }
}

// --- commands ---------------------------------------------------------------

async function initKey() {
  const file = process.env.AGE_IDENTITY_FILE
  if (!file && platform() !== 'darwin') fail('outside macOS set AGE_IDENTITY_FILE to where the identity should be written')
  if (file ? existsSync(file) : keychainRead(KEYCHAIN.identity)) fail('an age identity already exists; refusing to replace it')
  const identity = await generateX25519Identity()
  if (file) writeFileSync(file, identity + '\n', { mode: 0o600 })
  else execFileSync('security', ['add-generic-password', '-s', KEYCHAIN.identity, '-a', process.env.USER, '-w', identity], { stdio: 'ignore' })
  config.ageRecipient = await identityToRecipient(identity)
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n')
  log(`age identity stored ${file ? `in ${file}` : `in the keychain (${KEYCHAIN.identity})`}; recipient written to config.json`)
  log('Keep a second copy of the identity somewhere else, or no restore is possible after losing this machine.')
  if (!file) log(`  security find-generic-password -s ${KEYCHAIN.identity} -a "$USER" -w`)
}

async function providers() {
  const list = await approvedProviders()
  const chosen = new Set((await resolveProviders()).map((p) => p.id))
  for (const p of list.sort((a, b) => a.id - b.id)) {
    console.log(
      [String(p.id).padStart(3), chosen.has(p.id) ? 'chosen' : '      ', inRegion(p) ? 'region' : '      ', p.endorsed ? 'endorsed' : 'approved', p.active ? 'active' : 'off   ', p.location, p.name].join(' | '),
    )
  }
}

async function status() {
  const s = synapse()
  const wallet = await s.payments.walletBalance()
  const deposit = await s.payments.balance()
  log(`network ${chain.name}, account ${s.address}`)
  log(`USDFC in wallet ${formatUnits(wallet)}, available in Filecoin Pay ${formatUnits(deposit)}`)
  const { costs, transaction } = await s.storage.prepare({ context: await chosenContexts(s), pieceSizes: [1n << 30n] })
  log(`for 1 GiB on providers ${(await resolveProviders()).map((p) => p.id).join(', ')}: ${formatUnits(costs.rates.perMonth)} USDFC per month`)
  log(transaction ? `not ready: deposit ${formatUnits(transaction.depositAmount)} USDFC needed (node backup.mjs fund)` : 'ready to upload')
}

async function fund(months = 3) {
  const s = synapse()
  const contexts = await chosenContexts(s)
  const { costs, transaction } = await s.storage.prepare({
    context: contexts,
    pieceSizes: [2n << 30n],
    extraRunwayEpochs: BigInt(months) * 86_400n,
  })
  log(`rate ${formatUnits(costs.rates.perMonth)} USDFC per month for 2 GiB on ${contexts.length} providers`)
  if (!transaction) return log('already funded and approved')
  log(`depositing ${formatUnits(transaction.depositAmount)} USDFC${transaction.includesApproval ? ' and approving the storage service' : ''} …`)
  const { hash } = await transaction.execute()
  log(`confirmed: ${hash}`)
}

async function plan() {
  const chosen = await resolveProviders()
  const { name, sealed, plainSha256 } = await encryptedExport()
  // Prove the keychain identity opens what the recipient sealed, before anything leaves this Mac.
  const d = new Decrypter()
  d.addIdentity(ageIdentity())
  const reopened = createHash('sha256').update(await d.decrypt(sealed)).digest('hex')
  if (reopened !== plainSha256) fail('decryption check failed: the keychain identity does not open the backup')
  log('decryption check: ok')
  const gib = sealed.byteLength / 2 ** 30
  const perCopy = (sealed.byteLength / 2 ** 40) * 2.5 + 0.12
  log(`${name}: ${sealed.byteLength} bytes encrypted (${gib.toFixed(2)} GiB)`)
  log(`providers: ${chosen.map((p) => `${p.id} ${p.name} (${p.location})`).join('; ')}`)
  log(`estimate: ~${(perCopy * chosen.length).toFixed(3)} USD per month for ${chosen.length} copies (one piece; each further kept week adds the storage part)`)
}

async function run() {
  const chosen = await resolveProviders()
  const s = synapse()
  const contexts = await chosenContexts(s)
  const backup = await encryptedExport()
  const { transaction } = await s.storage.prepare({ context: contexts, pieceSizes: [BigInt(backup.sealed.byteLength)] })
  if (transaction) fail(`account not funded for this upload (needs ${formatUnits(transaction.depositAmount)} USDFC); run: node backup.mjs fund`)

  log(`uploading ${backup.sealed.byteLength} bytes to providers ${chosen.map((p) => p.id).join(', ')} …`)
  const result = await s.storage.upload(backup.sealed, { contexts })
  const entry = jsonable({
    name: backup.name,
    date: new Date().toISOString(),
    pieceCid: result.pieceCid.toString(),
    size: backup.sealed.byteLength,
    plainBytes: backup.plainBytes,
    plainSha256: backup.plainSha256,
    sealedSha256: backup.sealedSha256,
    complete: result.complete,
    requestedCopies: result.requestedCopies,
    copies: result.copies.map((c) => ({ ...c, location: chosen.find((p) => p.id === Number(c.providerId))?.location })),
    failedAttempts: result.failedAttempts,
    deleted: false,
  })
  writeLedger([...readLedger(), entry])
  log(`piece ${entry.pieceCid}: ${result.copies.length}/${result.requestedCopies} copies${result.complete ? '' : ' (INCOMPLETE)'}`)
  if (!result.complete) process.exit(2)
}

function list() {
  for (const e of readLedger()) {
    const where = e.copies.map((c) => `${c.providerId}@${(c.location ?? '').replace(/;.*$/, '')}`).join(' ')
    console.log([e.date.slice(0, 10), e.deleted ? 'deleted' : e.complete ? 'complete' : 'partial', e.pieceCid, `${(e.size / 2 ** 20).toFixed(0)} MiB`, where].join(' | '))
  }
}

async function verify() {
  const s = synapse()
  const live = readLedger().filter((e) => !e.deleted)
  let missing = 0
  const byDataSet = new Map()
  for (const e of live) for (const c of e.copies) byDataSet.set(c.dataSetId, [...(byDataSet.get(c.dataSetId) ?? []), e.pieceCid])
  for (const [dataSetId, expected] of byDataSet) {
    const ctx = await s.storage.createContext({ dataSetId: BigInt(dataSetId) })
    const present = new Set()
    for await (const piece of ctx.getPieces()) present.add(piece.pieceCid.toString())
    for (const cid of expected) {
      const ok = present.has(cid)
      if (!ok) missing++
      log(`${ok ? 'ok     ' : 'MISSING'} data set ${dataSetId} (provider ${ctx.provider?.id ?? '?'}) ${cid}`)
    }
  }
  if (missing) process.exit(2)
}

async function restore(pieceCid, out) {
  if (!pieceCid) fail('usage: node backup.mjs restore <pieceCid> [out.zip]')
  const entry = readLedger().find((e) => e.pieceCid === pieceCid)
  let sealed
  try {
    sealed = await synapse().storage.download({ pieceCid })
  } catch (err) {
    // Without a wallet (restore on another machine) fall back to the providers' public piece URLs.
    const urls = entry?.copies.map((c) => c.retrievalUrl) ?? []
    for (const url of urls) {
      const res = await fetch(url).catch(() => null)
      if (res?.ok) {
        sealed = new Uint8Array(await res.arrayBuffer())
        break
      }
    }
    if (!sealed) fail(`download failed: ${err.message}`)
  }
  if (entry && createHash('sha256').update(sealed).digest('hex') !== entry.sealedSha256) fail('downloaded bytes do not match the ledger checksum')
  const d = new Decrypter()
  d.addIdentity(ageIdentity())
  const plain = await d.decrypt(sealed)
  const target = out ?? join(HERE, `${entry?.name ?? 'restore'}.zip`)
  writeFileSync(target, plain)
  log(`restored to ${target}; import into an empty Paperless with: document_importer <dir-with-unzipped-export>`)
}

async function prune(yes) {
  const cutoff = Date.now() - config.keepWeeks * 7 * DAY
  const ledger = readLedger()
  const old = ledger.filter((e) => !e.deleted && Date.parse(e.date) < cutoff)
  if (!old.length) return log('nothing older than', config.keepWeeks, 'weeks')
  if (ledger.filter((e) => !e.deleted && e.complete).length - old.length < 1) fail('refusing to delete: no complete newer backup would remain')
  for (const e of old) log(`${yes ? 'deleting' : 'would delete'} ${e.date.slice(0, 10)} ${e.pieceCid}`)
  if (!yes) return log('pass --yes to delete (irreversible)')
  const s = synapse()
  for (const e of old) {
    for (const c of e.copies) {
      const ctx = await s.storage.createContext({ dataSetId: BigInt(c.dataSetId) })
      await ctx.deletePiece({ piece: BigInt(c.pieceId) })
    }
    e.deleted = true
    writeLedger(ledger)
  }
}

const [command, ...args] = process.argv.slice(2)
const commands = {
  'init-key': initKey,
  providers,
  status,
  fund: () => fund(Number(args[0] ?? 3)),
  plan,
  run,
  list,
  verify,
  restore: () => restore(args[0], args[1]),
  prune: () => prune(args.includes('--yes')),
}
if (!commands[command]) fail(`unknown command. One of: ${Object.keys(commands).join(', ')}`)
await commands[command]()
