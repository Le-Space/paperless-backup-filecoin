# paperless-backup-filecoin

**An encrypted off-site backup for [Paperless-ngx](https://docs.paperless-ngx.com), stored on several independent hosters in Europe at the same time.**

Every day the script checks Paperless for changes, exports it (documents and database), encrypts the export on your machine, and stores it with three storage providers on [Filecoin Onchain Cloud](https://docs.filecoin.cloud) — for example one in France, one in Poland and one in the UK, run by different operators. You choose the region and the number of copies; each provider proves on chain, every day, that it still holds your copy.

- **Decentralised, not one cloud:** each copy sits with a different provider, under its own contract and its own proof. No single company can lose or lock away your archive.
- **Region and copies are yours to set:** `"regions": "EU"` (or `"EEA"`, `"EUROPE"`, or country codes) and `"copies": 3`, or name the providers yourself.
- **Encrypted before it leaves:** [age](https://age-encryption.org) encryption on your machine, with your own key. Pieces on Filecoin are publicly retrievable, so the providers only ever see ciphertext — details in [SECURITY.md](SECURITY.md).
- **Cheap:** about $0.12 per provider per month plus $2.50 per TiB. A 0.6 GiB archive on three providers costs about $0.36 a month.
- **Checkable:** `verify` asks the chain whether every copy is still in place.

> Status: new (October 2026). Running daily on mainnet since 2026-10-05: 603 MiB, 3/3 copies in France, Poland and the UK, verified. The full round including restore was first run on the Calibration testnet (see [Tested on the testnet](#tested-on-the-testnet)). Feedback and issues welcome.

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
- A first attempt failed because the primary provider stopped answering after the upload. `run` now retries without it, with the next chosen provider as primary: one provider that refuses the piece costs a copy, not the backup. Such a backup is marked incomplete; the next run asks every chosen provider again, and no provider outside the chosen set (and region) is added.
- The Mac's clock was an hour slow, and the deposit was refused (`EIP2612: expired deadline`): the permit had expired by chain time. Keep the system clock synced.

Try it yourself for free: [HOWTO.txt](HOWTO.txt), step 5. What every command prints on a good run, and what the common errors mean: [HOWTO.txt](HOWTO.txt), step 11.

## Requirements

- Paperless-ngx with Docker Compose (the script runs `docker compose exec webserver document_exporter`)
- Node.js 22+
- A Filecoin wallet with a few USDFC (storage) and a little FIL (gas). There is no card payment; FIL can be bought at an exchange and swapped for USDFC.

Step-by-step setup: [HOWTO.txt](HOWTO.txt). Auf Deutsch: [ANLEITUNG.txt](ANLEITUNG.txt). How the encryption works, where the keys live and what stays public: [SECURITY.md](SECURITY.md).

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
| `node backup.mjs mail-from-paperless` / `mail-check` / `mail-test` / `mail-preview` | take the SMTP login from a Paperless mail account; check the login; send a test report; print the report (and a low-funds and a failure example) without sending |
| `node backup.mjs daily` | once a day: back up if Paperless changed, verify, prune, mail a report; catches up if the machine was off |
| `node backup.mjs session-login <hours> <key-file>` | with the wallet: create a session key that may create data sets and add pieces until it expires (at most 168 h), and write it to `<key-file>` |
| `node backup.mjs session-revoke <address>` | with the wallet: withdraw a session key |

## Configuration (`config.json`)

| Key | Meaning |
|---|---|
| `regions` | `"EU"`, `"EEA"`, `"EUROPE"` (EEA + UK + CH), or a list of ISO country codes |
| `copies` | number of providers when `providerIds` is empty |
| `providerIds` | explicit provider ids; still checked against `regions` |
| `keepWeeks` | how long `prune` keeps backups |
| `daily` | `time` (when the day's run is due), `fullEveryDays` (upload even without changes), `prune`, `warnRunwayDays` |
| `mail` | SMTP `host`, `port`, `user`, `from`, `to`, and `language` (`en` or `de`) for the daily report; password in the keychain (`paperless-backup-smtp`) or `SMTP_PASSWORD_FILE` |
| `network` | `mainnet` or `calibration` (testnet) |
| `payer` | the wallet address a session key acts for (or `PAYER_ADDRESS`) |
| `remoteSigner` | remote-signer mode, see below: `creditsUrl`, `product`, `account`, `payer`, `signer`, `tag`, `label` |

Environment: `PAPERLESS_DIR` (default: the parent folder), `PAPERLESS_SERVICE` (default `webserver`), `BACKUP_CONFIG`, `WALLET_KEY_FILE`, `AGE_IDENTITY_FILE`, `SMTP_PASSWORD_FILE`, `SESSION_KEY_FILE`, `PAYER_ADDRESS`, `BACKUP_KEY_FILE` (remote-signer mode), `PAPERLESS_MANAGE` (a command that takes `manage.py`'s arguments, where `docker compose exec` does not work).

## Backing up from a machine that must not hold the wallet

A machine that runs Paperless only for a while, a rented VM for example, can back up without the wallet key:

1. With the wallet, create a session key: `node backup.mjs session-login 8 session.key`. It may **create data sets and add pieces** until it expires, and nothing else. It cannot delete pieces, end storage or move funds. Storage is paid from the wallet's deposit in Filecoin Pay, so an operator approval with low limits caps what a session key can spend.
2. On the machine, set `SESSION_KEY_FILE` to that key and `payer` in `config.json` to the wallet address, then run `run` or `daily`. It does not need the age identity: backups are encrypted to `ageRecipient`, the public half. `prune` refuses there.
3. When the machine is done, `node backup.mjs session-revoke <address>` withdraws the key; otherwise it expires.

## Remote signer: backups paid with Le Space Credits

In this mode the machine holds **no payer and no session key**. Le Space pays the storage of every customer from one payer; a session key of that payer (the *signer*) signs each backup step, but only after Le Space Credits has checked it: that the backup is paid for, that the data set belongs to the account, that the provider is approved, the number of copies and the quota. The machine holds only a **backup key**, which signs its requests to the service.

It is on when `config.json` has `remoteSigner` and `BACKUP_KEY_FILE` names a file with the backup key (`0x` + 64 hex digits, readable only by the backup's user). It replaces `SESSION_KEY_FILE`; setting both is refused.

```json
"remoteSigner": {
  "creditsUrl": "https://credits.example.com",
  "product": "paperless-anywhere",
  "account": "0x00000000000000000000000000000000000000aa",
  "payer": "0x00000000000000000000000000000000000000cc",
  "signer": "0x00000000000000000000000000000000000000bb",
  "tag": "0123456789abcdef0123456789abcdef",
  "label": "paperless-backup"
}
```

| Field | Meaning |
|---|---|
| `creditsUrl` | the Le Space Credits service (https); steps are signed at `POST {creditsUrl}/v1/backup/sign` |
| `product` | the product the account bought backup months for |
| `account` | the customer's ledger address at the service |
| `payer` | the Le Space payer: owner of the data sets, named in every step's extraData |
| `signer` | the payer's session key that the service signs with; an answer from any other key is refused |
| `tag` | the account's tag (32 hex digits): data-set metadata `customer` |
| `label` | data-set metadata `app` (the service's label for the product and network) |

How it works:

- For each step synapse asks to sign (`CreateDataSet`, `AddPieces`, `SchedulePieceRemovals`), the tool computes the EIP-712 digest with synapse-core's storage domain and types, signs `ls-backup-sign/v1\n<product>\n<account, lowercase>\n<unix seconds>\n<digest>` with the backup key (EIP-191), and posts `{product, account, kind, message, timestamp, signature}` (numbers as decimal strings). It accepts the answer only if its `digest` is the local one and the signature is by `signer` for `payer`. The signer signs typed data and nothing else; requests go one at a time, one per second.
- Data sets carry only `app` = `label` and `customer` = `tag` (plus `withIPFSIndexing` if `datasetMetadata` has it). Never `withCDN`, no `source`. `datasetMetadata` is otherwise ignored.
- At most 3 copies (`copies` or `providerIds`): the service signs at most 3 data sets per account.
- `list` also shows the pieces on chain in this account's data sets (the payer's data sets whose metadata is this `label` and `tag`), so a new machine without the ledger sees what there is. `verify` and `prune` touch only those data sets.
- `prune` works: it schedules piece removals through the service, which signs them even when no backup is paid. The tool never terminates a data set.
- Le Space may end (terminate) a data set. It stays on chain until its end epoch, but takes no more pieces. `status`, `list` and `verify` show it as `ended <date> (epoch …)`. `verify` counts its copies as missing, and `prune` leaves it alone. Uploads never reuse it: synapse picks only data sets that have not ended for a provider, and otherwise creates a new one with a new `clientDataSetId`.
- `fund` refuses, `status` shows the mode and the data sets, and the daily mail has no account section: the payer is not the customer's.

Refusals of the service end the step with the code, the service's message and a hint, e.g. `remote signer refused CreateDataSet: NO_BACKUP (HTTP 409) no backup paid for now – …`. Codes: `SIGNATURE`, `REPLAY`, `STALE` (401), `NO_BACKUP`, `COPIES`, `QUOTA`, `ENDED` (409), `METADATA`, `PROVIDER` (400), `DATA_SET` (403), `TERMS` (412).

Tests: `npm test` runs the remote signer against a mocked service that checks each request as Le Space Credits does.

## Limits — read before relying on it

- **Locations are self-declared.** Each provider states its location in the on-chain registry; nobody verifies it.
- **Few approved providers so far.** In October 2026 there were 6 approved providers worldwide, 4 of them in Europe from 2 operators. `node backup.mjs providers` shows the current list.
- **No object lock.** You (or anyone with the wallet key) can delete pieces. For immutable retention, keep an additional copy on storage with object lock.
- **Full upload when something changed.** `daily` skips days without changes, but an upload is always the whole export (no deduplication); fine for archives of a few GiB.
- **Lose the age identity, lose the backup.** Keep a second copy of it off the machine.
- **Keep the clock right.** Deposits are signed with an expiry; a clock that is off by an hour makes them fail.
- **Pay as you go.** Storage runs on a 30-day prepaid lockup; an empty deposit ends the storage deals. `status` shows the runway.

## Related

- Paperless docs on backups: <https://docs.paperless-ngx.com/administration/#backup>
- Filecoin Onchain Cloud: <https://docs.filecoin.cloud>
- Provider approval criteria: <https://github.com/FilOzone/dealbot>

## License

MIT — by [Le Space](https://github.com/Le-Space).
