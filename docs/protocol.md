# Protocol mechanics

## The pipeline

Every verification, whether triggered by a developer submission or a
retroactive lookup, goes through the same eight stages.

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

### Stage 6, in detail: the rebuild environment

The rebuild does not run arbitrary source in an arbitrary environment. It
replays the exact environment recorded in the deployed Wasm's own metadata,
because a rebuild against the wrong toolchain or build flags produces a
different binary even from identical source — that would be a false
`mismatch`, not a real one.

The container the rebuild runs in:

- Has zero network egress beyond the initial source fetch (`--network none`).
  A submission's source cannot phone home, fetch an unexpected dependency
  mid-build, or exfiltrate anything.
- Only runs a build image that is on an explicit, digest-pinned allowlist.
  Tag-only references are rejected; an unconfigured or empty allowlist fails
  closed, rejecting every submission rather than trusting an unvetted image.
  This closes a gap that exists in the current CLI reproducible-build design,
  where any image string is accepted.
- Has the Wasm's recorded Rust version pinned as `RUSTUP_TOOLCHAIN`, so a
  submission cannot smuggle a `rust-toolchain.toml` in its own source to
  silently swap the compiler mid-build.
- Has a hard wall-clock timeout. If it trips, the container is killed and the
  job is recorded as `inconclusive`, never left running indefinitely.
- Is destroyed after every job, successful or not. Nothing persists between
  submissions.

## The four result states, precisely

These are the only states a signed, on-chain-adjacent result can be in. Two
additional transient states exist only inside the aggregator's own job
tracking and are never signed or published as a final result:

| State | Meaning | Durable? |
|---|---|---|
| `verified` | Rebuild completed cleanly and the hash matches the deployed Wasm. | Yes, signed |
| `mismatch` | Rebuild completed cleanly and the hash genuinely differs. | Yes, signed |
| `unverified` | No source has been submitted for this hash at all. | Yes, signed |
| `inconclusive` | The rebuild could not complete (toolchain error, timeout, unrecognized build metadata). Retried on a bounded schedule. | Transient, not signed |

The distinction between `mismatch` and `inconclusive` is deliberate and load
bearing. A build that fails to reproduce is not automatically evidence of
tampering — it can just as easily be a toolchain gap. Collapsing the two would
mean either false alarms on legitimate contracts, or grown apathy toward a
real `mismatch` because failures were noisy. A consumer-facing badge should
never render a red mismatch state for anything other than a clean, completed
rebuild that produced different bytes.

## Worked example

This is a real result, taken from a contract deployed to Stellar testnet
during this project's own development, with no source ever submitted for it:

**Contract:** `CDNA2XPXQ5XEVG4J5S4CFD5XJ7RI7O5G3HBU3TALYXUMVA3KVMFW3RCE`
**Wasm hash:** `ae93c5657badf39e151ce54a5bd163127c6590785d40f0d6f28c25d45b37af9e`

```
GET /verifications/by-contract/CDNA2XPXQ5XEVG4J5S4CFD5XJ7RI7O5G3HBU3TALYXUMVA3KVMFW3RCE
```

```json
{
  "wasmHash": "ae93c5657badf39e151ce54a5bd163127c6590785d40f0d6f28c25d45b37af9e",
  "status": "unverified",
  "results": [],
  "sources": []
}
```

Note what this response does and does not say. It correctly resolved the
contract ID to its real, current Wasm hash via RPC — the response is not a
generic placeholder, it reflects the actual deployed bytecode. `status` is
`unverified` because no one has submitted source for this hash, not because
anything failed. `results` is an empty array because no verifier, including
this one, has published a signed record for this hash yet. This is the honest,
correct answer for a genuinely unclaimed contract, and it is what a consumer
should see: neutral, not a fabricated pass or fail.

## Trust levels, kept separate

Soroverify surfaces three trust signals, and deliberately never collapses them
into one:

1. **Source-verified** — the result of the pipeline above: an independent,
   deterministic rebuild matched.
2. **Attested** — a [SEP-55](https://github.com/orgs/stellar/discussions/1923)
   GitHub Actions attestation exists for this contract. This asserts that a
   build ran at a given commit; it is not an independent rebuild.
3. **Unverified** — neither signal exists.

A consumer that wants the strongest guarantee should look for
source-verified. A consumer willing to trust a CI pipeline's own assertion can
accept attested. Neither should be presented to a user as equivalent to the
other.
