# Contributing to soroverify-verifier

Thanks for contributing! This project verifies Soroban contract source code, which
means the stakes are high: a verification service's whole value is that its verdicts
are trustworthy. Read [README.md](README.md) for the system overview, and keep the
security model in mind with every change.

## Development setup

Requirements: Node.js >= 22, npm.

```bash
npm install
```

The unit test suite does **not** require Postgres or Docker. The database layer is
tested against the real `pg` pool only where the connection is lazy (see
`test/smoke.test.ts`), and the rebuild pipeline is tested through an injectable
`CommandExecutor` that records invocations instead of running containers. Running
the full service locally does require Postgres and Docker:

```bash
docker run -d --name soroverify-db -p 5432:5432 \
  -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=soroverify postgres:16
docker build -t soroverify/verify-image:latest docker/verify-image

export DATABASE_URL=postgres://postgres:dev@localhost:5432/soroverify
export STELLAR_RPC_URL=https://soroban-mainnet.stellar.org
npm run dev
```

See README.md → _Configuration_ for the full environment variable reference
(`VERIFIER_PRIVATE_KEY`, `ALLOWED_BUILD_IMAGES`, `PEER_VERIFIERS`, …).

## Commands

```bash
npm run dev        # hot-reload dev server
npm run build      # production build (dist/)
npm run typecheck  # strict TypeScript check (includes tests)
npm run lint       # eslint
npm test           # vitest run
```

The CI gate is exactly these three: **typecheck, lint, test**. All three must pass
for a PR to be merged.

## Code conventions

- **TypeScript, strict mode.** The `tsconfig` is strict with
  `noUncheckedIndexedAccess`, `noImplicitOverride`, and `verbatimModuleSyntax`.
  Prefer `import type` for type-only imports.
- **`.js` specifiers on relative imports.** This is a NodeNext ESM project; import
  `./foo.js`, not `./foo.ts` or `./foo`.
- **Argument-array exec only.** Never build shell strings. Untrusted values go to
  external commands (git, docker) as positional arguments. See the tests in
  `test/ingest.test.ts` that pin this contract.
- **Never throw from validation.** The `validateAndNormalize`-style result objects
  (`{ ok: true, value } | { ok: false, issues }`) are the established pattern for
  untrusted input; keep it.
- **Document failure modes.** Each module's header documents its failure modes:
  what returns `null`, what never throws, what is retryable vs. terminal. Keep
  those headers accurate.
- **No new runtime dependencies without discussion.** The dependency surface is
  intentionally tiny (`fastify`, `pg`, `@stellar/stellar-sdk`). If you need a new
  dependency, open an issue first.
- **Security-sensitive code gets tests.** Rebuild isolation properties
  (`--network none`, no bind mounts, allowlist gating, timeout kill, cleanup) are
  pinned by tests in `test/rebuild.test.ts`. New isolation guarantees must be too.

## Testing expectations

- **Every new behavior has a test** in the matching file under `test/`.
- Tests must run **without Docker or Postgres**. If your change needs an external
  dependency, inject it (as `CommandExecutor` is injected) and assert against a
  recording fake.
- The injected executor pattern: tests script per-subcommand responses and then
  assert on the exact argument lists the host would receive. This is how
  security-relevant argument construction is pinned.

## Branching and PR workflow

1. Create a branch from `main`: `git checkout -b feat/your-change`.
2. Make your change with tests, then run `npm run typecheck && npm run lint && npm test`.
3. Push and open a pull request against `main`. The CI workflow runs the same three
   gates with a 10-minute timeout.
4. Commit messages follow the conventional style already in the history
   (`feat(scope): …`, `fix(scope): …`, `test(scope): …`, `chore(scope): …`).

## Review expectations

- Rebuild isolation claims need evidence: a test that pins the docker argument
  list, not just a comment.
- Any loosening of input validation or the allowlist is a security-relevant change
  and will be scrutinized accordingly.
- Keep diffs minimal and focused; prefer reusing existing helpers over new
  abstractions.

## Reporting vulnerabilities

Do **not** open an issue. Follow [SECURITY.md](SECURITY.md) and report privately.
