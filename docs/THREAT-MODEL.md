# Threat model

This is the expanded version of the threat model summarized in
[SECURITY.md](../SECURITY.md). It exists so a reader, an auditor, or an
operator can understand exactly which adversaries this service is designed
against, what each adversary can and cannot do, and which code path is
responsible for the defense. It does not introduce any new claim beyond what
SECURITY.md states; it explains the same boundaries in more depth and points
at the specific files involved.

## Why this matters

Soroverify's output is a signed assertion that a piece of source code
produces specific deployed bytecode. Both the correctness of that assertion
and the isolation of the process that produces it are security properties.
A break in either one turns a trust signal into a false one, which is worse
than no signal at all.

## Adversary 1: malicious submitters

**Who they are.** Anyone can call `POST /submissions`. There is no
authentication on that endpoint, by design; the service is meant to accept
submissions from the public.

**What they can do.** Submit an arbitrary `contractId`, `wasmHash`,
`sourceRepo`, `sourceRev`, and `buildImage`, and cause the service to spend
compute cloning a repo and running a rebuild.

**What they cannot do.** Reach a shell, a database, or a filesystem path with
attacker-controlled bytes. Every submitted field is validated against a
conservative grammar before it is inserted into the queue at all. `sourceRepo`
must match a URL whitelist that excludes shell metacharacters and control
characters, `sourceRev` is restricted to characters valid in a git revision,
`contractId` must be a valid StrKey C-address, `wasmHash` must be a well-formed
32-byte hex or base64 value, and `buildImage` (when present) must match an
image-reference pattern. Unknown fields are rejected outright so a typo or an
injected extra field cannot silently change behavior. Validation never
throws; malformed input degrades to a structured `400` with per-field
reasons, never a crash or an unvalidated write.

**Defending code path.** `src/ingest.ts`, specifically
`validateAndNormalize`. Every value that eventually reaches `git` or `docker`
in `src/rebuild.ts` originates from a field that passed this boundary, and it
is always passed as a positional argument-array entry, never interpolated
into a shell string (see `FETCH_SCRIPT` and the container `create` args in
`src/rebuild.ts`, which take `sh -c <static script> sh <args>` so untrusted
values land in `$1`/`$2`/`"$@"`, never in the script text itself).

## Adversary 2: hostile build images and hostile source

**Who they are.** The submitted source is attacker-controlled code that will
be compiled and executed inside a container. The build image itself, if an
operator has misconfigured the allowlist, could also be adversarial.

**What they can do.** Run arbitrary code during the build, including code
that tries to consume unbounded CPU, memory, disk, or process table entries,
or that tries to reach out to the network to exfiltrate data or fetch
unexpected dependencies.

**What they cannot do.**

- Reach the network. The build container is created with `--network none`
  (see the `createArgs` in `runRebuild`, `src/rebuild.ts`), which is the
  load-bearing isolation guarantee of the whole service: zero egress means a
  compromised or malicious build cannot phone home no matter what it tries.
- Consume unbounded resources. `--memory`/`--memory-swap` (swap disabled by
  setting them equal), `--cpus`, and `--pids-limit` bound a runaway build,
  and a hard wall-clock timeout (`buildTimeoutMs`, default 10 minutes) kills
  the container via `docker wait` with a timeout and an explicit `docker
  kill` on trip.
- Persist. Containers are named per submission/attempt and removed in the
  `finally` block of `runRebuild` (`cleanupContainer`) on every exit path,
  success or failure. No host bind mount is ever used; the source archive
  crosses the container boundary via `docker cp` in and the rebuilt wasm via
  `docker cp` out, so the host filesystem is never mounted into the
  container.
- Choose their own build image. The image that runs comes only from the
  target wasm's own `bldimg` metadata (SEP-58, read in `src/meta.ts`), and
  `isAllowedBuildImage` in `src/rebuild.ts` requires it to be digest-pinned
  (`@sha256:<64 hex>`, a mutable tag is rejected outright) and present in the
  operator-configured `ALLOWED_BUILD_IMAGES` allowlist. An empty or unset
  allowlist rejects every build; this is fail-closed by construction, not a
  default that happens to be safe.

**One narrow exception.** The initial source-fetch step (`fetchSourceTarball`
in `src/rebuild.ts`) does have network egress, because it needs to `git
clone` the submitted repository. This is the only egress anywhere in the
pipeline. That container runs a static script (`FETCH_SCRIPT`) with the repo
and rev as positional arguments, carries no secrets, and is destroyed with
`--rm` after it produces the tarball on stdout.

**Defending code path.** `src/rebuild.ts` end to end: `isAllowedBuildImage`,
`parseBuildImageAllowlist`, `runRebuild`, `fetchSourceTarball`,
`cleanupContainer`. `src/meta.ts` (`parseWasmMeta`, `readBuildEnvironment`)
for where `bldimg` is read from the wasm's own metadata; that reader never
throws on a malformed wasm, so a corrupted `contractmetav0` section degrades
to "no build metadata" (an `inconclusive` result) rather than crashing the
job.

## Adversary 3: malicious peer verifiers

**Who they are.** Other verifier instances listed in `PEER_VERIFIERS`. This
service queries them over HTTP to aggregate cross-verifier results, and
nothing stops an operator from pointing `PEER_VERIFIERS` at a dishonest or
compromised endpoint.

**What they can do.** Return any JSON they like from
`<base>/verifications/<hash>`, including a well-formed but entirely fabricated
result record, or attempt to answer for a hash they were never asked about.

**What they cannot do.** Have a fabricated record accepted. A peer result is
only kept if all three of the following hold:

1. It structurally parses as a signed result record (`parseSignedResult` in
   `src/routes.ts` rejects anything that does not match the expected shape,
   never throwing).
2. Its embedded public key's SHA-256 fingerprint equals its claimed
   `verifier_id`, and its Ed25519 signature verifies against that same
   embedded public key over the canonical (sorted-key, no-whitespace) JSON of
   the payload fields (`verifyResultRecord` in `src/sign.ts`).
3. The normalized `wasm_hash` in the record actually matches the hash that
   was queried, so a peer cannot answer for one hash with a signed record
   about a different one (`normalizeWasmHashHex(parsed.wasm_hash) ===
   wasmHash` in `fetchPeerResults`, `src/routes.ts`).

A peer's database content, HTTP response codes, or timing are never trusted
on their own; only a valid signature over the exact payload counts. A peer
that is unreachable, slow (each peer fetch has a 5-second timeout), or
returns malformed JSON is logged and skipped, never treated as fatal to the
request.

**Defending code path.** `src/sign.ts` (`verifyResultRecord`,
`canonicalJson`), `src/routes.ts` (`fetchPeerResults`, `parseSignedResult`,
`dedupe`).

## Adversary 4: tampering with stored artifacts

**Who they are.** Anyone with access to the storage backend outside the
application, whether through a filesystem-level compromise, an operational
mistake, or a bug elsewhere in the service that could otherwise write
corrupted or substituted bytes.

**What they can do.** Attempt to replace a stored source tarball's bytes on
disk with different content while keeping the same content-address path.

**What they cannot do.** Have that substitution go unnoticed. Every stored
tarball lives at a path derived from the SHA-256 of its own bytes
(`ContentStore.put` in `src/store.ts`, layout `<baseDir>/<first two hex
chars>/<full sha256>`), and every read re-hashes the bytes and throws an
integrity-violation error if the hash does not match the requested address
(`ContentStore.get`). `put` writes to a temporary path with an exclusive
create flag (`{ flag: 'wx' }`) and only then atomically renames into place,
so a partially written file is never visible at the final path, and an
existing artifact under the same address is never rewritten (content-address
collision on non-identical bytes is cryptographically infeasible, so "already
present" is treated as "already correct").

**Defending code path.** `src/store.ts`, specifically `ContentStore.put` and
`ContentStore.get`.

## Adversary 5: compromised or transient infrastructure

**Who they are.** Not an intentional attacker, but a category of failure that
a security-sensitive service still has to defend against: a worker process
that crashes or hangs mid-job, a Postgres connection that silently goes
stale, or multiple worker instances racing over the same row.

**What can go wrong without a defense.** A job could be claimed and then
never finish if its worker dies, permanently wedging that submission.
Multiple workers sharing one database could double-process the same job.
A long-running process reusing a pooled HTTP connection that the RPC server
has silently closed can see a single spurious `fetch failed` even though the
RPC endpoint is healthy.

**What the service does about it.**

- Job claiming uses `FOR UPDATE SKIP LOCKED` in the Postgres queue query, so
  multiple worker instances sharing a database coordinate safely without a
  separate job broker and cannot claim the same row twice.
- A lease-timeout reaper (`reclaimStuckJobs` in `src/queue.ts`, driven on a
  fixed interval from `src/index.ts`) resets any row left `running` past the
  longer of the build and fetch wall-clock windows, plus a grace margin, back
  to `inconclusive` with its attempt counter bumped, so a dead or hung
  worker's job re-enters the bounded retry budget instead of being wedged
  forever.
- The Soroban RPC resolver retries transient connection failures in-process
  before ever surfacing them to the job as an error. This closes a real,
  previously-observed failure mode: a long-running process reusing an idle
  pooled keep-alive HTTP connection that the RPC server has silently closed
  gets a `fetch failed` on the first attempt, while a fresh connection
  succeeds immediately after. `Resolver.withTransientRetry` in
  `src/resolve.ts` retries up to `maxAttempts` (default 3) with a short delay
  between attempts, but only for failures classified as `transient`; a
  `not_found` failure (the contract or wasm genuinely does not exist on the
  network, including the SDK's non-`Error` `{ code: 404 }` rejection shape)
  is never retried, because retrying a permanent failure only delays an
  already-correct answer. See [OPERATIONS.md](OPERATIONS.md) for the
  operational description of this fix.

**Defending code path.** `src/db.ts` (job claim query and
`reclaimStuckJobs`), `src/queue.ts` (`JobRunner.reclaimStuckJobs`, the
`inconclusive` bounded-retry path), `src/resolve.ts`
(`withTransientRetry`, `isNotFound`).

## Out of scope

This threat model does not cover the pinned build images' own supply chain
(image vetting is an operational responsibility, documented in
`docker/verify-image/Dockerfile`), vulnerabilities in the upstream Stellar
CLI or SDK, or the underlying Postgres/Docker/Node runtimes themselves. See
[SECURITY.md](../SECURITY.md) for how to report a vulnerability and where the
line is drawn between "the trust model working as designed" and a genuine
security bug.
