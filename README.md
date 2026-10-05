# paperless-backup-filecoin

**An encrypted off-site backup for [Paperless-ngx](https://docs.paperless-ngx.com), stored on several independent hosters in Europe at the same time.**

Every week the script exports Paperless (documents and database), encrypts the export on your machine, and stores it with three storage providers on [Filecoin Onchain Cloud](https://docs.filecoin.cloud) — for example one in France, one in Poland and one in the UK, run by different operators. You choose the region and the number of copies; each provider proves on chain, every day, that it still holds your copy.

- **Decentralised, not one cloud:** each copy sits with a different provider, under its own contract and its own proof. No single company can lose or lock away your archive.
- **Region and copies are yours to set:** `"regions": "EU"` (or `"EEA"`, `"EUROPE"`, or country codes) and `"copies": 3`, or name the providers yourself.
- **Encrypted before it leaves:** [age](https://age-encryption.org) encryption on your machine. Pieces on Filecoin are publicly retrievable, so the providers only ever see ciphertext.
- **Cheap:** about $0.12 per provider per month plus $2.50 per TiB. A 0.6 GiB archive on three providers costs about $0.36 a month.
- **Checkable:** `verify` asks the chain whether every copy is still in place.

> Status: new (October 2026). The full round — fund, upload, verify, restore — has been run on the Filecoin Calibration testnet against a real Paperless archive (see [Tested on the testnet](#tested-on-the-testnet)). Mainnet runs the same code with real USDFC. Feedback and issues welcome.

## How it works

```
Paperless ── document_exporter ──► zip ── age ──► one encrypted piece
                                                    │
                       Filecoin Onchain Cloud (PDP warm storage)
                     ┌──────────────┼──────────────┐
                provider A      provider B      provider C
                 (FR, op. 1)     (PL, op. 1)     (UK, op. 2)
```

1. `document_exporter` writes a zip of all documents and the database (the format `document_importer` reads back).
2. The zip is encrypted with an age recipient; the plain zip is deleted right away.
3. The piece is uploaded with the [Synapse SDK](https://github.com/FilOzone/synapse-sdk) to the chosen providers.
4. `ledger.json` records the piece, its checksum and, per copy, the provider, its declared location, the data set and the piece id.

Provider choice: the providers you name, or the first `copies` approved providers inside `regions` — one per operator first, then one per country. If too few qualify, the backup stops instead of storing elsewhere.

## Tested on the testnet

On 2026-10-05, with a Paperless archive of about 1,000 documents, on Filecoin's Calibration testnet:

| Step | Result |
|---|---|
| `fund 1` | deposit and service approval in one transaction |
| `run` | 603 MiB encrypted export, uploaded in 11 minutes; 2/2 copies (providers in the UK and the US), recorded on chain |
| `verify` | the piece found in both data sets |
| `restore` | downloaded and decrypted in under 3 minutes; SHA-256 identical to the original export, zip intact with its manifest |

What it taught, now in the script:
- A first attempt failed because the primary provider stopped answering after the upload. `run` now retries with the next chosen provider as primary — the set of providers, and so the region, stays the same.
- The Mac's clock was an hour slow, and the deposit was refused (`EIP2612: expired deadline`): the permit had expired by chain time. Keep the system clock synced.

Try it yourself for free: [HOWTO.txt](HOWTO.txt), step 5. What every command prints on a good run, and what the common errors mean: [HOWTO.txt](HOWTO.txt), step 11.

## Requirements

- Paperless-ngx with Docker Compose (the script runs `docker compose exec webserver document_exporter`)
- Node.js 22+
- A Filecoin wallet with a few USDFC (storage) and a little FIL (gas). There is no card payment; FIL can be bought at an exchange and swapped for USDFC.

Step-by-step setup: [HOWTO.txt](HOWTO.txt).

## Commands

| Command | What it does |
|---|---|
| `node backup.mjs init-key` | create the age identity (keychain on macOS, `AGE_IDENTITY_FILE` elsewhere) |
| `node backup.mjs providers` | approved providers, declared location, which are chosen |
| `node backup.mjs plan` | export + encrypt + decryption check, size and cost — **no upload** |
| `node backup.mjs status` | wallet, deposit, readiness |
| `node backup.mjs fund [months]` | deposit USDFC and approve the storage service |
| `node backup.mjs run` | export, encrypt, upload |
| `node backup.mjs verify` | is every copy still in its data set? |
| `node backup.mjs list` | stored backups |
| `node backup.mjs restore <pieceCid> [out.zip]` | download, check, decrypt |
| `node backup.mjs prune --yes` | delete backups older than `keepWeeks` (the newest complete one always stays) |

## Configuration (`config.json`)

| Key | Meaning |
|---|---|
| `regions` | `"EU"`, `"EEA"`, `"EUROPE"` (EEA + UK + CH), or a list of ISO country codes |
| `copies` | number of providers when `providerIds` is empty |
| `providerIds` | explicit provider ids; still checked against `regions` |
| `keepWeeks` | how long `prune` keeps backups |
| `network` | `mainnet` or `calibration` (testnet) |

Environment: `PAPERLESS_DIR` (default: the parent folder), `PAPERLESS_SERVICE` (default `webserver`), `BACKUP_CONFIG`, `WALLET_KEY_FILE`, `AGE_IDENTITY_FILE`.

## Limits — read before relying on it

- **Locations are self-declared.** Each provider states its location in the on-chain registry; nobody verifies it.
- **Few approved providers so far.** In October 2026 there were 6 approved providers worldwide, 4 of them in Europe from 2 operators. `node backup.mjs providers` shows the current list.
- **No object lock.** You (or anyone with the wallet key) can delete pieces. For immutable retention, keep an additional copy on storage with object lock.
- **Full upload each run.** No deduplication; fine for archives of a few GiB.
- **Lose the age identity, lose the backup.** Keep a second copy of it off the machine.
- **Keep the clock right.** Deposits are signed with an expiry; a clock that is off by an hour makes them fail.
- **Pay as you go.** Storage runs on a 30-day prepaid lockup; an empty deposit ends the storage deals. `status` shows the runway.

## Related

- Paperless docs on backups: <https://docs.paperless-ngx.com/administration/#backup>
- Filecoin Onchain Cloud: <https://docs.filecoin.cloud>
- Provider approval criteria: <https://github.com/FilOzone/dealbot>

## License

MIT — by [Le Space](https://github.com/Le-Space).
