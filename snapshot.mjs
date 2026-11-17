// Incremental backups: snapshots of a persistent Paperless export folder,
// stored as packs (docs/incremental-backups.md, option A).
//
// A generation is a baseline pack (every file of the export) followed by
// delta packs (only the files whose content the generation does not hold
// yet). Each pack is one age stream to the vault's recipient, uploaded as one
// piece (a baseline above PART_BYTES in parts), and carries the whole
// snapshot's index, so any snapshot is restored from its own pack and the
// packs of its generation before it.
//
// Pack plaintext:
//   "PASNAP01"  8 bytes
//   u32 BE      length of the header
//   header      deflate-raw of JSON { v, format, gen, seq, created, files, blobs }
//                 files: [[path, id, size, sha256], …]  the snapshot, sorted by path
//                 blobs: [[id, size], …]                 the bytes in this pack, in order
//   blobs       the file contents, back to back
//   zeros       up to the next multiple of `pad` bytes (sizes do not tell
//               how many documents were added)
//
// File ids are HMAC-SHA256(dedupKey, sha256) (first 128 bits, hex). They only
// appear inside the age stream; dedupKey comes from the vault, so ids are not
// plain content hashes even where the index is seen (the machine's own
// state). Dedup holds within a generation only: each pack has fresh age file
// keys, nothing links two generations.
//
// The sealed pack starts with a public prefix of PREFIX_BYTES before the age
// stream: "PA-SNAP/1 <gen> <seq>", padded with spaces, ending in a newline.
// `retain` and the app read it with an HTTP range request (bytes 0-63) to
// keep a generation together without any key; a full backup of the old kind
// starts with age's own header instead. (Warm Storage no longer keeps piece
// metadata in its state, only in the PieceAdded event: the prefix is what
// can be read back at any time. The pieces also carry pa/gen/seq as piece
// metadata, for indexers of those events.)
//
// Plain logic over files and streams: tested without a chain.

import { createHash, createHmac, randomBytes } from 'node:crypto'
import { createReadStream, createWriteStream, lstatSync, mkdirSync, readdirSync, copyFileSync, existsSync, statSync } from 'node:fs'
import { once } from 'node:events'
import { dirname, join, posix, sep } from 'node:path'
import { deflateRawSync, inflateRawSync } from 'node:zlib'

export const FORMAT = 'snap/1'
/** The public prefix of a sealed pack. */
export const PREFIX_BYTES = 64
const PREFIX_TAG = 'PA-SNAP/1'
const AGE_TAG = 'age-encryption.org/v1'
export const MAGIC = Buffer.from('PASNAP01')
/** Packs are padded to a multiple of this many bytes of plaintext. */
export const PAD_BYTES = 1 << 20
/** A header larger than this is refused when read (a broken or hostile pack). */
export const MAX_HEADER = 256 << 20
/** Where the extra files (vault mark, certificate) go inside a snapshot. */
export const EXTRA_PREFIX = '.paperless-anywhere'

/** The exporter's arguments for the persistent folder (paperless-ngx 3.2.1). */
export const EXPORTER_ARGS = Object.freeze(['--compare-checksums', '--compare-json', '--delete', '--split-manifest', '--use-folder-prefix', '--no-progress-bar'])

/** Defaults of config.incremental. */
export const DEFAULTS = Object.freeze({ enabled: false, restoreVerified: false, rebaseDays: 30, rebaseRatio: 0.3, padBytes: PAD_BYTES })

/** config.incremental over the defaults, checked. @param {any} c */
export function incrementalConfig(c) {
  const o = { ...DEFAULTS, ...(c === true ? { enabled: true } : c ?? {}) }
  if (typeof o.enabled !== 'boolean') throw new RangeError('incremental.enabled must be true or false')
  if (typeof o.restoreVerified !== 'boolean') throw new RangeError('incremental.restoreVerified must be true or false')
  if (!(Number.isInteger(o.rebaseDays) && o.rebaseDays >= 1 && o.rebaseDays <= 366)) throw new RangeError('incremental.rebaseDays must be a whole number from 1 to 366')
  if (!(typeof o.rebaseRatio === 'number' && o.rebaseRatio > 0 && o.rebaseRatio <= 10)) throw new RangeError('incremental.rebaseRatio must be a number above 0')
  if (!(Number.isInteger(o.padBytes) && o.padBytes >= 1 && o.padBytes <= 64 << 20)) throw new RangeError('incremental.padBytes must be a whole number of bytes up to 64 MiB')
  return { enabled: o.enabled, restoreVerified: o.restoreVerified, rebaseDays: o.rebaseDays, rebaseRatio: o.rebaseRatio, padBytes: o.padBytes }
}

// --- keys and ids -------------------------------------------------------------

/**
 * The dedup key from a secret: 64 hex (a key file) or any string (an age
 * identity), always through HMAC with a label, so the same secret used
 * elsewhere gives an unrelated key.
 * @param {string} secret
 */
export function dedupKeyFrom(secret) {
  const s = String(secret ?? '').trim()
  if (!s) throw new Error('no secret for the dedup key')
  const raw = /^[0-9a-fA-F]{64}$/.test(s) ? Buffer.from(s, 'hex') : Buffer.from(s, 'utf8')
  return createHmac('sha256', raw).update('paperless-anywhere/backup-dedup/v1').digest()
}

/** A short check value of the key (in the local state, never on chain): another key → rebase. */
export const keyCheck = (key) => createHmac('sha256', key).update('paperless-anywhere/backup-dedup/check').digest('hex').slice(0, 16)

/** A file's id: keyed, so not its plain content hash. @param {Buffer} key @param {string} sha256 hex */
export const blobId = (key, sha256) => createHmac('sha256', key).update(`paperless-anywhere/blob/v1\n${sha256}`).digest('hex').slice(0, 32)

/** A new generation's name: random, it says nothing about the content. */
export const newGeneration = () => randomBytes(8).toString('hex')

// --- piece metadata -----------------------------------------------------------

/** The public metadata of one piece of a pack. */
export function pieceMetadata({ gen, seq, part = 0, parts = 1 }) {
  return { pa: parts > 1 ? `${FORMAT} ${part + 1}/${parts}` : FORMAT, gen, seq: String(seq) }
}

/**
 * A piece's metadata read back: null when it is not a snapshot piece (a full
 * backup of the old kind, or something else).
 * @param {Record<string, string> | null | undefined} meta
 * @returns {{ gen: string, seq: number, part: number, parts: number } | null}
 */
export function parsePieceMetadata(meta) {
  const pa = String(meta?.pa ?? '')
  const m = /^snap\/1(?: (\d{1,4})\/(\d{1,4}))?$/.exec(pa)
  if (!m) return null
  const gen = String(meta.gen ?? '')
  const seq = Number(meta.seq)
  if (!/^[0-9a-f]{16}$/.test(gen) || !Number.isSafeInteger(seq) || seq < 0 || String(seq) !== String(meta.seq)) return null
  const parts = m[2] ? Number(m[2]) : 1
  const part = m[1] ? Number(m[1]) - 1 : 0
  if (parts < 1 || part < 0 || part >= parts) return null
  return { gen, seq, part, parts }
}

/** A sealed pack's public prefix. */
export function packPrefix({ gen, seq }) {
  if (!/^[0-9a-f]{16}$/.test(gen) || !Number.isSafeInteger(seq) || seq < 0) throw new Error('no generation or number for the prefix')
  const line = `${PREFIX_TAG} ${gen} ${seq}`
  return Buffer.from(line.padEnd(PREFIX_BYTES - 1, ' ') + '\n')
}

/**
 * What the first bytes of a piece say: a snapshot pack ({ gen, seq }), a
 * full backup of the old kind ('full'), or null (something else, or too few bytes).
 * @param {Uint8Array} bytes at least the first PREFIX_BYTES (or 21 for age's header)
 */
export function classifyPrefix(bytes) {
  const b = Buffer.from(bytes)
  if (b.subarray(0, AGE_TAG.length).toString('latin1') === AGE_TAG) return 'full'
  if (b.length < PREFIX_BYTES || b[PREFIX_BYTES - 1] !== 0x0a) return null
  const m = /^PA-SNAP\/1 ([0-9a-f]{16}) (0|[1-9][0-9]{0,9}) *$/.exec(b.subarray(0, PREFIX_BYTES - 1).toString('latin1'))
  return m ? { gen: m[1], seq: Number(m[2]) } : null
}

// --- the export folder ----------------------------------------------------------

/** A path inside a snapshot: relative, posix, no "..", no empty or odd segments. */
export function safePath(p) {
  if (typeof p !== 'string' || !p || p.length > 4096 || p.includes('\0') || p.includes('\\')) return false
  if (p.startsWith('/')) return false
  return p.split('/').every((s) => s && s !== '.' && s !== '..')
}

const sha256File = async (path) => {
  const h = createHash('sha256')
  for await (const chunk of createReadStream(path)) h.update(chunk)
  return h.digest('hex')
}

/**
 * Every regular file under `root` (and under `extra`, as EXTRA_PREFIX/…),
 * with its SHA-256. A file whose size and mtime match `cache` keeps the
 * cached hash (the exporter keeps mtimes of what it did not rewrite).
 * Symlinks are skipped.
 * @param {string} root @param {string | null} extra
 * @param {Record<string, [number, number, string]>} [cache] path → [size, mtimeMs, sha256]
 * @returns {Promise<Array<{ path: string, abs: string, size: number, mtimeMs: number, sha256: string }>>}
 */
export async function scanFiles(root, extra = null, cache = {}) {
  const out = []
  const walk = async (base, prefix, rel = '') => {
    const dir = rel ? join(base, ...rel.split('/')) : base
    for (const name of readdirSync(dir).sort()) {
      const r = rel ? `${rel}/${name}` : name
      const abs = join(dir, name)
      const st = lstatSync(abs)
      if (st.isSymbolicLink()) continue
      if (st.isDirectory()) {
        await walk(base, prefix, r)
        continue
      }
      if (!st.isFile()) continue
      const path = prefix ? `${prefix}/${r}` : r
      if (!safePath(path)) throw new Error(`refusing an odd file name in the export: ${JSON.stringify(path).slice(0, 80)}`)
      const hit = cache[path]
      const sha256 = hit && hit[0] === st.size && hit[1] === st.mtimeMs ? hit[2] : await sha256File(abs)
      out.push({ path, abs, size: st.size, mtimeMs: st.mtimeMs, sha256 })
    }
  }
  await walk(root, '')
  if (extra && existsSync(extra)) await walk(extra, EXTRA_PREFIX)
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return out
}

// --- planning -------------------------------------------------------------------

/** An empty local state: no generation yet. */
export const emptyState = () => ({ v: 1, gen: null, seq: -1, keyCheck: null, started: null, baseBytes: 0, deltaBytes: 0, blobs: {}, pieces: [], files: {} })

/**
 * Must the next snapshot start a new generation, and why (null: no).
 * @param {any} state @param {{ key: Buffer, now: number, rebaseDays: number, rebaseRatio: number, force?: boolean }} o
 */
export function rebaseReason(state, { key, now, rebaseDays, rebaseRatio, force = false }) {
  if (force) return 'requested'
  if (!state?.gen || !(state.seq >= 0) || !state.pieces?.length) return 'no generation yet'
  if (state.keyCheck !== keyCheck(key)) return 'another dedup key'
  if (!state.pieces.some((p) => p.seq === 0)) return 'the generation has no baseline here'
  const started = Date.parse(state.started)
  if (!Number.isFinite(started) || now - started >= rebaseDays * 24 * 3600 * 1000) return `the generation is ${rebaseDays} days old`
  if (state.deltaBytes > rebaseRatio * Math.max(state.baseBytes, 1)) return `its deltas exceed ${Math.round(rebaseRatio * 100)} % of the baseline`
  return null
}

/**
 * The next snapshot of `files`: a baseline (every file) when `rebase`, else
 * a delta (the files whose id the generation does not hold).
 * @param {Array<{ path: string, abs: string, size: number, sha256: string }>} files
 * @param {any} state @param {{ key: Buffer, rebase: string | null, now: number, gen?: string }} o
 */
export function planSnapshot(files, state, { key, rebase, now, gen = newGeneration() }) {
  const baseline = Boolean(rebase)
  const held = baseline ? {} : state.blobs
  const g = baseline ? gen : state.gen
  const seq = baseline ? 0 : state.seq + 1
  const index = files.map((f) => ({ ...f, id: blobId(key, f.sha256) }))
  const seen = new Set()
  const blobs = []
  for (const f of index) {
    if (held[f.id] != null || seen.has(f.id)) continue
    seen.add(f.id)
    blobs.push(f)
  }
  const header = {
    v: 1,
    format: FORMAT,
    gen: g,
    seq,
    created: new Date(now).toISOString(),
    files: index.map((f) => [f.path, f.id, f.size, f.sha256]),
    blobs: blobs.map((f) => [f.id, f.size]),
  }
  return { gen: g, seq, baseline, rebase, header, blobs, newBytes: blobs.reduce((n, f) => n + f.size, 0), totalBytes: index.reduce((n, f) => n + f.size, 0), files: index }
}

// --- writing a pack -----------------------------------------------------------

export const encodeHeader = (header) => deflateRawSync(Buffer.from(JSON.stringify(header)), { level: 9 })

/** The header back, checked for shape. @param {Buffer} raw */
export function decodeHeader(raw) {
  const h = JSON.parse(inflateRawSync(raw, { maxOutputLength: MAX_HEADER }).toString('utf8'))
  if (h?.v !== 1 || h.format !== FORMAT) throw new Error('not a snapshot pack of a known format')
  if (!/^[0-9a-f]{16}$/.test(h.gen) || !Number.isSafeInteger(h.seq) || h.seq < 0) throw new Error('the pack names no generation')
  if (!Array.isArray(h.files) || !Array.isArray(h.blobs)) throw new Error('the pack has no index')
  for (const f of h.files) {
    if (!Array.isArray(f) || !safePath(f[0]) || !/^[0-9a-f]{32}$/.test(f[1]) || !Number.isSafeInteger(f[2]) || f[2] < 0 || !/^[0-9a-f]{64}$/.test(f[3])) throw new Error('the pack index has a bad entry')
  }
  for (const b of h.blobs) if (!Array.isArray(b) || !/^[0-9a-f]{32}$/.test(b[0]) || !Number.isSafeInteger(b[1]) || b[1] < 0) throw new Error('the pack lists a bad blob')
  return h
}

/** Plaintext bytes of a pack with this header and these blobs, before padding. */
export const packBytes = (headerBytes, blobs) => MAGIC.length + 4 + headerBytes.length + blobs.reduce((n, b) => n + b.size, 0)

/**
 * The pack's plaintext as a stream of chunks: magic, header, each blob read
 * from its file and checked against its SHA-256 on the way (a file that
 * changed since the scan fails the pack), zeros up to `pad`.
 * @param {{ header: any, blobs: Array<{ abs: string, size: number, sha256: string, path: string }> }} plan
 * @param {{ pad?: number }} [o]
 */
export async function* packStream(plan, { pad = PAD_BYTES } = {}) {
  const head = encodeHeader(plan.header)
  const len = Buffer.alloc(4)
  len.writeUInt32BE(head.length)
  yield Buffer.concat([MAGIC, len, head])
  let total = MAGIC.length + 4 + head.length
  for (const b of plan.blobs) {
    const h = createHash('sha256')
    let n = 0
    for await (const chunk of createReadStream(b.abs)) {
      n += chunk.length
      if (n > b.size) break
      h.update(chunk)
      yield chunk
    }
    if (n !== b.size || h.digest('hex') !== b.sha256) throw new Error(`a file changed while it was packed (${b.path.split('/').at(-1).length} chars name); run the backup again`)
    total += n
  }
  const rest = (pad - (total % pad)) % pad
  const zeros = Buffer.alloc(Math.min(rest, 1 << 20))
  for (let left = rest; left > 0; left -= zeros.length) yield left >= zeros.length ? zeros : zeros.subarray(0, left)
}

// --- reading a pack -----------------------------------------------------------

/** Reads exact byte counts from an async iterable of chunks. */
export class ByteReader {
  /** @param {AsyncIterable<Uint8Array>} source */
  constructor(source) {
    this.it = source[Symbol.asyncIterator]()
    this.buf = Buffer.alloc(0)
    this.done = false
  }
  async fill() {
    if (this.done) return false
    const { value, done } = await this.it.next()
    if (done) {
      this.done = true
      return false
    }
    this.buf = this.buf.length ? Buffer.concat([this.buf, Buffer.from(value)]) : Buffer.from(value)
    return true
  }
  /** Exactly n bytes, or an error at the end of the stream. */
  async read(n) {
    while (this.buf.length < n) if (!(await this.fill())) throw new Error('the pack ends early')
    const out = this.buf.subarray(0, n)
    this.buf = this.buf.subarray(n)
    return out
  }
  /** n bytes handed to `sink` chunk by chunk (sink may be null: skipped). */
  async pass(n, sink) {
    let left = n
    while (left > 0) {
      if (!this.buf.length && !(await this.fill())) throw new Error('the pack ends early')
      const take = Math.min(left, this.buf.length)
      const part = this.buf.subarray(0, take)
      this.buf = this.buf.subarray(take)
      if (sink) await sink(part)
      left -= take
    }
  }
  /** Everything left must be zeros (the padding). */
  async rest() {
    let n = 0
    const check = (b) => {
      if (b.some((x) => x !== 0)) throw new Error('the pack has bytes after its blobs')
      n += b.length
    }
    check(this.buf)
    this.buf = Buffer.alloc(0)
    while (await this.fill()) {
      check(this.buf)
      this.buf = Buffer.alloc(0)
    }
    return n
  }
  async cancel() {
    await this.it.return?.()
  }
}

/** The header of a pack (decrypted stream). */
export async function readHeader(reader) {
  const magic = await reader.read(MAGIC.length)
  if (!magic.equals(MAGIC)) throw new Error('not a snapshot pack')
  const len = (await reader.read(4)).readUInt32BE(0)
  if (len > MAX_HEADER) throw new Error('the pack header is too large')
  return decodeHeader(Buffer.from(await reader.read(len)))
}

/**
 * Writes the snapshot `target` (a header) into `outDir` from the packs of its
 * generation: `open(seq)` gives each pack's decrypted bytes, seq 0 up to the
 * target's. A blob goes to every path of the target that has its id; each
 * file is checked against its size and SHA-256. Fails when a pack is not of
 * this generation, out of order, or a needed file is in none of them.
 * @param {any} target the target snapshot's header
 * @param {(seq: number) => Promise<AsyncIterable<Uint8Array>>} open
 * @param {string} outDir an empty or missing folder
 * @returns {Promise<{ files: number, bytes: number, written: Record<string, [number, number, string]>, blobs: Record<string, number> }>}
 */
export async function restoreSnapshot(target, open, outDir) {
  const want = new Map()
  for (const [path, id, size, sha256] of target.files) {
    if (!want.has(id)) want.set(id, { size, sha256, paths: [] })
    const w = want.get(id)
    if (w.size !== size || w.sha256 !== sha256) throw new Error('the snapshot index gives one id two contents')
    w.paths.push(path)
  }
  mkdirSync(outDir, { recursive: true, mode: 0o700 })
  if (readdirSync(outDir).length) throw new Error('the restore folder is not empty')
  const target_ = (p) => {
    const abs = join(outDir, ...p.split('/'))
    if (!abs.startsWith(outDir + sep)) throw new Error('a path leaves the restore folder')
    return abs
  }
  const done = new Set()
  const blobs = {}
  let bytes = 0
  for (let seq = 0; seq <= target.seq; seq++) {
    const reader = new ByteReader(await open(seq))
    const h = await readHeader(reader)
    if (h.gen !== target.gen || h.seq !== seq) throw new Error(`pack ${seq} belongs to another generation or place`)
    for (const [id, size] of h.blobs) {
      blobs[id] = seq
      const w = want.get(id)
      if (!w || done.has(id)) {
        await reader.pass(size, null)
        continue
      }
      if (size !== w.size) throw new Error(`pack ${seq}: a file has another size than the index says`)
      const first = target_(w.paths[0])
      mkdirSync(dirname(first), { recursive: true, mode: 0o700 })
      const out = createWriteStream(first, { mode: 0o600 })
      const hash = createHash('sha256')
      await reader.pass(size, async (chunk) => {
        hash.update(chunk)
        if (!out.write(chunk)) await once(out, 'drain')
      })
      out.end()
      await once(out, 'finish')
      if (hash.digest('hex') !== w.sha256) throw new Error(`pack ${seq}: a file does not match its SHA-256`)
      for (const p of w.paths.slice(1)) {
        const abs = target_(p)
        mkdirSync(dirname(abs), { recursive: true, mode: 0o700 })
        copyFileSync(first, abs)
      }
      done.add(id)
      bytes += size * w.paths.length
    }
    await reader.rest()
  }
  const missing = [...want.keys()].filter((id) => !done.has(id))
  if (missing.length) throw new Error(`${missing.length} file(s) of the snapshot are in none of its packs`)
  const written = {}
  for (const [path, , size, sha256] of target.files) {
    const st = statSync(target_(path))
    written[path] = [size, st.mtimeMs, sha256]
  }
  return { files: target.files.length, bytes, written, blobs }
}

// --- the local state ----------------------------------------------------------

/**
 * The state after a snapshot went up: its pieces and copies recorded, its
 * blobs known to the generation, the scan cache refreshed.
 * @param {any} state @param {ReturnType<typeof planSnapshot>} plan
 * @param {{ key: Buffer, piece: { pieceCids: string[], sizes: number[], copies: any[], date: string } }} o
 */
export function nextState(state, plan, { key, piece }) {
  const base = plan.baseline ? { ...emptyState(), gen: plan.gen, started: piece.date, keyCheck: keyCheck(key), baseBytes: plan.totalBytes } : { ...state }
  const blobs = { ...base.blobs }
  for (const b of plan.blobs) blobs[b.id] = plan.seq
  const files = {}
  for (const f of plan.files) files[f.path] = [f.size, f.mtimeMs, f.sha256]
  return {
    ...base,
    v: 1,
    gen: plan.gen,
    seq: plan.seq,
    deltaBytes: plan.baseline ? 0 : base.deltaBytes + plan.newBytes,
    blobs,
    pieces: [...(plan.baseline ? [] : base.pieces), { seq: plan.seq, ...piece }],
    files,
  }
}

/**
 * The state a machine continues from after it restored snapshot `target`:
 * the generation's pieces and blobs (from the packs it read), and the scan
 * cache of the restored folder, so its next backup is a delta, not a baseline.
 * @param {any} target @param {{ key: Buffer, pieces: any[], blobs: Record<string, number>, written: Record<string, [number, number, string]>, baseBytes: number, started: string }} o
 */
export function stateFromRestore(target, { key, pieces, blobs, written, baseBytes, started }) {
  const seq = Math.max(target.seq, ...pieces.map((p) => p.seq))
  return { ...emptyState(), gen: target.gen, seq, keyCheck: keyCheck(key), started, baseBytes, deltaBytes: 0, blobs, pieces, files: written }
}

/**
 * Which pieces of the generation each copy lacks (a provider that missed a
 * pack, or a new provider): they are pulled from a copy that has them before
 * the next pack is added there.
 * @param {any} state @param {Array<{ providerId: number | string }>} providers the chosen ones
 * @returns {Map<string, Array<{ seq: number, pieceCids: string[], sizes: number[], urls: string[] }>>} provider id → missing pieces (with where to get them)
 */
export function missingPieces(state, providers) {
  const out = new Map()
  for (const p of providers) {
    const id = String(p.providerId ?? p.id)
    const lack = []
    for (const piece of state.pieces ?? []) {
      if ((piece.copies ?? []).some((c) => String(c.providerId) === id)) continue
      const from = (piece.copies ?? []).find((c) => Array.isArray(c.retrievalUrls) && c.retrievalUrls.length === piece.pieceCids.length)
      if (from) lack.push({ seq: piece.seq, pieceCids: piece.pieceCids, sizes: piece.sizes, urls: from.retrievalUrls })
      else lack.push({ seq: piece.seq, pieceCids: piece.pieceCids, sizes: piece.sizes, urls: null })
    }
    out.set(id, lack)
  }
  return out
}

/** posix join for tests and callers. */
export const joinPath = (...p) => posix.join(...p)
