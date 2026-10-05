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
//   node backup.mjs daily           once a day: back up if Paperless changed, verify, prune, mail
//   node backup.mjs mail-from-paperless [account name]   take SMTP login from a Paperless mail account
//   node backup.mjs mail-check      log in to the SMTP server, send nothing
//   node backup.mjs mail-test [--warning]   send one test report (--warning: as if funds ran low)

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { platform } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Decrypter, Encrypter, generateX25519Identity, identityToRecipient } from 'age-encryption'
import { Synapse, TOKENS, calibration, formatUnits, mainnet } from '@filoz/synapse-sdk'
import { getPDPProvidersByIds } from '@filoz/synapse-core/sp-registry'
import { getApprovedProviderIds } from '@filoz/synapse-core/warm-storage'
import { getEndorsedProviderIds } from '@filoz/synapse-core/endorsements'
import { createPublicClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import nodemailer from 'nodemailer'

const HERE = dirname(fileURLToPath(import.meta.url))
const PAPERLESS = process.env.PAPERLESS_DIR ?? join(HERE, '..')
const PAPERLESS_SERVICE = process.env.PAPERLESS_SERVICE ?? 'webserver'
const EXPORT_DIR = join(PAPERLESS, 'export')
const CONFIG_PATH = process.env.BACKUP_CONFIG ?? join(HERE, 'config.json')
const KEYCHAIN = {
  wallet: 'paperless-backup-filecoin-wallet',
  identity: 'paperless-backup-age-identity',
  smtp: 'paperless-backup-smtp',
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
// Testnet backups get their own ledger, so they never mix with real ones.
const LEDGER_PATH = join(HERE, config.network === 'calibration' ? 'ledger.calibration.json' : 'ledger.json')
const STATE_PATH = join(HERE, config.network === 'calibration' ? 'state.calibration.json' : 'state.json')

function log(...args) {
  console.log(new Date().toISOString(), ...args)
}

// Thrown, not exiting, so that `daily` can still report a failure by mail.
class Failure extends Error {}

function fail(message) {
  throw new Failure(message)
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
  const fil = await s.payments.walletBalance({ token: TOKENS.FIL })
  const usdfc = await s.payments.walletBalance({ token: TOKENS.USDFC })
  const deposit = await s.payments.balance({ token: TOKENS.USDFC })
  log(`network ${chain.name}, account ${s.address}`)
  log(`wallet: ${formatUnits(fil)} FIL, ${formatUnits(usdfc)} USDFC; available in Filecoin Pay: ${formatUnits(deposit)} USDFC`)
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

// The primary copy is the one this machine uploads; the others pull from it.
// A primary that stops answering fails the whole upload, so each retry puts
// the next chosen provider first. The set of providers never changes.
async function uploadWithRetry(s, chosen, bytes) {
  let lastError
  for (let attempt = 0; attempt < chosen.length; attempt++) {
    const order = [...chosen.slice(attempt), ...chosen.slice(0, attempt)]
    const contexts = await s.storage.createContexts({ providerIds: order.map((p) => BigInt(p.id)), metadata: config.datasetMetadata })
    log(`uploading ${bytes.byteLength} bytes to providers ${order.map((p) => p.id).join(', ')} (primary ${order[0].id}) …`)
    try {
      return await s.storage.upload(bytes, { contexts })
    } catch (err) {
      lastError = err
      log(`upload with primary ${order[0].id} failed: ${err.shortMessage ?? err.message}`)
      if (attempt + 1 < chosen.length) await new Promise((r) => setTimeout(r, 30_000))
    }
  }
  throw lastError
}

async function runBackup() {
  const chosen = await resolveProviders()
  const s = synapse()
  const backup = await encryptedExport()
  const { transaction } = await s.storage.prepare({ context: await chosenContexts(s), pieceSizes: [BigInt(backup.sealed.byteLength)] })
  if (transaction) fail(`account not funded for this upload (needs ${formatUnits(transaction.depositAmount)} USDFC); run: node backup.mjs fund`)

  const result = await uploadWithRetry(s, chosen, backup.sealed)
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
  return entry
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
  return missing
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
  if (!old.length) {
    log('nothing older than', config.keepWeeks, 'weeks')
    return []
  }
  if (ledger.filter((e) => !e.deleted && e.complete).length - old.length < 1) fail('refusing to delete: no complete newer backup would remain')
  for (const e of old) log(`${yes ? 'deleting' : 'would delete'} ${e.date.slice(0, 10)} ${e.pieceCid}`)
  if (!yes) {
    log('pass --yes to delete (irreversible)')
    return []
  }
  const s = synapse()
  for (const e of old) {
    for (const c of e.copies) {
      const ctx = await s.storage.createContext({ dataSetId: BigInt(c.dataSetId) })
      await ctx.deletePiece({ piece: BigInt(c.pieceId) })
    }
    e.deleted = true
    writeLedger(ledger)
  }
  return old
}

// --- daily ------------------------------------------------------------------

function readState() {
  return existsSync(STATE_PATH) ? JSON.parse(readFileSync(STATE_PATH, 'utf8')) : {}
}

function writeState(state) {
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n')
}

// What changes in Paperless when a document, its metadata or the labels change.
function paperlessFingerprint() {
  const code = [
    'from documents.models import Document, Tag, Correspondent, DocumentType, Note',
    'from django.db.models import Max',
    'import json',
    'd = Document.global_objects',
    'print(json.dumps({',
    '  "documents": d.filter(deleted_at__isnull=True).count(),',
    '  "trash": d.filter(deleted_at__isnull=False).count(),',
    '  "modified": str(d.aggregate(m=Max("modified"))["m"]),',
    '  "notes": Note.objects.count(),',
    '  "labels": [m.objects.count() for m in (Tag, Correspondent, DocumentType)],',
    '  "labelIds": [m.objects.aggregate(m=Max("id"))["m"] for m in (Tag, Correspondent, DocumentType)],',
    '}))',
  ].join('\n')
  const out = execFileSync('docker', ['compose', 'exec', '-T', '-u', 'paperless', PAPERLESS_SERVICE, 'python3', 'manage.py', 'shell', '-c', code], {
    cwd: PAPERLESS,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  const line = out.trim().split('\n').reverse().find((l) => l.startsWith('{'))
  if (!line) fail('could not read the Paperless fingerprint (is Docker running?)')
  return line
}

// The most recent daily start time (e.g. 03:30) that has already passed.
function lastDueTime(now = new Date()) {
  const [h, m] = (config.daily?.time ?? '03:30').split(':').map(Number)
  const due = new Date(now)
  due.setHours(h, m, 0, 0)
  if (due > now) due.setDate(due.getDate() - 1)
  return due
}

async function accountSummary() {
  const s = synapse()
  const fil = await s.payments.walletBalance({ token: TOKENS.FIL })
  const usdfc = await s.payments.walletBalance({ token: TOKENS.USDFC })
  const info = await s.payments.accountInfo({ token: TOKENS.USDFC })
  const days = info.lockupRate > 0n ? Number((info.availableFunds / info.lockupRate) * 30n) / 86_400 : null
  return {
    address: s.address,
    fil: Number(formatUnits(fil)),
    usdfc: Number(formatUnits(usdfc)),
    deposit: Number(formatUnits(info.funds)),
    available: Number(formatUnits(info.availableFunds)),
    runwayDays: days === null ? null : Math.floor(days),
  }
}

function smtpPassword() {
  const fromFile = process.env.SMTP_PASSWORD_FILE
  return fromFile ? readFileSync(fromFile, 'utf8').trim() : keychainRead(KEYCHAIN.smtp)
}

function mailTransport() {
  const m = config.mail
  if (!m?.to || !m?.user) return null
  const pass = smtpPassword()
  if (!pass) {
    log(`no SMTP password (keychain ${KEYCHAIN.smtp} or SMTP_PASSWORD_FILE)`)
    return null
  }
  return nodemailer.createTransport({ host: m.host, port: m.port ?? 465, secure: (m.port ?? 465) === 465, auth: { user: m.user, pass } })
}

async function sendMail(subject, text, { html, important = false } = {}) {
  const transport = mailTransport()
  if (!transport) return log('mail not configured; skipping notification')
  const m = config.mail
  // priority "high" sets X-Priority 1 / Importance high: Apple Mail and Outlook show a "!".
  await transport.sendMail({ from: m.from ?? m.user, to: m.to, subject, text, html, priority: important ? 'high' : 'normal' })
  log(`mail sent to ${m.to}: ${subject}`)
}

// Copies the login of a Paperless mail account (IMAP) for sending the report:
// the user name into config.json, the password into the keychain. Neither is
// printed. The daily run then mails even when Docker (and Paperless) is down.
async function mailFromPaperless(accountName) {
  if (platform() !== 'darwin') fail('mail-from-paperless stores into the macOS keychain; elsewhere use SMTP_PASSWORD_FILE')
  const code = [
    'from paperless_mail.models import MailAccount',
    'import json',
    `qs = MailAccount.objects.filter(name=${JSON.stringify(accountName ?? '')}) if ${JSON.stringify(accountName ?? '')} else MailAccount.objects.all()`,
    'a = qs.order_by("id").first()',
    'print(json.dumps({"name": a.name, "user": a.username, "pass": a.password, "host": a.imap_server, "token": a.is_token}) if a else "{}")',
  ].join('\n')
  const out = execFileSync('docker', ['compose', 'exec', '-T', '-u', 'paperless', PAPERLESS_SERVICE, 'python3', 'manage.py', 'shell', '-c', code], {
    cwd: PAPERLESS,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  const account = JSON.parse(out.trim().split('\n').reverse().find((l) => l.startsWith('{')) ?? '{}')
  if (!account.user || !account.pass) fail('no Paperless mail account with a user name and password found')
  if (account.token) fail(`Paperless account "${account.name}" uses an OAuth token, not a password`)
  try {
    execFileSync('security', ['delete-generic-password', '-s', KEYCHAIN.smtp, '-a', process.env.USER], { stdio: 'ignore' })
  } catch {}
  execFileSync('security', ['add-generic-password', '-s', KEYCHAIN.smtp, '-a', process.env.USER, '-w', account.pass], { stdio: 'ignore' })
  config.mail = { ...config.mail, host: config.mail?.host ?? account.host, user: account.user, from: config.mail?.from ?? account.user }
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n')
  log(`SMTP login taken from Paperless account "${account.name}": user written to config.json, password to the keychain (${KEYCHAIN.smtp})`)
}

async function mailCheck() {
  const transport = mailTransport()
  if (!transport) fail('mail not configured: config.json "mail" needs to, user; and an SMTP password')
  await transport.verify()
  log(`SMTP login to ${config.mail.host}:${config.mail.port ?? 465} as ${config.mail.user} works; reports go to ${config.mail.to}`)
}

// --warning simulates a deposit that lasts 12 more days, to see the warning mail.
async function mailTest(warning) {
  const account = await accountSummary()
  const report = { kind: 'test', lastUpload: readLedger().filter((e) => e.complete && !e.deleted).at(-1), account: warning ? { ...account, runwayDays: 12 } : account }
  const mail = renderReport(report)
  await sendMail(`${warning ? '[TEST] ' : ''}${mail.subject}`, mail.text, mail)
}

// Prints the test report, and the same with simulated low funds and a failure; sends nothing.
async function mailPreview() {
  const account = await accountSummary()
  const lastUpload = readLedger().filter((e) => e.complete && !e.deleted).at(-1)
  const cases = [
    { kind: 'test', lastUpload, account },
    { kind: 'unchanged', lastUpload, account: { ...account, runwayDays: 12, fil: 0.01 } },
    { kind: 'failed', error: 'could not read the Paperless fingerprint (is Docker running?)', account },
  ]
  for (const r of cases) {
    const m = renderReport(r)
    console.log(`--- ${m.important ? '[!] ' : ''}${m.subject}\n${m.text}\n`)
  }
}

// --- report -----------------------------------------------------------------

const TEXT = {
  de: {
    subject: { test: 'Paperless-Backup: Testmail', unchanged: 'Paperless-Backup: keine Änderung', done: 'Paperless-Backup: erledigt', incomplete: 'Paperless-Backup: UNVOLLSTÄNDIG', failed: 'Paperless-Backup: FEHLGESCHLAGEN' },
    lowFunds: '⚠️ Guthaben knapp – ',
    test: 'Das ist eine Testmail des täglichen Paperless-Backups.',
    unchanged: (d) => `Keine Änderung in Paperless seit dem Backup vom ${d}. Es wurde nichts hochgeladen.`,
    uploaded: (mib, n, of) => `Neues Backup: ${mib} MiB, ${n} von ${of} Kopien gespeichert.`,
    copy: (id, country) => `Anbieter ${id} (${country})`,
    verifyOk: 'Prüfung: Jede Kopie liegt in ihrem Datensatz.',
    verifyMissing: (n) => `Prüfung: ${n} Kopie(n) FEHLEN.`,
    pruned: (n, w) => `${n} Backup(s) älter als ${w} Wochen entfernt.`,
    lastBackup: (d) => `Letztes Backup: ${d}`,
    noBackup: 'Noch kein Backup.',
    failed: (msg) => `Das Backup ist fehlgeschlagen: ${msg}`,
    retry: 'Es wird jede Stunde erneut versucht; diese Mail kommt höchstens einmal am Tag.',
    account: 'Konto',
    wallet: (fil, usdfc) => `Wallet: ${fil} FIL, ${usdfc} USDFC`,
    pay: (avail, days) => `Filecoin Pay: ${avail} USDFC verfügbar${days === null ? '' : `, reicht noch etwa ${days} Tage`}`,
    warnTitle: (days) => `ACHTUNG: Das Guthaben reicht nur noch etwa ${days} Tage.`,
    warnBody: 'Läuft es leer, beenden die Anbieter die Speicherung – die Backups gehen verloren.',
    warnGas: 'Zu wenig FIL für Gebühren auf dem Backup-Konto.',
    howTo: 'So füllst du auf:',
    step1: (addr) => `1. USDFC (und bei Bedarf etwas FIL) an das Backup-Konto schicken: ${addr}`,
    step2: '2. Im Terminal: cd ~/paperless-ngx/backup-filecoin && node backup.mjs fund 3',
    piece: 'Piece-CID',
  },
  en: {
    subject: { test: 'Paperless backup: test mail', unchanged: 'Paperless backup: no change', done: 'Paperless backup: done', incomplete: 'Paperless backup: INCOMPLETE', failed: 'Paperless backup: FAILED' },
    lowFunds: '⚠️ Low funds – ',
    test: 'This is a test of the daily Paperless backup report.',
    unchanged: (d) => `No change in Paperless since the backup of ${d}. Nothing was uploaded.`,
    uploaded: (mib, n, of) => `New backup: ${mib} MiB, ${n} of ${of} copies stored.`,
    copy: (id, country) => `provider ${id} (${country})`,
    verifyOk: 'Verify: every copy is in its data set.',
    verifyMissing: (n) => `Verify: ${n} copy/copies MISSING.`,
    pruned: (n, w) => `Removed ${n} backup(s) older than ${w} weeks.`,
    lastBackup: (d) => `Last backup: ${d}`,
    noBackup: 'No backup yet.',
    failed: (msg) => `The backup failed: ${msg}`,
    retry: 'It is retried every hour; this mail comes at most once a day.',
    account: 'Account',
    wallet: (fil, usdfc) => `Wallet: ${fil} FIL, ${usdfc} USDFC`,
    pay: (avail, days) => `Filecoin Pay: ${avail} USDFC available${days === null ? '' : `, lasts about ${days} more days`}`,
    warnTitle: (days) => `WARNING: the deposit lasts only about ${days} more days.`,
    warnBody: 'When it runs out, the providers end the storage and the backups are lost.',
    warnGas: 'Too little FIL for fees on the backup account.',
    howTo: 'To top up:',
    step1: (addr) => `1. Send USDFC (and some FIL if needed) to the backup account: ${addr}`,
    step2: '2. In a terminal: cd ~/paperless-ngx/backup-filecoin && node backup.mjs fund 3',
    piece: 'Piece CID',
  },
}

const escapeHtml = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

function renderReport(r) {
  const lang = config.mail?.language === 'de' ? 'de' : 'en'
  const t = TEXT[lang]
  const locale = lang === 'de' ? 'de-DE' : 'en-GB'
  const num = (v, digits) => v.toLocaleString(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits })
  const when = (iso) => new Date(iso).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' })
  const country = (loc) => /(?:^|;)C=([A-Z]{2})/i.exec(loc ?? '')?.[1] ?? '?'

  const lines = []
  if (r.kind === 'test') {
    lines.push(t.test, r.lastUpload ? t.lastBackup(when(r.lastUpload.date)) : t.noBackup)
  } else if (r.kind === 'unchanged') {
    lines.push(t.unchanged(when(r.lastUpload.date)))
  } else if (r.kind === 'failed') {
    lines.push(t.failed(r.error), t.retry)
  } else {
    const e = r.entry
    lines.push(t.uploaded(num(e.size / 2 ** 20, 0), e.copies.length, e.requestedCopies))
    lines.push(...e.copies.map((c) => `  – ${t.copy(c.providerId, country(c.location))}`))
    lines.push(r.missing ? t.verifyMissing(r.missing) : t.verifyOk)
    if (r.pruned) lines.push(t.pruned(r.pruned, config.keepWeeks))
    lines.push(`${t.piece}: ${e.pieceCid}`)
  }

  const a = r.account
  const lowRunway = a && a.runwayDays !== null && a.runwayDays < (config.daily?.warnRunwayDays ?? 30)
  const lowGas = a && a.fil < 0.05
  const warning = []
  if (lowRunway) warning.push(t.warnTitle(a.runwayDays), t.warnBody)
  if (lowGas) warning.push(t.warnGas)
  if (warning.length) warning.push('', t.howTo, t.step1(a.address), t.step2)

  const accountLines = a ? [t.wallet(num(a.fil, 4), num(a.usdfc, 2)), t.pay(num(a.available, 2), a.runwayDays)] : []
  const problem = r.kind === 'failed' || r.kind === 'incomplete' || r.missing > 0
  const subject = (warning.length ? t.lowFunds : '') + t.subject[r.kind === 'done' && r.missing ? 'incomplete' : r.kind]

  const text = [...(warning.length ? [...warning.map((l) => (l ? `!! ${l}` : '')), ''] : []), ...lines, '', `${t.account}:`, ...accountLines].join('\n')
  const block = (rows) => rows.map((l) => (l ? escapeHtml(l) : '&nbsp;')).join('<br>')
  const html = [
    '<div style="font-family:-apple-system,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;color:#1d1d1f">',
    warning.length
      ? `<div style="background:#fdecea;border-left:6px solid #d93025;padding:12px 14px;margin-bottom:16px;color:#8a1c12"><strong>⚠️ ${escapeHtml(warning[0])}</strong><br>${block(warning.slice(1))}</div>`
      : '',
    problem ? `<div style="border-left:6px solid #d93025;padding:4px 12px;margin-bottom:12px">${block(lines)}</div>` : `<p>${block(lines)}</p>`,
    a ? `<p style="color:#555"><strong>${escapeHtml(t.account)}</strong><br>${block(accountLines)}</p>` : '',
    '</div>',
  ].join('')
  return { subject, text, html, important: warning.length > 0 || problem }
}

// Started at the daily time and every hour after (launchd): the first start
// after the due time does the work, later ones exit quietly. A machine that
// was off at 03:30 therefore catches up within the hour after it is back.
async function daily() {
  const state = readState()
  const due = lastDueTime()
  if (state.lastDaily && Date.parse(state.lastDaily) >= due.getTime()) return
  try {
    const fingerprint = paperlessFingerprint()
    const lastUpload = readLedger().filter((e) => e.complete && !e.deleted).at(-1)
    const stale = !lastUpload || Date.now() - Date.parse(lastUpload.date) > (config.daily?.fullEveryDays ?? 7) * DAY
    let report
    if (fingerprint === state.lastFingerprint && !stale) {
      log(`no change in Paperless since ${lastUpload.date}; nothing uploaded`)
      report = { kind: 'unchanged', lastUpload }
    } else {
      const entry = await runBackup()
      const missing = await verify()
      const pruned = config.daily?.prune ? (await prune(true)).length : 0
      report = { kind: entry.complete && !missing ? 'done' : 'incomplete', entry, missing, pruned }
      if (report.kind === 'incomplete') process.exitCode = 2
    }
    report.account = await accountSummary()
    log(`account: ${report.account.fil} FIL, ${report.account.usdfc} USDFC, ${report.account.available} USDFC available, runway ${report.account.runwayDays} days`)
    writeState({ ...state, lastDaily: new Date().toISOString(), lastFingerprint: fingerprint })
    const mail = renderReport(report)
    await sendMail(mail.subject, mail.text, mail)
  } catch (err) {
    const error = err.shortMessage ?? err.message
    log(`FAILED: ${error}`)
    // Retried every hour until it works; mail about it once a day.
    const today = new Date().toISOString().slice(0, 10)
    if (state.lastFailureMail !== today) {
      writeState({ ...state, lastFailureMail: today })
      const account = await accountSummary().catch(() => null)
      const mail = renderReport({ kind: 'failed', error, account })
      await sendMail(mail.subject, mail.text, mail).catch((e) => log(`mail failed: ${e.message}`))
    }
    process.exitCode = 1
  }
}

const [command, ...args] = process.argv.slice(2)
const commands = {
  'init-key': initKey,
  providers,
  status,
  fund: () => fund(Number(args[0] ?? 3)),
  plan,
  run: async () => {
    if (!(await runBackup()).complete) process.exitCode = 2
  },
  list,
  verify: async () => {
    if (await verify()) process.exitCode = 2
  },
  daily,
  'mail-from-paperless': () => mailFromPaperless(args[0]),
  'mail-check': mailCheck,
  'mail-test': () => mailTest(args.includes('--warning')),
  'mail-preview': mailPreview,
  restore: () => restore(args[0], args[1]),
  prune: () => prune(args.includes('--yes')),
}
try {
  if (!commands[command]) fail(`unknown command. One of: ${Object.keys(commands).join(', ')}`)
  await commands[command]()
} catch (err) {
  console.error(`error: ${err instanceof Failure ? err.message : (err.stack ?? err.message)}`)
  process.exit(1)
}
