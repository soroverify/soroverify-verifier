# Operations

This is a practical guide for running a soroverify-verifier instance: every
configuration variable and what happens if it is left unset, the build-image
allowlist policy and why it fails closed, what to watch in production, the
connection-retry behavior on the RPC path, and how to recognize and diagnose
a stuck or failed job.

## Configuration reference

All configuration is read from the process environment. `.env.example` at the
repo root is the template; copy it to `.env` and adjust.

| Variable | Required | Default | What happens if unset |
|---|---|---|---|
| `DATABASE_URL` | yes | none | The process fails to boot. There is no fallback; the queue and result store are both Postgres. |
| `STELLAR_RPC_URL` | yes | none | The process fails to boot. Every job needs this to resolve deployed wasm hashes and fetch wasm bytes. |
| `VERIFIER_PRIVATE_KEY` | no | ephemeral | A fresh Ed25519 identity is generated on every boot. Results still self-verify (each signed record carries its own public key), but `verifier_id` changes on every restart, so a consumer tracking "results from verifier X" loses continuity across restarts. Set this for a stable identity in production. |
| `ALLOWED_BUILD_IMAGES` | no | empty | Empty means fail closed: every submitted build is rejected, because `isAllowedBuildImage` (`src/rebuild.ts`) checks membership against this set and an empty set matches nothing. The service is safe by default but does no work until this is configured. |
| `VERIFY_IMAGE` | no | `soroverify/verify-image:latest` | The source-fetch step uses the default image name. If that image has not been built locally or pushed to a reachable registry, every fetch step fails and every job resolves `inconclusive`. |
| `PEER_VERIFIERS` | no | empty | No peer cross-checking happens; `GET /verifications/*` responses only ever contain this instance's own results. Not a correctness problem, just a smaller trusted set for consumers who query only this instance. |
| `STORE_DIR` | no | `./data` | Source tarballs are stored content-addressed under this relative path. If the process's working directory changes between restarts (e.g. different deploy tooling), this can point at a different location than intended; set an absolute path in production. |
| `WORK_DIR` | no | `/tmp/soroverify` | Scratch directory for the tarball and extracted build output during a job. Cleaned up per job in `cleanupContainer` (`src/rebuild.ts`); nothing special happens if left at the default beyond sharing `/tmp` with other processes. |
| `BUILD_TIMEOUT_MS` | no | `600000` (10 min) | Longer default wall-clock budget per rebuild. This also feeds the lease-timeout reaper's staleness window (see below), so raising it also raises how long a stuck job can sit before being reclaimed. |
| `FETCH_TIMEOUT_MS` | no | `300000` (5 min) | Same as above, for the source-fetch container. |
| `BUILD_CPUS` | no | `2` | Build containers get up to 2 CPUs each; unset is a reasonable default, not a failure mode. |
| `BUILD_MEMORY_BYTES` | no | `2147483648` (2 GiB) | Same; a build that genuinely needs more memory than this will fail (OOM inside the container), which surfaces as a non-zero container exit and an `inconclusive` result, not a crash of the service. |
| `BUILD_PIDS_LIMIT` | no | `512` | Same; bounds a runaway build (e.g. a fork bomb) rather than affecting normal builds. |
| `JOB_CONCURRENCY` | no | `4` | Up to 4 jobs run at once. Unset is fine for small deployments; raise it if the host has spare CPU/memory/Docker headroom and the queue backs up. |
| `HOST` | no | `0.0.0.0` | Binds all interfaces by default. |
| `PORT` | no | `8080` | Listens on 8080 by default. |
| `CORS_ALLOWED_ORIGINS` | no | `*` | The three public read endpoints (`GET /status/:submissionId`, `GET /verifications/:wasmHash`, `GET /verifications/by-contract/:contractId`) allow any origin by default. `POST /submissions` is never CORS-enabled regardless of this setting; it is same-origin only. No credentials are ever accepted on the CORS path (`access-control-allow-credentials` is never emitted, see `src/routes.ts`). |

Two variables that are required to boot (`DATABASE_URL`, `STELLAR_RPC_URL`)
fail loudly and immediately. Everything else degrades gracefully to a safe or
merely-less-capable default rather than crashing.

## Requirements this implies

Per the top-level `README.md`: Node.js 22+, a reachable Postgres instance,
Docker with access to whatever build images end up allowlisted, and a Soroban
RPC endpoint (mainnet, testnet, or a local node). Docker is not optional:
both the rebuild step and the source-fetch step run inside containers. See
[DEPLOYMENT.md](DEPLOYMENT.md) for what that requirement rules out on the
hosting side.

## The build-image allowlist, and why it fails closed

`ALLOWED_BUILD_IMAGES` is a comma-separated list of **digest-pinned** image
references, e.g.:

```
ALLOWED_BUILD_IMAGES=ghcr.io/soroverify/verify@sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08
```

`isAllowedBuildImage` in `src/rebuild.ts` enforces two things before a build
is ever allowed to run:

1. The image reference must match `^[^\s]+@sha256:[0-9a-f]{64}$`. A tag-only
   reference (`myimage:latest`) is rejected outright, because a mutable tag
   defeats the entire reproducibility guarantee: the image an operator vetted
   today could silently become a different image tomorrow.
2. The image must be present in the configured allowlist set.

The build image the service actually runs is never chosen by the submitter.
It comes only from the target wasm's own `bldimg` metadata (read by
`src/meta.ts` from the deployed contract's `contractmetav0` section). The
allowlist is what stops that recorded image from being run unvetted: an
operator has to have explicitly added the image's digest before any build
using it is permitted.

The default when `ALLOWED_BUILD_IMAGES` is unset or empty is an empty set,
which matches nothing, which means every build is rejected. This is a
deliberate fail-closed default: a misconfigured or freshly-deployed instance
does no potentially-dangerous work rather than running an unvetted image by
accident. The cost is that a new deployment does nothing useful until an
operator makes an explicit, positive decision about which images to trust.

## What to monitor in production

- **Health.** `GET /health` is liveness only; it always returns `200
  {"status":"ok"}` and does not check Postgres, Docker, or RPC connectivity.
  It tells you the process is up, not that it can do anything useful.
- **Job backlog.** Watch the count of `pending`/`running` rows in the
  submissions table growing over time relative to `JOB_CONCURRENCY`; a
  sustained backlog means jobs are arriving faster than they can be
  processed, or something downstream (Docker, RPC, git remotes) is slow or
  failing.
- **Reclaimed jobs.** `JobRunner.reclaimStuckJobs` (`src/queue.ts`) logs at
  `warn` every time it resets a `running` row back to `inconclusive` because
  its worker appears to have died or hung. A steady trickle of these in logs
  is a signal that workers are crashing, being OOM-killed, or that Docker
  itself is unhealthy on the host; log them and alert on volume, not on any
  single occurrence.
- **Consecutive claim failures.** The poll loop in `src/queue.ts` logs at
  `error` with an increasing `backoffMs` whenever `claimNextJob` fails
  (typically a database connectivity problem), and backs off exponentially up
  to 60 seconds between attempts. This is the earliest signal of a database
  outage from inside the job runner itself.
- **Verifier identity stability.** If `VERIFIER_PRIVATE_KEY` is unset,
  `verifier_id` changes on every restart. In production this is worth
  monitoring for: an unexpected `verifier_id` change usually means the
  process restarted without the persistent key configured, which silently
  breaks continuity for anyone tracking this instance's results specifically.
- **Rejected vs inconclusive rate.** A `rejected` submission means the
  target wasm's recorded `bldimg` was not on the allowlist; a rising rate of
  these may mean real, common build images are missing from
  `ALLOWED_BUILD_IMAGES` and should be reviewed for addition (after vetting),
  not necessarily that anything is broken.

## Connection-pooling retry logic on the RPC path

The Soroban RPC resolver (`src/resolve.ts`) retries certain failures
in-process before they are ever surfaced to a job. This closes a real,
observed failure mode fixed in commit `02647a5` ("fix(resolve): handle
transient RPC connection failures with retry or connection reset"): a
long-running process reusing an idle pooled keep-alive HTTP connection that
the RPC server has silently closed on its end gets a bare `fetch failed` on
the first attempt, while a fresh one-off process (which always opens a new
connection) succeeds immediately. Without the fix, every long-lived verifier
process would eventually hit this and burn a retry attempt from the job
queue's own bounded retry budget on what is really a transport artifact, not
a real failure.

`Resolver.withTransientRetry` retries up to `maxAttempts` (default 3) with a
short delay (`retryDelayMs`, default 250ms) between attempts, but classifies
failures first via `isNotFound`: a `NotFoundError` from the SDK, or the RPC
path's non-`Error` `{ code: 404 }` rejection shape, is treated as permanent
(`not_found`) and is never retried, because the contract or wasm genuinely
does not exist and retrying only delays an already-correct answer. Everything
else is treated as `transient` and gets the retry-with-delay treatment. This
retry is entirely internal to `resolve.ts`; it happens before a job's own
`inconclusive`/retry-with-backoff logic in `src/queue.ts` ever sees the
failure, so a single flaky connection does not cost a full job-level retry
attempt.

## Diagnosing a stuck or failed job

A submission's `GET /status/:submissionId` response shows `status`,
`attempts`, `maxAttempts`, `buildLog`, and `result`. Use this to distinguish
the failure modes below.

**Stuck in `running` past the wall-clock budget.** This means the worker
that claimed it died or hung before it could record an outcome. The
lease-timeout reaper (`reclaimStuckJobs`) will reset it to `inconclusive`
with a bumped attempt count once it has been `running` longer than the
greater of `BUILD_TIMEOUT_MS`/`FETCH_TIMEOUT_MS` plus a two-minute grace
margin, and it re-enters the normal retry queue from there. If a row stays
`running` well past that window without being reclaimed, check whether the
job-runner interval that drives `reclaimStuckJobs` (wired in `src/index.ts`)
is actually running, and check Postgres connectivity from that process.

**Resolves to `inconclusive` after exhausting retries.** Check `buildLog` on
the final status response; every inconclusive path in `src/queue.ts` records
a reason string alongside the log. Common causes, in the order the pipeline
hits them: the resolver could not resolve a `contractId` to a wasm hash or
fetch the wasm bytes (RPC problem, or the contract genuinely is not deployed
if the failure is a permanent `not_found`); the target wasm carries no
SEP-58 `bldimg` metadata at all, so there is nothing to replay; the source
fetch failed (bad `sourceRepo`/`sourceRev`, network issue reaching the git
remote, or the fetch container exceeded `FETCH_TIMEOUT_MS`); or the rebuild
itself failed inside the container (check the tail of `buildLog`, which is
the container's captured stdout/stderr from `docker logs`).

**Resolves to `rejected`.** The target wasm's `bldimg` was not on
`ALLOWED_BUILD_IMAGES`, or was not digest-pinned. This is terminal and is
never retried; fix it by vetting and adding the correct digest-pinned image
reference to the allowlist and resubmitting, not by waiting.

**Resolves to `mismatch`.** The rebuild completed successfully and produced
a wasm hash that does not match the deployed one. This is not a failure of
the service; it is the pipeline correctly reporting that the submitted
source does not reproduce the deployed bytecode. Nothing to diagnose on the
operator side beyond confirming the submitted `sourceRepo`/`sourceRev` really
is what the submitter intended.
