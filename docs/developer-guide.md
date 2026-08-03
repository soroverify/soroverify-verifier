# Developer guide

## Codebase structure

```
src/
  index.ts       API server entry point
  routes.ts      HTTP route handlers
  ingest.ts      POST /submissions — input validation boundary
  resolve.ts     contractId -> deployed wasm hash, via RPC
  meta.ts        reads SEP-58 build metadata from a wasm binary
  rebuild.ts     isolated container rebuild — the highest-stakes file in the repo
  compare.ts     rebuilt hash vs deployed hash -> status
  sign.ts        signed result record creation and verification
  store.ts       content-addressed source tarball storage
  queue.ts       job runner, including the lease-timeout reaper for stuck jobs
docker/verify-image/   Dockerfile for the pinned source-fetch image
test/                  test suites, organized to mirror src/
```

## Environment variables

See `.env.example` in the repository for the authoritative, commented list.
The essentials to get a local instance running:

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | Yes | Postgres connection string. Schema is created idempotently at boot. |
| `STELLAR_RPC_URL` | Yes | Use `https://soroban-testnet.stellar.org` for local development. |
| `VERIFIER_PRIVATE_KEY` | No | Base64 PKCS8 DER Ed25519 key. Unset generates an ephemeral identity per boot — fine for local dev, not for a public instance. |
| `ALLOWED_BUILD_IMAGES` | No, but fails closed if unset | Comma-separated, digest-pinned. Every submission is rejected until this is set. |
| `PORT` | No | Defaults to 8080. |

## Local setup

```bash
git clone https://github.com/soroverify/soroverify-verifier.git
cd soroverify-verifier
npm install
cp .env.example .env
# Postgres, if you don't already have one running:
docker run --name soroverify-pg -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=soroverify -p 5432:5432 -d postgres:16
```

Set `STELLAR_RPC_URL=https://soroban-testnet.stellar.org` in `.env` — the
default in `.env.example` points at mainnet, which may not be reachable from
every network.

**If every contract lookup fails with an RPC/fetch error even though a plain
`curl` to the same RPC URL succeeds**, this is likely a broken or slow IPv6
route to the RPC endpoint on your network, not a bug in this service. Node's
HTTP client can hit that broken path by default even when tools like `curl`
fall back to IPv4 automatically. Fix it by forcing IPv4 first, passed as a
direct argument to `node` (not via `NODE_OPTIONS`, which does not reliably
propagate through tsx watch):

```bash
node --dns-result-order=ipv4first --env-file=.env node_modules/.bin/tsx watch src/index.ts
```

**This service does not currently auto-load `.env`.** Plain `npm run dev`
will fail with a missing-environment-variable error. Run it with:

```bash
node --env-file=.env node_modules/.bin/tsx watch src/index.ts
```

This is a known, tracked gap — check the repository's open issues before
assuming it's still true by the time you read this.

## Verifying your setup

```bash
curl http://localhost:8080/verifications/0000000000000000000000000000000000000000000000000000000000000000
```

A healthy instance returns a clean `unverified` envelope for this all-zeros
hash, not a connection error.

## Running the test suite

```bash
npm run typecheck
npm run lint
npm test
```

All three are required to pass in CI on every push to `main`. `test/rebuild.test.ts`
in particular exercises the container isolation guarantees — network lockdown,
the digest-pinned allowlist, the wall-clock timeout — using the injectable
`CommandExecutor` interface rather than a real Docker daemon, so it runs
anywhere without requiring Docker in CI.

## The one file to read carefully before touching rebuild logic

`src/rebuild.ts` is where untrusted, attacker-controlled source actually
executes. Every change to it should be reviewed against the threat model in
`SECURITY.md`, and any change to isolation behavior (network policy, resource
limits, image validation) needs a corresponding test in
`test/rebuild.test.ts` before it's considered complete.
