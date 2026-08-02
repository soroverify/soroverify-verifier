![Soroverify](assets/soroverify-verifier.svg)

[![CI](https://github.com/soroverify/soroverify-verifier/actions/workflows/ci.yml/badge.svg)](https://github.com/soroverify/soroverify-verifier/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

Independent contract source verification service for [Soroban](https://soroban.stellar.org).
It accepts source submissions for a deployed contract, rebuilds them in an isolated
container, compares the rebuilt wasm against what is actually deployed, and publishes
signed, multi-verifier results that consumers can check without trusting this
service's database.

**Related work.** StellarExpert's SEP-55 attestation and SoroSeal both touch
contract verification on Stellar. StellarExpert attests that a CI build ran at
a commit, without independently rebuilding. SoroSeal offers deterministic
builds and on-chain certification, but certifies at deploy time through its
own tooling. soroverify-verifier verifies any contract already on-chain,
deployed by any path, retroactively, and signs results per-verifier rather
than through a single trusted service.

**Status:** working implementation, 79 tests passing, CI configured to run lint +
typecheck + test. Core modules are
`ingest`, `resolve`, `meta`, `rebuild`, `compare`, `sign`, `store`, `queue`, `routes`.

## How it works

```
POST /submissions  ──►  validate (strict grammar)  ──►  queue (Postgres)
                                                          │
                    ┌─────────────────────────────────────┘
                    ▼
          1. Resolve deployed wasm hash  (contractId-only submissions, via RPC)
          2. Fetch the deployed wasm bytes              (RPC)
          3. Read SEP-58 build metadata from the wasm   (contractmetav0 sections)
          4. Fetch the submitted source tree            (git clone in an ephemeral container)
          5. Store the source tarball content-addressed (sha256 keyed, tamper-evident)
          6. Rebuild in an isolated container           (bldimg replay, --network none)
          7. Compare rebuilt wasm hash(es) to deployed  (verified / mismatch / inconclusive)
          8. Sign the result record and persist it      (Ed25519, verifier's key)
```

The result of a job is a **signed result record**:

```json
{
  "wasm_hash":    "…64 hex…",
  "source_repo":  "https://github.com/example/contract.git",
  "source_rev":   "main",
  "status":       "verified",
  "build_meta":   { "bldimg": "…", "rsver": "1.85.0", … },
  "verifier_id":  "a1b2c3d4e5f60718",
  "timestamp":    "2026-07-31T14:00:00.000Z",
  "public_key":   "…base64 SPKI DER…",
  "signature":    "…base64 Ed25519…"
}
```

`verifier_id` is the first 16 hex chars of the SHA-256 of the embedded public key,
and `signature` is over the canonical JSON (sorted keys, no whitespace) of the
payload fields only. A consumer can therefore verify any record end-to-end: check
that the public key's fingerprint matches `verifier_id`, re-canonicalize the payload,
and verify the signature. No database lookup is required: the record is
self-authenticating. See [src/sign.ts](src/sign.ts).

### Status vocabulary

| Status       | Meaning                                                              |
|--------------|----------------------------------------------------------------------|
| `verified`   | A rebuild produced a wasm whose SHA-256 equals the deployed hash.    |
| `mismatch`   | A rebuild completed but its wasm hash differs from the deployed one. |
| `inconclusive`| Could not reach a verdict (no SEP-58 metadata, fetch/build/RPC failure, or retries exhausted). Never conflated with `mismatch`. |
| `unverified` | No result *and* no submission exists for the hash at all (computed at the API layer). |

A job that is `inconclusive` retries with exponential backoff up to `max_attempts`
(default 3); a job whose build image is not on the allowlist is `rejected` and never
retried.

## Architecture

- **Postgres** is the coordination point: the submission queue and the signed result
  store. Job claiming uses `FOR UPDATE SKIP LOCKED`, so several worker instances
  sharing a database coordinate safely with no separate job broker. The schema is
  created idempotently at boot (`ensureSchema`).
- **Isolated rebuild** is the heart of the service. The build runs in a container
  with `--network none` (zero egress), no host bind mounts (data crosses via
  `docker cp`), CPU/memory/pids limits, a hard wall-clock timeout that kills the
  container, and the wasm's recorded rust version pinned via `RUSTUP_TOOLCHAIN`.
  The build image comes only from the wasm's own `bldimg` metadata and must be on an
  explicit digest-pinned allowlist (`ALLOWED_BUILD_IMAGES`) that fails closed when
  unset. See [src/rebuild.ts](src/rebuild.ts).
- **Verification records** are signed with this instance's Ed25519 key. Peers'
  records are fetched live and only accepted after their signatures verify against
  their embedded public keys. Nothing trusts a peer's database. See
  [src/routes.ts](src/routes.ts) and [src/sign.ts](src/sign.ts).
- **Content-addressed storage** keeps every submitted source tarball under the
  SHA-256 of its exact bytes; reads re-hash and reject mismatches, so stored
  artifacts cannot be silently swapped. See [src/store.ts](src/store.ts).

```
src/
  ingest.ts   POST /submissions validation and queue acceptance
  resolve.ts  contractId / wasm hash -> deployed wasm bytes (RPC)
  meta.ts     SEP-58/SEP-46 contractmetav0 build-metadata reader
  rebuild.ts  isolated container rebuild + source fetch (argument-array exec only)
  compare.ts  verified / mismatch / inconclusive resolution
  sign.ts     Ed25519-signed result records
  store.ts    content-addressed tarball storage
  queue.ts    bounded job runner + lease-timeout reaper
  db.ts       Postgres access layer (queue + results)
  routes.ts   HTTP routes (submit, status, verifications, sources)
  index.ts    entry point, wiring, graceful shutdown
```

## Requirements

- **Node.js >= 22**
- **Postgres** (any recent version; the schema uses `gen_random_uuid()`, built into
  PostgreSQL 13+, no extension needed)
- **Docker** with access to the pinned build images (the build step and the initial
  source fetch both run in containers)
- A **Soroban RPC endpoint** (mainnet, testnet, or local), used to fetch the
  deployed wasm bytes

## Quick start

```bash
npm install

# 1. Start Postgres (or point DATABASE_URL at an existing instance)
docker run -d --name soroverify-db -p 5432:5432 \
  -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=soroverify postgres:16

# 2. Build the verify image used for source fetches
docker build -t soroverify/verify-image:latest docker/verify-image

# 3. Run
export DATABASE_URL=postgres://postgres:dev@localhost:5432/soroverify
export STELLAR_RPC_URL=https://soroban-mainnet.stellar.org
export VERIFIER_PRIVATE_KEY="$(node -e "const {generateKeyPairSync}=require('crypto');console.log(generateKeyPairSync('ed25519').privateKey.export({format:'der',type:'pkcs8'}).toString('base64'))")"
npm run dev
```

The service listens on `0.0.0.0:8080` by default and is healthy at `GET /health`.

> **Note:** `VERIFIER_PRIVATE_KEY` unset generates an ephemeral identity per boot.
> Results stay self-verifying (each record carries its public key), but the
> `verifier_id` changes across restarts. Set a persistent key for a stable identity.

## Configuration

All configuration is via environment variables. Copy [`.env.example`](.env.example)
and adjust.

| Variable                 | Required | Default                   | Description |
|--------------------------|----------|---------------------------|-------------|
| `DATABASE_URL`           | **yes**  | —                         | Postgres connection string, e.g. `postgres://user:pass@host:5432/soroverify`. |
| `STELLAR_RPC_URL`        | **yes**  | —                         | Soroban RPC endpoint, e.g. `https://soroban-mainnet.stellar.org`. |
| `VERIFIER_PRIVATE_KEY`   | no       | ephemeral                 | base64 PKCS8 DER Ed25519 private key. Unset = fresh identity per boot. |
| `ALLOWED_BUILD_IMAGES`   | no       | empty (fail closed)       | Comma-separated, **digest-pinned** build images the service will run. Empty = every build rejected. |
| `VERIFY_IMAGE`           | no       | `soroverify/verify-image:latest` | Image used for the source-fetch step. |
| `PEER_VERIFIERS`         | no       | empty                     | Comma-separated base URLs of independent verifiers, queried for cross-checks. |
| `STORE_DIR`              | no       | `./data`                  | Content-addressed storage directory for source tarballs. |
| `WORK_DIR`               | no       | `/tmp/soroverify`         | Scratch directory for fetch/build artifacts. |
| `BUILD_TIMEOUT_MS`       | no       | `600000` (10 min)         | Wall-clock limit for one rebuild; the container is killed when it trips. |
| `FETCH_TIMEOUT_MS`       | no       | `300000` (5 min)          | Wall-clock limit for the source fetch. |
| `BUILD_CPUS`             | no       | `2`                       | CPU limit for the build container. |
| `BUILD_MEMORY_BYTES`     | no       | `2147483648` (2 GiB)      | Memory limit for the build container; swap disabled by setting swap = memory. |
| `BUILD_PIDS_LIMIT`       | no       | `512`                     | Max processes inside the build container. |
| `JOB_CONCURRENCY`        | no       | `4`                       | Max jobs processed at once. |
| `HOST`                   | no       | `0.0.0.0`                 | Bind address. |
| `PORT`                   | no       | `8080`                    | Listen port. |

### Generating a persistent verifier key

```bash
node -e "const {generateKeyPairSync}=require('crypto');console.log(generateKeyPairSync('ed25519').privateKey.export({format:'der',type:'pkcs8'}).toString('base64'))"
```

Put the output in `VERIFIER_PRIVATE_KEY`. The public key and its fingerprint
(`verifier_id`) are derived from it and travel with every signed record.

### Build image allowlist

`ALLOWED_BUILD_IMAGES` must contain **digest-pinned** references. A mutable tag
defeats the reproducibility guarantee and is rejected outright:

```
ALLOWED_BUILD_IMAGES=ghcr.io/soroverify/verify@sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08,…
```

(The digest above is an illustrative placeholder. Replace it with a real digest
you have vetted; see `.env.example`.)

When unset or empty the service rejects every build (fail-closed). The wasm's
recorded `bldimg` value is the only source of build images, and only allowlisted,
digest-pinned ones ever run.

## API

### `GET /health`

Always `200 {"status":"ok"}`. Liveness only. It does not check Postgres, Docker,
or RPC connectivity.

### `POST /submissions`

Queue a verification request. The body is validated against a strict grammar;
anything non-conforming gets a `400` with machine-readable issues, and **nothing is
inserted or executed**. Unknown fields are rejected so a typo cannot silently change
behavior.

```json
{
  "contractId": "C…",                    // optional, but contractId or wasmHash required
  "wasmHash":   "…64 hex or base64…",    // optional, normalized to lowercase hex
  "sourceRepo": "https://github.com/example/contract.git",
  "sourceRev":  "main"
}
```

The optional `buildImage` field (a container image reference) is accepted and
stored, but is currently informational: the rebuild uses the `bldimg` value
recorded inside the deployed wasm, never a client-supplied image. Omit the field
unless you have a reason to set it (note `null` is rejected: only a valid image
reference or an omitted field passes validation).

`202 {"submissionId": "<uuid>"}` on acceptance. The rebuild runs asynchronously;
the response never blocks on it.

### `GET /status/:submissionId`

Poll the job lifecycle:

```json
{
  "submissionId": "<uuid>",
  "contractId":   "C…",
  "wasmHash":     "…64 hex…",
  "sourceRepo":   "…",
  "sourceRev":    "…",
  "status":       "pending",
  "attempts":     0,
  "maxAttempts":  3,
  "createdAt":    "2026-07-31T14:00:00.000Z",
  "updatedAt":    "2026-07-31T14:00:00.000Z",
  "buildLog":     null,
  "result":       null
}
```

`status` is one of `pending`, `running`, `verified`, `mismatch`, `inconclusive`,
`rejected`. When the job has resolved, `result` carries the signed record
(see above) and `buildLog` carries the captured fetch/build output.

### `GET /verifications/:wasmHash`

The read path consumers care about. Aggregates this instance's signed results with
verified peer results and reports an aggregate status. Peer records are only
included if their signatures verify against their embedded public keys **and** they
are about the queried hash.

```json
{
  "wasmHash": "…64 hex…",
  "status":   "verified",
  "results":  [ { …signed result record… } ],
  "sources":  [ { "sha256": "…", "url": "/sources/…" } ]
}
```

`wasmHash` may be supplied in hex or base64; it is normalized to lowercase hex.
A hash with no result and no submission resolves to `unverified`; a submission that
failed to build resolves to `inconclusive`.

### `GET /sources/:sha256`

Download the stored source archive (gzip tarball) for a content address.

## Security model

This service treats its inputs as hostile and its outputs as untrusted.

- **Untrusted input never reaches an interpreter.** Every submitted field passes a
  conservative grammar (see [src/ingest.ts](src/ingest.ts)); all external commands
  (git, docker) are invoked as `(executable, string[])` argument arrays, never
  shell strings, and untrusted values arrive only as positional arguments to a
  static entrypoint script.
- **The build cannot phone home.** Build containers run with `--network none`, so a
  compromised or malicious build cannot exfiltrate anything or fetch unexpected
  dependencies.
- **No host bind mounts.** Source crosses the container boundary via `docker cp`
  (black-box), never a mounted directory. Containers are removed after every job.
- **Reproducibility is enforced, not assumed.** Only digest-pinned images on an
  operator-vetted allowlist can run; the wasm's recorded rust version is pinned with
  `RUSTUP_TOOLCHAIN` so an in-source `rust-toolchain.toml` cannot swap toolchains
  mid-build.
- **Results are self-authenticating.** Signatures are verified against the embedded
  public key *and* the public key's fingerprint must equal `verifier_id`. Peers are
  never trusted through their databases, only through their signatures.
- **Storage is tamper-evident.** Source tarballs are content-addressed by SHA-256
  and re-hashed on every read.
- **Runaway jobs are bounded.** Hard wall-clock timeouts (container killed), CPU /
  memory / pids limits, a bounded retry budget, and a lease-timeout reaper that
  rescues rows left `running` by dead workers.

See [SECURITY.md](SECURITY.md) for the threat model and vulnerability reporting.

## Development

```bash
npm run dev        # tsx watch src/index.ts
npm run build      # tsc -p tsconfig.build.json
npm start          # node dist/index.js
npm run typecheck  # tsc -p tsconfig.json
npm run lint       # eslint .
npm test           # vitest run
```

The unit tests exercise the injectable `CommandExecutor`. **No real Docker or
Postgres is required to run them**. See [CONTRIBUTING.md](CONTRIBUTING.md) for the
full development workflow.

## Repository layout

```
src/                     service implementation
test/                    vitest suites (ingest, rebuild, smoke)
docker/verify-image/     Dockerfile for the pinned source-fetch image
.github/workflows/       CI: lint + typecheck + test
```

## License

[Apache-2.0](LICENSE).

## Maintainers

| Name | GitHub |
|---|---|
| Hollujay | [@Hollujay](https://github.com/Hollujay) |
| emarkees | [@emarkees](https://github.com/emarkees) |

## Contributors

<a href="https://github.com/soroverify/soroverify-verifier/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=soroverify/soroverify-verifier" />
</a>
