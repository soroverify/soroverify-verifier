# Security Policy

soroverify-verifier is a security-sensitive service: its purpose is to issue
trustworthy verdicts about deployed contract source, so both its _correctness_ and
its _isolation_ are security properties.

## Supported versions

This project is under active development and has not yet made a stable release.
Security fixes are applied to `main` and backported on a best-effort basis; there
are currently no supported release branches.

| Version   | Supported             |
| --------- | --------------------- |
| `main`    | ✅ Active development |
| `< 0.1.0` | ❌ Not released       |

## Reporting a vulnerability

Please distinguish between two categories of report:

1. **Trust model feedback.** If your concern is that a malicious submitter can
   waste compute, that an unvetted `bldimg` on the allowlist could misbehave, or
   that a single verifier's result shouldn't be trusted without corroboration.
   That is the system working as designed, not a security bug. The threat model
   above states these boundaries explicitly. Please file it as a public GitHub
   Issue or Discussion.

2. **Genuine security vulnerabilities.** If you found a way to escape the rebuild
   container's isolation, bypass the `bldimg` allowlist, forge or replay a signed
   result, achieve command injection through the ingest boundary, or otherwise
   subvert a guarantee in the threat model above, report it privately via the
   GitHub Security Advisories tab
   (https://github.com/soroverify/soroverify-verifier/security/advisories/new)
   rather than a public issue. Publishing a working exploit before a fix ships
   would allow it to be used against live deployments.

Do not open a public GitHub issue for a genuine vulnerability. Include:

- A description of the issue and its impact.
- Steps to reproduce, or a minimal proof of concept.
- Affected version(s) and any suggested fix, if you have one.

You will receive an acknowledgment within a reasonable time. Please give the
maintainers time to assess and fix the issue before disclosing it publicly.

## Threat model

The service is designed against the following adversaries:

- **Malicious submitters.** Anyone may POST a submission. All input is validated
  against a strict grammar at the boundary; nothing is ever interpolated into a
  shell string. See `src/ingest.ts`.
- **Hostile builds.** The source being rebuilt is attacker-controlled code running
  inside a container. The container has `--network none` (zero egress), no host
  bind mounts, CPU/memory/pids limits, a wall-clock timeout that kills it, and is
  removed after the job. Build images come only from the wasm's `bldimg` metadata
  and must be on an operator-vetted, digest-pinned allowlist that fails closed.
- **Malicious peers.** Other verifiers are queried over the network. Their result
  records are only trusted after signature verification against the embedded
  public key, _and_ the public key's fingerprint must equal `verifier_id`, _and_
  the record must be about the queried wasm hash. Peer database content is never
  trusted.
- **Tampering with stored artifacts.** Source tarballs are content-addressed by
  SHA-256; reads re-hash and reject mismatches.
- **Compromised or transient infrastructure.** Job rows left `running` by dead
  workers are reclaimed by the lease-timeout reaper with a bounded retry budget.
  The queue coordinates via Postgres transactions (`FOR UPDATE SKIP LOCKED`), so
  multiple workers cannot process the same job.

### Out of scope

This policy does not cover vulnerabilities in the pinned build images themselves
(image supply-chain vetting is an operational responsibility documented in
`docker/verify-image/Dockerfile`), the upstream Stellar CLI, or the underlying
Postgres/Docker/Node runtimes.

## Security-relevant code

High-priority review targets for any security contribution:

- `src/rebuild.ts`: container isolation, argument construction, timeout kill,
  cleanup on every path.
- `src/ingest.ts`: input validation boundary.
- `src/sign.ts`: signature creation and verification.
- `src/store.ts`: content-address integrity.
- `src/routes.ts`: peer-fetching and untrusted record parsing.
- `src/meta.ts`: parsing attacker-controlled wasm binaries (must never throw).

## Security conventions

- Argument-array exec only; never shell strings (see `CONTRIBUTING.md`).
- Never throw from validation; malformed input degrades to a recorded
  `inconclusive`, never a crash.
- Isolation guarantees must be pinned by tests (see `test/rebuild.test.ts`).
- Keep the dependency surface minimal; review any new dependency for supply-chain
  risk.
