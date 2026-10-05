# Security

This page says how a backup is protected, which keys exist and where they live, and what stays visible to others. Read it before you rely on the backup, and before you put the keys anywhere.

## Encryption: done here, not by Filecoin

The Synapse SDK uploads the bytes it is given, unchanged. Anyone who knows a piece's **PieceCID** can fetch it from the providers. So the script encrypts **before** anything leaves the machine:

1. `document_exporter` writes a zip of all documents and the database into Paperless' `export/` folder.
2. The zip is read into memory and encrypted with [age](https://age-encryption.org) ([`age-encryption`](https://www.npmjs.com/package/age-encryption), the JavaScript implementation of the age format).
3. The plain zip is deleted right away — also when encryption fails (`finally`).
4. Only the encrypted bytes are handed to the SDK and uploaded.

**How age encrypts:** a random file key per backup encrypts the data (ChaCha20-Poly1305, authenticated: any change to the ciphertext is detected on decryption). The file key is wrapped for the recipient's **X25519** public key; only the matching private key can unwrap it.

`plan` proves the round trip: it encrypts the export, decrypts it again with the stored private key and compares the SHA-256 before anything is uploaded. `restore` checks the downloaded bytes against the SHA-256 recorded at upload before decrypting.

The format is open. A stored piece *is* an age file, so a backup can be decrypted without this script — download it from a provider's piece URL (in `ledger.json`, `retrievalUrl`) and run:

```
age -d -i key.txt piece.age > export.zip
```

## Keys and where they live

| Key | What it does | Where | Who needs it |
|---|---|---|---|
| age **recipient** (`age1…`) | encrypts | `config.json` → `ageRecipient` | every backup run; not secret |
| age **identity** (`AGE-SECRET-KEY-1…`) | decrypts | macOS keychain `paperless-backup-age-identity`, or the file in `AGE_IDENTITY_FILE` | `restore` and the check in `plan` only |
| **wallet private key** | pays for storage, can move the wallet's USDFC and FIL, can delete pieces | macOS keychain `paperless-backup-filecoin-wallet`, or `WALLET_KEY_FILE` | `fund`, `run`, `daily`, `verify`, `prune`, `status` |
| **SMTP password** | sends the daily report | macOS keychain `paperless-backup-smtp`, or `SMTP_PASSWORD_FILE` | `daily` |

The script never prints a secret and never writes one into `config.json`, `ledger.json`, `state.json` or a log. `init-key` refuses to replace an existing identity.

**Keep a copy of the age identity outside the machine** (password manager, paper). Lose it, and every backup is unreadable — for you and for everyone else. On macOS:

```
security find-generic-password -s paperless-backup-age-identity -a "$USER" -w
```

**Give the script a wallet that holds only what the backup needs.** Use a separate account (in MetaMask: "Add account"), give the script that account's **private key**, never a seed phrase. Whoever gets that key can spend the wallet and delete the stored pieces; they cannot read the backups.

## What stays visible to others

Encryption hides the content. It does not hide that backups happen. On the public Filecoin chain and at the providers anyone can see:

- the **wallet address** that pays, and its USDFC and FIL balances;
- **when** a piece was added, its **size**, its **PieceCID**, and **which providers** hold it;
- the **data set metadata** (`datasetMetadata`, default `{"app": "paperless-backup"}`) and the SDK's `source` tag `paperless-backup`;
- deposits, rates and how long the deposit lasts.

So an observer can tell that some wallet backs up roughly this much data, this often, to these providers. If that matters, change `datasetMetadata`, and do not link the wallet address to your name. Anyone can download the encrypted pieces; without the age identity they are random bytes.

## Plaintext on your own machine

- **During a run:** the export zip sits in Paperless' `export/` folder until it is encrypted (usually one to two minutes), and in memory.
- **After `restore`:** the restored zip contains every document unencrypted. Delete it when you are done.
- `ledger.json` holds PieceCIDs, provider ids, data set ids and the SHA-256 of the plain and the encrypted export. Not secret, but keep it: together with the age identity it is all you need to restore on another machine. (The PieceCID is also in each daily mail.)
- The daily mail contains the PieceCID, the providers and the balances; it does not contain keys.

## Deleting

`prune` asks the providers to remove old pieces; it keeps the newest complete backup. Removal on Filecoin is not instant erasure: a provider may hold the bytes until its own cleanup runs. That is one more reason the content must be encrypted. If a key ever leaks, do not rely on deletion — make a new age identity (move the old one out of the way first; `init-key` will not overwrite it), back up again, and treat the old pieces as readable by whoever has the old key.

## What this does not protect against

- A compromised machine: whoever controls it while you are logged in can read the keychain entries the script uses.
- Losing the age identity.
- A drained deposit: when Filecoin Pay runs out, the providers may end storage. The daily mail warns below `daily.warnRunwayDays`.
- Retention rules (e.g. GoBD): pieces can be deleted by the wallet owner. For immutable retention keep an additional copy on storage with object lock.

## Reporting a vulnerability

Please do not open a public issue for a weakness that could be exploited. Use GitHub's **private vulnerability reporting** (the repository's *Security* tab → *Report a vulnerability*). Public text should say what was hardened, not how to attack what is not.
