# API reference

Base URL for a self-hosted instance is whatever you deploy it at. Examples
below use `http://localhost:8080`, matching local development.

All read endpoints are public, unauthenticated, and CORS-enabled for browser
use from any origin. `POST /submissions` has no permissive CORS and is not
intended for arbitrary cross-origin calls.

## `GET /verifications/:wasmHash`

Look up every published result for a specific Wasm hash.

**Path parameter:** `wasmHash` — a 64-character hex string.

**Response, 200:**

```json
{
  "wasmHash": "ae93c5657badf39e151ce54a5bd163127c6590785d40f0d6f28c25d45b37af9e",
  "status": "unverified",
  "results": [],
  "sources": []
}
```

When one or more verifiers have published a result for this hash, `results`
contains one entry per verifier:

```json
{
  "wasmHash": "…",
  "status": "verified",
  "results": [
    {
      "verifierId": "…public key fingerprint…",
      "status": "verified",
      "sourceRepo": "github:example/contract",
      "sourceRev": "a1b2c3d",
      "timestamp": 1785500000
    }
  ],
  "sources": ["github:example/contract@a1b2c3d"]
}
```

## `GET /verifications/by-contract/:contractId`

Same response shape as above, but takes a contract ID and resolves it to its
current deployed Wasm hash via RPC before looking up results.

**Path parameter:** `contractId` — a StrKey-encoded contract address
(`C...`).

**Response, 400** — malformed contract ID, rejected before any RPC call:

```json
{
  "error": {
    "code": "validation_failed",
    "message": "contractId must be a valid C-address (StrKey contract id)"
  }
}
```

**Response, 404** — well-formed contract ID, but it does not resolve to a
deployed contract on the configured network.

**Response, 502** — well-formed contract ID, but the RPC call to resolve it
failed or timed out. This is distinct from 404: it means the check could not
be completed, not that the contract does not exist.

## `POST /submissions`

Submit source to be rebuilt and compared against a deployed contract.

**Body:**

```json
{
  "contractId": "C...",
  "sourceRepo": "https://github.com/example/contract",
  "sourceRev": "a1b2c3d"
}
```

At least one of `contractId` or `wasmHash` is required. `sourceRepo` is
validated against a strict URL grammar; malformed or suspicious values
(control characters, shell metacharacters) are rejected before anything is
queued.

**Response, 202:**

```json
{ "submissionId": "…uuid…" }
```

The submission is queued, not processed synchronously. Poll `GET
/status/:submissionId` for progress.

## `GET /status/:submissionId`

**Path parameter:** `submissionId` — a UUID.

**Response, 400** — malformed UUID, rejected before any database query.

**Response, 404** — well-formed UUID that does not correspond to a real
submission.

**Response, 200:**

```json
{
  "submissionId": "…",
  "status": "verified",
  "buildLog": "…"
}
```

## Errors

Every error response follows the same shape:

```json
{ "error": { "code": "…", "message": "…" } }
```

Common codes: `validation_failed` (malformed input, rejected before touching
the network or database), `not_found`, `rpc_error` (the upstream Soroban RPC
call failed).
