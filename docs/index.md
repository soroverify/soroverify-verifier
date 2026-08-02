# Soroverify

Soroverify is a public, self-hostable service that answers one question about
a deployed Soroban contract: does the source code it claims to come from
actually produce the bytecode running on-chain.

## The problem

Soroban does not store contract source on-chain. A block explorer can show a
GitHub link next to a contract, but nothing on the network ties that link to
the deployed bytecode. SEP-55 lets a CI workflow attest that a build ran at a
given commit, which is useful, but it is an attestation that a build happened,
not an independent proof that the specific deployed bytes came from that
source.

Two things make this a real, not theoretical, problem:

- A contract can be upgraded. The source shown for the current version may not
  match what was true when it was deployed, or vice versa.
- A contract can predate any verification tooling entirely. Retroactively
  answering "does this match" for something already on-chain is a case most
  existing approaches do not cover well.

## What Soroverify does

Given a contract already deployed to Soroban, and source someone submits as
the claimed origin, Soroverify:

1. Resolves the contract's current deployed Wasm hash directly from the
   network.
2. Rebuilds the submitted source in an isolated, network-locked container,
   replaying the exact build environment recorded in the Wasm's own metadata.
3. Compares the rebuilt hash to the deployed hash.
4. Signs the result and publishes it through a public, free API that anyone
   can query by contract ID or Wasm hash.

The result is one of four states: `verified` (rebuild matches), `mismatch`
(rebuild succeeded but produced different bytes), `inconclusive` (the rebuild
could not complete, which is not the same as a mismatch), or `unverified` (no
source has been submitted for this hash).

## Why this is a multi-verifier design

A single service asserting "this is verified" asks a consumer to trust that
one operator's allowlist, infrastructure, and honesty are all sound. Soroverify
signs every result per verifier and keys it to the Wasm hash. The API returns
every verifier's result for a hash, not just one, so a wallet or explorer can
require agreement across a set of verifiers it chooses to trust, rather than
depending on a single party. Running an independent verifier instance against
the same public API contract is a documented, first-class path, not an
afterthought.

## What this is not

Soroverify is not a security audit. A `verified` result means the deployed
bytecode was reproducibly built from the submitted source, nothing more. It
says nothing about whether that source is safe, well-designed, or free of
bugs. Treat a green badge as "the code you can read is the code running," not
as a safety guarantee.

Soroverify also does not re-implement Soroban's reproducible-build mechanism.
`stellar contract build verify` (in development as of this writing, tracked in
[stellar-cli PR #2525](https://github.com/stellar/stellar-cli/pull/2525)) is
the eventual native path for this; Soroverify currently implements the
[SEP-58](https://github.com/orgs/stellar/discussions/1923) Appendix-A replay
procedure directly, and will migrate to the native subcommand the moment it
ships in a release.

## Where to go next

- **[Protocol mechanics](protocol.md)** — the full pipeline, state machine, and
  what each of the four result states actually means.
- **[API reference](api-reference.md)** — every public endpoint, with real
  request and response shapes.
- **[For contract authors](guide-authors.md)** — how to get your own contract
  verified.
- **[For wallets and explorers](guide-consumers.md)** — how to embed
  verification status before a user signs.
- **[Running your own verifier](guide-operators.md)** — the multi-verifier
  model, and how to stand up an independent instance.
- **[Developer guide](developer-guide.md)** — local setup, environment
  variables, and the codebase structure.
- **[Contributing](contributing.md)** — how to propose and land a change.
