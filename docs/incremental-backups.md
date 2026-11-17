# Incremental, deduplicated backups: design

Status: proposal, 2026-11-17. Nothing is built yet. Nothing was uploaded or deleted on mainnet for this document. The only chain access was a free read of the live price list (`getPriceList`).

All examples use made-up data.

## TL;DR

- **Recommendation: option A.** The VM keeps a persistent Paperless export folder. Each backup uploads only the files that are new or changed since the last one, packed into **one age-encrypted piece per backup**.
  - Files are addressed by keyed IDs: HMAC-SHA256 with a key derived from the vault.
  - Backups are grouped into **generations**. Every generation starts from a full baseline and is followed by small incremental pieces. Retention removes whole generations.
  - Restore still ends in `document_importer`, unchanged.
- **Money is not driven by bytes.** It is driven by how many backups we make. The live price list adds per-operation fees on top of storage:
  - 0.008 USDFC per AddPieces call;
  - 0.003 per piece;
  - 0.007 per SchedulePieceRemovals;
  - 0.025 per new data set.

  Storage at 2.5 USDFC per TiB and month is almost free at our size: a 1.1 GB copy costs about 0.0025 a month. The 34 GiB pile-up costs about 0.08 a month per data set. The fees from adding and removing it cost far more.
- **Current scheme, at about 3 backups a day and 3 copies:** ≈ **6.1 USDFC a month**, of which 5.7 is operation fees. Each backup uploads 1.1 GB and takes about 20 minutes.
- **Option A:** ≈ **3.4 USDFC a month**. Each backup uploads about 5 MB and takes about 2–4 minutes. After 30 days it stores about 1.6–3.2 GB per copy instead of about 13 GB.
- **Most of what remains is per backup:** 0.033 USDFC per backup for 3 copies. Backing up less often, for example by waiting until changes settle, saves more than any storage optimisation.
- **Option B**, a restic- or kopia-style chunked repository stored as pieces, saves a few more MB per backup. It costs nothing less per month, because the per-backup fee is the same. It needs a repository secret on the VM that can decrypt all history, which the age model avoids today. It is not recommended now.
- **Migration** needs one fresh full baseline: about 1.1 GB, 3 copies, about 0.04 USDFC in fees. Old full backups stay protected until the new scheme's first restore has been verified.

## 1. What runs today (verified in the code)

**This repo, `backup.mjs` on `main`**

- `document_exporter <fresh dir> --use-filename-format --no-progress-bar` runs into a **new folder every time** ([backup.mjs `exportPaperless`](../backup.mjs)).
- The folder is then zipped, age-encrypted to `ageRecipient`, and split into parts of at most `PART_BYTES` = 1e9. Each part is one piece. The primary stores the parts and the other providers pull them.
- Afterwards the zip, the folder and the sealed file are deleted. The exporter's own incremental logic is never used.
- `retain` ([retention.mjs](../retention.mjs)) reads the chain, not the ledger.
  - It groups a data set's pieces into backups by size: a run of exactly `PART_BYTES` pieces plus the piece that ends it.
  - It keeps `keepLast` 3, one backup per day for 7 days, per week for 4 weeks and per month for 6 months, plus newest, protected and undated backups.
  - It removes the rest with one SchedulePieceRemovals per data set.
- `retire` ends data sets at providers that the config dropped.

**paperless-anywhere (`origin/main`)**

- `rootfs/files/paperless-backup-loop` runs `paperless-backup check` every 2 hours. `check` backs up when a fingerprint changes; the fingerprint covers counts, the latest `modified`, notes and labels.
- `paperless-stop` stops Paperless and runs a last backup.
- `paperless-backup` sets up the backup and binds it to the vault:
  - it writes the vault mark (`.paperless-anywhere/vault-mark.json`, an HMAC with `backup_mark_key`) into the sealed archive;
  - it puts `vaultMark`, an HMAC over the piece CID, into the status entry;
  - after a complete backup it runs `retain`, which only plans with a session key and removes pieces with the remote signer.
- `paperless-restore` restores a backup:
  - it fetches every part and checks its size, SHA-256 and piece CID;
  - it decrypts as a stream, checks the vault mark, unzips with path checks, and runs `document_importer` into an empty Paperless.
- `pwa/src/lib/backups.js` ("Was die Chain sagt") lists backups from the chain alone. It groups pieces the same way as `retain` (`PART_BYTES` runs), and checks `vaultMark` for P3.
  - The Le Space Credits quota is `CREDITS_QUOTA_BYTES` = 32 GiB, which the pile-up came close to.
- The image pins **paperless-ngx 3.2.1** (`rootfs/files/compose.yml`).

## 2. Research

### 2.1 Paperless-ngx incremental export (3.2.1)

Source: [`document_exporter.py` @ v3.2.1](https://github.com/paperless-ngx/paperless-ngx/blob/v3.2.1/src/documents/management/commands/document_exporter.py), [`export/sinks.py`](https://github.com/paperless-ngx/paperless-ngx/blob/v3.2.1/src/documents/export/sinks.py), [administration docs](https://docs.paperless-ngx.com/administration/).

| Option | Effect | Use for incremental? |
|---|---|---|
| (target is an existing folder) | Files are skipped when mtime and size match; copies keep their mtime | yes, the basis |
| `-c --compare-checksums` | Skip an original or archive when the target's checksum equals the database checksum | yes, robust against mtime noise |
| `-cj --compare-json` | Rewrite `manifest.json`, `metadata.json` and the per-document JSON only when their blake2b changed (without it, they are rewritten every run) | yes |
| `-d --delete` | Remove files from the folder that this run did not write (deleted documents, renamed files) | yes, the folder then equals the current state |
| `-sm --split-manifest` | Write one `<name>-manifest.json` per document (document, notes, custom fields); `manifest.json` keeps only the global objects | yes: a change to one document touches one small file, not one large JSON |
| `-p --use-folder-prefix` | `originals/`, `archive/`, `thumbnails/`, `json/` | optional, tidier |
| `-f --use-filename-format` | Names follow `PAPERLESS_FILENAME_FORMAT`; a retitle renames the file | irrelevant for content addressing; drop it or keep it |
| `-na` / `-nt` | Leave out archive PDFs or thumbnails | no: rebuilding archives means OCR, and thumbnails are small and stable |
| `-z` | Zip | **no**: it cannot be combined with `-c`/`-cj`, and a zip breaks dedup |
| `--data-only`, `--passphrase` | Database only; encrypted secret fields | no; age does the encryption |

Consistency:

- The exporter holds Paperless's media lock for the whole run. The consumer and bulk edits take the same lock.
- Database objects are serialized inside `transaction.atomic()`. On Postgres this runs at READ COMMITTED, so it is not one strict snapshot, though the run checks document order.
- This is the same guarantee as today.
- The last backup at stop runs with Paperless stopped, so that one is exact.

The docs say an existing export can be updated in place: "incremental backups with rsync are entirely possible". `document_importer` reads such a folder like any other, into an empty instance of the same version.

Common practice is a cron job that runs the exporter into a persistent folder, followed by restic or borg over that folder ([example](https://deployn.de/en/blog/paperless-backup-restore/), [TrueNAS forum](https://forums.truenas.com/t/paperless-ngx-backup-and-restore-process/29546)). The alternative is restic over the media volume plus a `pg_dump`. That restores volumes rather than going through the importer, which would leave the importer-based restore and vault-mark path that paperless-anywhere is built on.

### 2.2 Dedup tools

| | restic | borg | kopia |
|---|---|---|---|
| Chunking | Rabin CDC, 512 KiB–8 MiB, ~1 MiB average, random polynomial per repo | buzhash with a secret seed, ~2 MiB target | buzhash, ~4 MiB average |
| Chunk ID | plain SHA-256 of the plaintext (only inside the encrypted index) | keyed MAC (HMAC-SHA256 / keyed BLAKE2b) | keyed hash with the repo's HMAC secret |
| Packs | 16 MiB by default (`--pack-size` 4–128 MiB) | ~500 MiB segments | 20–40 MB |
| Key | symmetric repo key, unlocked by a password | symmetric | symmetric |

Sources: [restic references](https://restic.readthedocs.io/en/stable/100_references.html), [restic tuning](https://restic.readthedocs.io/en/stable/047_tuning_backup_parameters.html), [borg internals](https://borgbackup.readthedocs.io/en/stable/internals/data-structures.html), [kopia architecture](https://kopia.io/docs/advanced/architecture/).

Our data is mostly PDFs and images, which are already compressed and are not changed after they are consumed. Dedup therefore happens almost entirely at whole-file level. Chunking adds savings only on large files that change, which for us means `manifest.json`.

### 2.3 Filecoin Warm Storage / PDP

Sources: `@filoz/synapse-core` 0.10.0 and `synapse-sdk` 2.0.2 in `node_modules`, [FilecoinWarmStorageService.sol](https://github.com/FilOzone/filecoin-services/blob/262646f637d556dc978a8b0bae2e77ef5b2d261d/service_contracts/src/FilecoinWarmStorageService.sol), [PriceListUSDFC.sol](https://github.com/FilOzone/filecoin-services/blob/main/service_contracts/src/lib/PriceListUSDFC.sol), [PDPVerifier.sol](https://github.com/FilOzone/pdp/blob/main/src/PDPVerifier.sol), [Curio piece handler](https://github.com/filecoin-project/curio/blob/main/market/retrieval/piecehandler.go).

**Live price list.** Read with `getPriceList` on mainnet and on calibration, 2026-11-17; both are identical:

| | USDFC |
|---|---|
| storage | 2.5 per TiB and month, billed on raw bytes (leaf count × 32 × 127/128), not padded |
| per non-empty data set | 0.12 per month (empty: 0) |
| create data set | 0.025 once |
| **AddPieces** | **0.008 per call + 0.003 per piece** |
| **SchedulePieceRemovals** | **0.007 per call** (any number of pieces) |
| terminate | 0.006 |
| lifecycle reserve | 0.5 locked per data set (not spent) |

**Piece size.**

- The SDK accepts pieces from 127 B up to 1,065,353,216 B, which is 1 GiB × 127/128 (`synapse-core/src/utils/constants.ts`).
- Our `PART_BYTES` = 1e9 stays below that.
- Providers also declare their own minimum and maximum in the registry.

**AddPieces.**

- The contract sets no limit on how many pieces one call may add. The practical limit is the 64 KiB message size.
- Data sets created before the piece-ID change (IDs below 1559 on mainnet) take at most 80 pieces per call.
- The SDK batches 32 pieces per call by default.

**Removal.**

- `deletePieces` / `schedulePieceDeletions` only queue the pieces. The provider processes them before the next proving period.
- The rate drops in `nextProvingPeriod`, so with a delay of up to about a day. Additions raise the rate immediately.

**Proofs.**

- PDP draws 5 challenges per proof, uniformly over the data set's leaves.
- Finding which piece a challenged leaf belongs to is a sum-tree search, O(log n) in the number of pieces.
- Proof cost depends on the data set's size, not on how many pieces it holds. The provider pays it.
- Adding or removing a piece is O(log n) as well.
- Many pieces are therefore fine for proving. Only the per-piece fee speaks against tiny ones.

**"Only proven periods are paid."** `validatePayment` scales settlement by proven epochs over total epochs. Faulted periods pay the provider nothing.

**Retrieval.**

- Pieces are fetched with `GET {sp}/piece/{pieceCid}`.
- Curio serves them with `http.ServeContent`, so HTTP Range requests work (206).
- The SDK's `download` always fetches the whole piece and checks its CID.

**Piece metadata.**

- At most 3 keys per piece, keys up to 32 bytes, values up to 96 bytes.
- Public and signed by the client. **Correction after the calibration trial (2026-11-17):** current Warm Storage no longer keeps piece metadata in its state; it only emits it in the `PieceAdded` event. Old data sets still have it in storage (legacy layout), new ones do not. Reading events over a data set's whole life is too fragile with public RPC limits, so the design uses a public prefix in the piece itself (below).
- `storage.upload(…, { pieceMetadata })` exists in sdk 2.0.2.

**Copies.** The primary stores a piece once. The other providers pull it (`/pdp/piece/pull`) into their own data sets, and each copy pays its own AddPieces fees.

**What this means for the design.**

- Keep one long-lived data set per provider; this is already the case.
- **Make few pieces per backup and few backups**, and avoid tiny chunk-pieces: a 16 MiB restic pack per piece would cost 0.011 per pack per copy.
- Removals are cheap when batched.
- Storage bytes hardly matter for cost. They still matter for the quota, for upload time and for VM bandwidth.

## 3. Options

Both options share these parts:

- the persistent export folder on the VM's sealed disk (`/srv/paperless/export/state`), updated in place with `document_exporter state -c -cj -d -sm -p --no-progress-bar`;
- the vault mark;
- the `document_importer` restore.

### Option A: own pack format over the persistent export (recommended)

**Backup**

1. Update the persistent folder with the exporter. Only new or changed files get rewritten.
2. Walk the folder. For each file, compute `id = HMAC-SHA256(dedupKey, sha256(file))`.
   - `dedupKey` = HKDF(vault secret, `"paperless-anywhere/backup-dedup/v1"`). It comes with the unlock like `backup_mark_key`.
   - The VM's local index (`/var/lib/paperless-anywhere/backup-index.json`, on the sealed disk) says which IDs the current generation already holds.
3. Write one pack and age-encrypt it as one stream to `ageRecipient`. It contains:
   - a header: format, generation, sequence number, the parent piece CID, and the vault mark;
   - the snapshot index: every path → id, size and sha256;
   - the bytes of the new blobs.
4. Pad the pack up to the next multiple of 1 MiB, so its size does not tell how many documents were added.
5. Upload the pack as one piece, the same way as today: primary, pulls, one AddPieces per data set. Use `PART_BYTES` parts if it is larger (only the baseline).
   - **The sealed pack starts with a public 64-byte prefix before the age stream:** `PA-SNAP/1 <gen> <seq>`, padded with spaces and ending in a newline. `gen` is 16 random hex; `seq` 0 is the baseline. `retain` and the app read it with an HTTP range request (bytes 0–63) from any provider holding the piece, and cache the answer per piece CID. A full backup of the old kind starts with age's own header instead.
   - The pieces also carry the same values as piece metadata (`pa=snap/1`, `gen`, `seq`), which only reaches the `PieceAdded` event.
6. **Rebase**, meaning a new generation starting with a full baseline pack, when any of these holds:
   - the generation is older than 30 days;
   - its incremental bytes exceed 30 % of the baseline;
   - the local index is missing, for example on a VM that was not restored;
   - on request, for example after documents were deleted for good and must leave the backups.

**What the providers and the public can see**

- **The prefix of every pack: its generation and its number in it.** Anyone can fetch the first 64 bytes of a piece, since pieces are publicly retrievable. So anyone can tell that a piece is an incremental backup, which pieces form one generation, how many additions it has, and which piece is its baseline. The piece metadata in the `PieceAdded` event says the same.
- The generation id is random and says nothing about the content.
- The size of each piece, rounded up to whole MiB.
- When each piece was added.

**What they cannot see**

- File IDs: they appear only inside the age stream.
- Which documents two backups share.
- Document sizes: a pack can hold several documents and is padded.

Dedup holds only within a generation. Each generation is encrypted with fresh age file keys, so nothing links one generation to another.

**Restore of snapshot `(gen, seq)`**

1. List the pieces of `gen` with `seq ≤ n`. The app gets them from piece metadata, the VM from the restore entry.
2. Fetch each piece and check its piece CID. Decrypt it as a stream.
3. Read the target snapshot's index. Write each path from the blob that holds it.
4. Check the sha256 of each file and the vault mark.
5. Run `document_importer` as today.
6. Afterwards, the VM keeps the restored folder as its persistent export folder and writes the target index as its local index. The next backup then continues the generation with an incremental piece (`seq = max + 1`), not a new baseline.

**Retention.** It stays chain-only and needs no key; the VM has none.

- A snapshot needs every piece of its generation with a lower or equal `seq`.
- `retain` keeps whole generations: every generation that contains a snapshot the existing policy would keep (newest, protected, last, day, week, month).
- It removes older generations in one SchedulePieceRemovals per data set.
- Intermediate snapshots are not removed: they are small and removing them saves nothing.
- Legacy full backups (pieces without `pa`) keep today's rules.

### Option B: a restic or kopia repository stored as pieces

**Backup**

1. Update the same persistent export folder.
2. Run `restic backup` into a local repository on the VM's sealed disk. The repository is encrypted with restic's key, from a password derived from the vault that comes with the unlock.
3. Upload the new repository files of this run (16 MiB packs, index, snapshot) as one tar. To keep the binding, age-encrypt that tar to `ageRecipient` as well. It becomes one piece with the same public metadata as option A.

**Restore**

1. Fetch every piece of the generation, decrypt with age and untar into a repository folder.
2. Run `restic restore <snapshot>`, then `document_importer`.

**Retention.** Generations again, as one fresh repository per generation. restic's own `forget`/`prune` would rewrite packs into new pieces and break the piece ↔ snapshot mapping.

**Gains over option A**

- Chunk-level dedup on files that change, in our case `manifest.json`: a few MB per backup.
- zstd compression of the JSON.

**Costs**

- A new binary in the image.
- A **symmetric repository secret on the VM that decrypts the whole history**. Today the VM only holds the public age recipient.
- The repository file layout is coupled to a tool version.
- The local repository mirrors about 1.1 GB on the VM disk, on top of the export folder.
- Two encryption layers.

**Variant B2**: restic over the media volume plus `pg_dump`, without the exporter. This is rejected because it leaves the importer-based restore and its version tolerance, and it would need a new mark and restore path.

## 4. Comparison

Assumptions:

- **Export:** 1.1 GB with about 1,500 documents, so about 0.7 MB per document for original, archive and thumbnail.
- **Activity:** a few new documents a day, giving about **3 backups a day = 90 a month**, plus the stop backups.
- **Per-backup delta:** about 2 MB of new files plus changed JSON, so **~5 MB** as an assumption, to be measured in step 1 below.
- **Copies:** 3.
- **Throughput:** about 1 MB/s end to end, including pulls (testnet: 603 MiB in 11 minutes).
- **Retention:** today's mainnet defaults.

| | Today (full, 2 parts) | A: own packs | B: restic as pieces |
|---|---|---|---|
| Upload per backup | 1.1 GB (×1 from the VM; the providers pull) | ~5 MB, one piece | ~3–5 MB, one piece |
| Time per backup | export ~3–5 min + upload ~18 min | export ~1 min (checksums over 1.1 GB) + upload and confirmations ~1–3 min | about the same as A, plus restic |
| Pieces per backup and copy | 2 | 1 (baseline: 2) | 1 (baseline: 2) |
| Stored per copy after 30 days | ~13 GB (about 12 kept backups) | ~1.6 GB (baseline plus 90 deltas), up to ~3.2 GB while two generations overlap | ~1.5–3 GB |
| Restore points within 30 days | about 12 | all ~90 (more is free) | all ~90 |
| AddPieces fees per month (3 copies) | 3.78 | 3.01 (including a monthly baseline) | 3.01 |
| Removal fees per month | up to 1.89 (`retain` after each backup) | ~0.04 (one generation per month) | ~0.04 |
| Data-set fees per month (3) | 0.36 | 0.36 | 0.36 |
| Storage per month | 0.09 | 0.02 | 0.02 |
| **Total USDFC per month** | **≈ 6.1** | **≈ 3.4** | **≈ 3.4** |
| at 30 / 60 / 180 backups a month | 2.3 / 4.2 / 11.8 | 1.5 / 2.4 / 6.4 | same as A |
| Restore download | 1.1 GB, 2 pieces | ≤ baseline plus deltas (~1.2–1.6 GB), about 90 pieces | the same, plus `restic restore` |
| Restore time | ~5–10 min download + import | ~6–12 min download (many small GETs) + rebuild + import | same as A |
| Key on the VM | age recipient (public) | recipient plus `dedupKey` (only computes IDs) | recipient plus **repository secret (decrypts history)** |
| VM disk | ~2.2 GB while running (export, zip, sealed) | +1.1 GB persistent export folder; while running only the pack | +1.1 GB export folder +~1.1 GB repository |
| Change, VM side | — | `paperless-backup`: persistent folder, index; `paperless-restore`: snapshot entry, keep the folder afterwards | as A, plus the restic binary and the secret |
| Change, app side | — | "Was die Chain sagt": group by piece metadata (`pa/gen/seq`); P3 `vaultMark` over the snapshot piece; restore entry lists the generation's pieces; `retain` per generation | the same |
| Risk | known | own format: a format bug costs restores; mitigated by restore checks in CI and a weekly restore drill | dependence on restic's format and version; key handling |

Costs come from the live price list and these assumptions. Storage is billed only for periods the provider proved.

## 5. Recommendation

**Build option A.**

1. It keeps the security model: age to the vault's recipient, and the VM cannot decrypt history.
2. It uses the exporter's own incremental mode and the unchanged importer.
3. It saves about 99 % of upload bytes and time per backup, about 45 % of cost, and about 85 % of stored bytes. It also makes every backup a restore point.

Option B's extra dedup is worth only a few MB per backup and nothing in fees.

**Second lever, independent of A: fewer backups.** In option A the remaining cost is almost entirely 0.033 USDFC per backup for 3 copies.

- Back up when Paperless has changed and then **stayed quiet for about 30 minutes**, with at least 4–6 hours between backups.
- Keep the backup at stop, which must always run.
- This halves the cost again, to about 1.5 USDFC a month.
- It can ship before A, as a small change to `paperless-backup-loop`.

**Also before A, in the current scheme:** `retain` currently runs after every backup and spends 0.007 per data set each time. Run it once a day instead. This saves up to about 1.9 USDFC a month right away.

## 6. Migration

1. **The new scheme starts with one full baseline.** Old full backups are zip-in-age blobs and cannot become blobs of a pack. The baseline is about 1.1 GB per copy in 2 pieces, about 0.04 USDFC in fees plus about 20 minutes, a one-off.
2. **Old full backups are listed and restorable as before** (legacy, no `pa` metadata). The app shows them as "Vollsicherung (alt)".
3. **Nothing is deleted** until the first restore from the new scheme has worked:
   - a fresh VM restores the newest snapshot from mainnet;
   - the document count, the checksums and the vault mark all check out;
   - the app records the outcome.

   Until then, `retain` puts every legacy backup under `protect`.
4. After that, `retain` keeps the newest legacy backup for another 30 days as a fallback. Then legacy backups follow the normal policy. Removals stay with the wallet or the remote signer, as today.

## 7. Step plan

1. **Measure, without uploading.**
   - On the VM, for one week: run the exporter into the persistent folder with `-c -cj -d -sm -p` alongside the normal backup.
   - Log only byte counts per run: new or changed files, the size of `manifest.json`.
   - Log no names.
   - This confirms the ~5 MB assumption and the time per run.
2. **Quick wins in the current scheme:**
   - wait for changes to settle and keep a minimum interval between backups (`paperless-backup-loop`);
   - run `retain` once a day.
3. **Pack format and tests** (this repo, `snapshot.mjs`):
   - writing a pack, the index, HMAC IDs, padding, and the generation and rebase rules;
   - restore into a folder;
   - property tests: restoring any snapshot gives the same folder as the export at that time.
4. **Calibration (free).**
   - Baseline plus 20 incrementals on a test VM.
   - A restore of an old snapshot, and of the newest one.
   - `retain` per generation.
   - A rebase.
   - Check the fees actually charged against the price list.
5. **VM side** (paperless-anywhere):
   - `paperless-backup`: persistent folder, `dedupKey` from the unlock, local index;
   - `paperless-restore`: snapshot entries, keep the folder and the index afterwards;
   - the status entry gets `gen` and `seq`;
   - `vaultMark` over the snapshot piece CID.
6. **App side:**
   - "Was die Chain sagt" groups by piece metadata and shows snapshots per generation;
   - P3 marks per snapshot;
   - restore picks a snapshot;
   - the retention view per generation;
   - legacy backups unchanged.
7. **Mainnet, with Nico's go:**
   - the baseline;
   - one week in parallel with the full backup (full only once a day);
   - the first verified restore.
   - Then the full backup is switched off and the legacy backups go to retention as in section 6.
8. **Later, optional:** a weekly automatic restore drill on calibration from a copy of the format tests.
