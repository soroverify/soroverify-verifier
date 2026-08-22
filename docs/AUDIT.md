# Audit readiness

This document exists to make a third-party security review of
soroverify-verifier as fast and well-scoped as possible: which files matter
most, what an auditor should focus on in each, and an honest statement of
where the project actually stands with respect to independent review.

## Status: no third-party audit has been performed

No third-party security audit of this codebase has been performed as of this
writing. This document is a readiness aid, not a substitute for one, and it
should not be read or represented as evidence that an audit has taken place.
The project's current SCF (Stellar Community Fund) status is at Milestone 5;
an independent audit is not a completed milestone. Anyone relying on this
service for anything security-critical should treat the code as unaudited
until that changes, and this file will be updated with real findings and
their resolution once a review actually happens.

This is consistent with what the project already says elsewhere:
[docs/index.md](index.md) states plainly that "Soroverify is not a security
audit," and [SECURITY.md](../SECURITY.md) documents the threat model this
codebase is designed against and how to report a vulnerability. This file is
about the review-readiness of the code itself, not about what a `verified`
result means for a given contract.

## Security-critical files

These are the files where a bug has the highest blast radius: container
escape, signature forgery, injection, or data corruption that a consumer
would trust. They are listed in the order an auditor is likely to get the
most value reviewing them.

### `src/rebuild.ts`

The highest-priority file. This is where attacker-controlled source code
actually executes. An auditor should focus on:

- Whether the container isolation flags (`--network none`, `--memory`,
  `--memory-swap`, `--cpus`, `--pids-limit`) are actually sufficient, and
  whether any Docker configuration or host setup could weaken them (for
  example, a misconfigured Docker daemon that ignores resource limits, or a
  container runtime that does not enforce `--network none` the way expected).
- Whether every value that reaches `exec.exec('docker', [...])` or the
  `sh -c` entrypoint scripts is actually an argument-array entry and never
  string-concatenated into the script text itself. The two static scripts
  (`FETCH_SCRIPT` and the inline entrypoint script in `runRebuild`) are
  meant to be the only shell text that ever runs; everything else must
  arrive as positional arguments (`"$@"`).
- Whether `isAllowedBuildImage`'s regex (`^[^\s]+@sha256:[0-9a-f]{64}$`) can
  be bypassed by a crafted image reference, and whether the allowlist
  membership check is exact-match (it is a `Set.has`, so it should be).
  Also check the reciprocal edge: whether an unset `ALLOWED_BUILD_IMAGES`
  truly rejects everything and there is no path that treats "empty set" as
  "no restriction."
- Whether `cleanupContainer` genuinely runs on every exit path, including
  every early return inside the `try` block, so a failed job can never leave
  a container running.
- The `findWasmFiles` fallback path (whole-tree copy when the standard
  release-directory copy fails), specifically whether the `onlyTargetTree`
  restriction actually prevents a submitter from placing a decoy `.wasm`
  fixture file outside `target/` that gets hashed and compared instead of
  the real build output.

### `src/ingest.ts`

The input-validation boundary. An auditor should focus on whether every
regex actually excludes what its comment claims it excludes (shell
metacharacters, control characters), whether there is any code path that
inserts a submission into the queue without going through
`validateAndNormalize` first, and whether the "unknown fields are rejected"
check is exhaustive against the full set of fields the type
`SubmissionRequest` allows.

### `src/sign.ts`

Signature creation and verification. An auditor should focus on whether
`canonicalJson`'s key-sorting is applied consistently on both the signing
and verifying side (a mismatch here would make valid signatures
unverifiable or, worse, make verification accept payloads it should reject),
whether `verifyResultRecord` truly can never throw (it wraps everything in
try/catch and returns `false`, which callers rely on), and whether the
fingerprint check (`verifier_id` must equal the SHA-256 of the embedded
public key, truncated to 16 hex chars) is done before or independently of
the signature check, and whether either check being skipped could let a
forged or mismatched key/signature pair through.

### `src/store.ts`

Content-addressed storage integrity. An auditor should focus on whether the
write path (`put`) can ever leave a partially-written file visible at the
final content-address path (it writes to a `.tmp-<uuid>` path with an
exclusive `wx` flag, then renames), whether `get`'s re-hash-on-read check can
be bypassed, and whether the path-construction function (`pathFor`) can be
made to escape `baseDir` given a crafted `sha256` argument (it is gated by
the `HEX_64` regex before use, but this is worth confirming end to end).

### `src/routes.ts`

The peer-fetching and untrusted-record-parsing surface. An auditor should
focus on `parseSignedResult` (does it actually reject every structurally
invalid shape before the record reaches `verifyResultRecord`), whether a
peer response can inject a result for a wasm hash it was not asked about
(the `normalizeWasmHashHex(parsed.wasm_hash) === wasmHash` check in
`fetchPeerResults` is the relevant guard), whether the CORS logic
(`allowedCorsOrigin`, `applyReadCors`) can be tricked into reflecting an
origin it should not, and whether any route other than the three explicitly
CORS-enabled read endpoints could unintentionally pick up permissive CORS
headers.

### `src/meta.ts`

The wasm binary parser. This function runs against attacker-supplied
bytecode retrieved from the network (the deployed wasm, not the rebuilt
one, but still untrusted in the sense that a malformed or adversarially
crafted wasm should never crash the process). An auditor should focus on
whether `parseWasmMeta`, `readU32Leb128`, and `readXdrString` can read out
of bounds given a truncated or malformed length prefix (the LEB128 reader
throws on end-of-buffer and unbounded shift, which the caller catches; the
XDR string reader bounds `len` to `0xffff` but should be checked for
buffer-overrun behavior when `dataStart + padded` exceeds the buffer
length), and generally whether every parse failure mode degrades to "skip
this section" rather than corrupting the parse position or crashing.

## What "focus on" means in practice

For each file above, the specific question worth asking is: given fully
adversarial input at that file's trust boundary (an attacker-chosen HTTP
body for `ingest.ts`, an attacker-chosen source tree and build image for
`rebuild.ts`, an attacker-chosen peer HTTP response for `routes.ts`, an
attacker-chosen wasm binary for `meta.ts`, attacker-chosen bytes claiming a
given hash for `store.ts`, an attacker-chosen signature/key pair for
`sign.ts`) can that input reach an interpreter unsafely, escape its
resource or network sandbox, be accepted as authentic when it is not, or
crash the process in a way that leaves it in a bad state? The project's own
existing convention, stated in `SECURITY.md` and `CONTRIBUTING.md`, is that
validation must never throw and malformed input must degrade to a recorded
`inconclusive` rather than a crash; a review finding that this invariant is
violated anywhere is a real bug, not a style note.

## Existing test coverage relevant to an audit

`test/rebuild.test.ts` is called out in `SECURITY.md` as the place isolation
guarantees are meant to be pinned by tests. `test/ingest.test.ts` covers the
input-validation grammar, `test/resolve.test.ts` covers the RPC
resolver including the transient-retry behavior, and `test/routes.test.ts`
covers the HTTP surface including peer-result handling. An auditor should
treat these as a starting map of what is already covered, not as a
substitute for independent review, since tests only prove the behaviors
their authors thought to check.
