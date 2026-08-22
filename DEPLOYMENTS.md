# Deployments

This file documents real, on-chain artifacts used during development of
soroverify-verifier. It exists so anyone can independently confirm the
claims here without trusting this repository or its authors.

## Testnet test contract

Throughout development and testing, the project has exercised the verifier
against one real Soroban contract deployed on Stellar **testnet**:

| Field       | Value                                                              |
| ----------- | ------------------------------------------------------------------ |
| Contract ID | `CDNA2XPXQ5XEVG4J5S4CFD5XJ7RI7O5G3HBU3TALYXUMVA3KVMFW3RCE`         |
| Wasm hash   | `ae93c5657badf39e151ce54a5bd163127c6590785d40f0d6f28c25d45b37af9e` |
| Network     | Stellar testnet                                                    |

**What this is not:** this is not a deployment of the soroverify-verifier
_service_ — it is a Soroban contract used as a test fixture, so that the
service has a real, live, on-chain contract to point `contractId`/`wasmHash`
resolution at during manual testing and development. No source has ever been
submitted for this contract to any verifier instance, so querying
`GET /verifications/<wasmHash>` against a running instance of this service
correctly and honestly returns `unverified`. That is expected, not a bug —
it demonstrates the "no result recorded" path, not a failed verification.

There is currently no publicly hosted instance of soroverify-verifier to
query. The claim you can check right now, without trusting this file or
running any part of this repo, is narrower and more fundamental: **this
contract genuinely exists on testnet, at this contract ID, with this wasm
hash.**

### Verify it yourself

Requires only the [Stellar CLI](https://developer.stellar.org/docs/tools/cli/install-cli),
no other setup, no cloned repo needed:

```sh
stellar contract info hash \
  --contract-id CDNA2XPXQ5XEVG4J5S4CFD5XJ7RI7O5G3HBU3TALYXUMVA3KVMFW3RCE \
  --rpc-url https://soroban-testnet.stellar.org \
  --network-passphrase "Test SDF Network ; September 2015"
```

Expected output:

```
ae93c5657badf39e151ce54a5bd163127c6590785d40f0d6f28c25d45b37af9e
```

This queries Stellar's public testnet RPC endpoint directly and prints the
SHA-256 hash of the wasm actually deployed at that contract ID — the same
hash listed in the table above. There is no way to fake this output short
of the contract genuinely existing on testnet with that wasm.

If you'd rather use raw JSON-RPC instead of the CLI, `getLedgerEntries` /
`getContractData` against `https://soroban-testnet.stellar.org` for this
contract ID will resolve the same instance/wasm-hash association, but the
CLI command above is the simplest self-contained way to check.

### Checking the verification status yourself

If you want to confirm the "no source submitted / unverified" claim rather
than take it on faith, run this service locally (see [README.md](README.md)
for setup) against `STELLAR_RPC_URL=https://soroban-testnet.stellar.org` and
query:

```
GET /verifications/ae93c5657badf39e151ce54a5bd163127c6590785d40f0d6f28c25d45b37af9e
```

against your own instance. With no prior submissions, it will return
`{"status": "unverified", ...}`.
