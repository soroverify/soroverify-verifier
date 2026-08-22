# Glossary

Plain-language definitions of terms used throughout this project's
documentation and API.

**Wasm hash**
The SHA-256 hash of the exact bytes of a compiled Soroban contract's
WebAssembly binary. This is the value the whole service exists to check: does
rebuilding the submitted source produce a wasm whose hash equals the wasm
hash actually deployed on-chain. Represented as 64 lowercase hex characters
in the API; submissions may supply it in hex or base64 and it is normalized
to lowercase hex before it is stored or compared.

**Contract ID**
A Soroban contract's address on the network, written as a StrKey string
starting with `C` (a "C-address"). A `contractId`-only submission is resolved
to its currently deployed wasm hash via Soroban RPC before the rebuild
pipeline runs, using the same resolver code path (`src/resolve.ts`) whether
the request came in through the submission queue or through `GET
/verifications/by-contract/:contractId`.

**Build metadata**
Key/value entries recorded inside a compiled contract's own wasm binary
(in a `contractmetav0` custom section, per SEP-46) that describe exactly how
that wasm was built: which build image, which build arguments and options,
and which Rust toolchain version. This is what lets the rebuild step replay
the original build environment instead of guessing at it. Read and decoded
by `src/meta.ts`; see the SEP-58 and SEP-55 entries below for the two SEPs
that define its fields.

**SEP-58**
The Stellar Ecosystem Proposal that defines reproducible builds for Soroban
contracts: a standard vocabulary of build-metadata fields (`bldimg`,
`bldopt`, `bldarg`, `rsver`, `source_repo`, `source_rev`, `source_sha256`,
`source_uri`, and others) recorded in the contract's own wasm, and an
Appendix-A replay procedure describing how to reconstruct the exact build
environment from those fields and verify the result reproduces the deployed
bytes. This service implements that Appendix-A replay procedure directly
(`src/rebuild.ts`); it does not depend on the native `stellar contract build
verify` CLI subcommand, which is still in development upstream.

**SEP-55**
A different Stellar Ecosystem Proposal, for CI-based build attestation: it
lets a CI workflow attest that a build ran at a given commit and produced a
given wasm. SEP-55 proves a build happened; it does not independently
rebuild anything or prove the deployed bytecode actually came from that
source. Soroverify is a different, complementary approach: it verifies any
contract already on-chain by actually rebuilding it, retroactively,
regardless of how or when it was originally deployed.

**Attestation**
A signed statement by some party that a fact is true, without that party
necessarily having independently reproduced the fact themselves. SEP-55's CI
attestation is one example: it attests a build ran, based on trusting the CI
environment that ran it. Soroverify's signed result records are a stronger
kind of claim than a bare attestation, because the signing party
(a verifier instance) is asserting that it personally rebuilt the source in
an isolated environment and observed the hash match, not merely relaying
someone else's claim.

**Verifier ID**
A short fingerprint (the first 16 hex characters of the SHA-256 hash of a
verifier's Ed25519 public key, computed in `src/sign.ts`) that identifies
which verifier instance produced a given signed result. A consumer checks
that a record's `verifier_id` actually matches the fingerprint of its own
embedded public key before trusting anything else about the record; this is
what lets a result be verified without looking anything up in any verifier's
database. Because it is derived from the key, `verifier_id` changes if the
underlying key changes, which is why running a persistent verifier instance
in production means setting `VERIFIER_PRIVATE_KEY` rather than letting a
fresh key generate on every restart.

**Trusted verifier set**
The set of verifier instances a particular consumer (a wallet, an explorer,
another service) chooses to require agreement from before treating a
contract as verified. Soroverify is deliberately a multi-verifier design: no
single instance's database is trusted, every result is signed per-verifier,
and the API returns every result it can gather (its own plus any verified
peer results) for a given wasm hash, so the decision about which verifiers
to trust and how many of them need to agree is left to the consumer, not
baked into the service.

**Reproducible build**
A build process that, given the same source and the same recorded build
environment (compiler version, build image, build flags), always produces
byte-identical output. Reproducibility is what makes source verification
possible at all: without it, a rebuild could legitimately differ from the
original deployment even when the source really is the same, which would
make `mismatch` meaningless as a signal. This service enforces
reproducibility on the build-image side by requiring every allowlisted
image to be digest-pinned rather than tag-referenced (`isAllowedBuildImage`
in `src/rebuild.ts`), and pins the recorded Rust toolchain version into the
build container via `RUSTUP_TOOLCHAIN` so an in-source
`rust-toolchain.toml` cannot silently swap the toolchain mid-build.

## The four result states

These are the complete vocabulary of outcomes a wasm hash can resolve to.
They are deliberately kept distinct from one another; see `src/compare.ts`
for the exact logic and `docs/index.md` for why the distinctions matter.

**verified**
A rebuild completed and produced a wasm whose hash equals the deployed hash.
The strongest positive signal the service can give: the deployed bytecode
was reproducibly built from the submitted source.

**mismatch**
A rebuild completed successfully but produced a wasm hash that differs from
the deployed hash. This means the submitted source, built exactly as
recorded, does not produce the bytecode actually running on-chain. It is
never used as a stand-in for "the rebuild failed"; a failed or incomplete
rebuild is `inconclusive`, not `mismatch`, because conflating "we could not
check" with "it failed the check" would make the signal untrustworthy.

**inconclusive**
No verdict could be reached: the target wasm carries no SEP-58 build
metadata to replay, the source fetch failed, the rebuild itself failed or
was killed by its timeout, or a transient RPC or infrastructure failure
prevented the pipeline from completing. A job that resolves inconclusive is
retried with exponential backoff up to a bounded attempt budget
(`src/queue.ts`) before settling as a final inconclusive result.

**unverified**
No result and no submission exists at all for a given wasm hash. This is
computed at the API layer (`src/routes.ts`), not stored as a status anywhere,
because it is really the absence of any record rather than an outcome of a
job that ran. A contract with `unverified` status simply has never had
source submitted for it to any verifier this query reached.
