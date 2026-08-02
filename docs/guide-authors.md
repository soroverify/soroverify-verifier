# For contract authors: getting your contract verified

If you deployed a Soroban contract and want people who interact with it to
see it as source-verified, this is the flow.

## What you need before starting

- A contract already deployed to the network you're targeting (testnet or
  mainnet).
- The source that produced it, in a public Git repository, at the exact
  commit that was built.
- The build metadata recorded in your deployed Wasm — this happens
  automatically if you built with `stellar contract build` and included
  `--meta` fields; if you built some other way, verification may report
  `inconclusive` because the rebuild environment cannot be determined.

## Submitting

```bash
curl -X POST http://localhost:8080/submissions \
  -H "Content-Type: application/json" \
  -d '{
    "contractId": "YOUR_CONTRACT_ID",
    "sourceRepo": "https://github.com/you/your-contract",
    "sourceRev": "the-exact-commit-hash"
  }'
```

You'll get back a `submissionId`. The rebuild is queued, not synchronous.

## Checking the result

```bash
curl http://localhost:8080/status/YOUR_SUBMISSION_ID
```

Three outcomes:

- **`verified`** — the rebuild matched. Your contract now shows this status to
  anyone who queries it by contract ID or Wasm hash.
- **`mismatch`** — the rebuild completed but produced different bytes than
  what's deployed. This usually means the commit you submitted is not what was
  actually built, or the build metadata doesn't reflect how you actually
  built it. Double-check both before assuming something is wrong with the
  service.
- **`inconclusive`** — the rebuild could not complete. Check the build log
  returned alongside the status. Common causes: the recorded build image
  isn't on this verifier's allowlist, or the build genuinely fails in an
  isolated, network-locked environment even though it works on your machine
  (a hidden dependency on network access during build is the most common
  reason for this).

## If your contract predates any of this

You do not need to redeploy. Because verification works by rebuilding
submitted source against whatever hash is already on-chain, a contract
deployed months ago, with no prior verification metadata, is submitted the
same way as a brand-new one. This is deliberate: retroactive verification for
already-deployed contracts is a core design goal, not an edge case.

## A note on what "verified" does not mean

A `verified` result is a statement about reproducibility, not safety. It means
the source you pointed to genuinely produces the bytecode that's running. It
says nothing about whether that code is well-written, free of bugs, or safe to
trust with funds. Do not represent it to your users as an audit.
