# Deployment

This is an honest description of what it takes to actually run
soroverify-verifier somewhere, and in particular what kind of hosting will
not work. It complements [guide-operators.md](guide-operators.md) (the
"why and how to run your own instance" narrative) and
[OPERATIONS.md](OPERATIONS.md) (the full configuration and monitoring
reference); this file is specifically about the hosting-environment
constraint that rules out a large fraction of hosting options before any
configuration decision is even relevant.

## The hard requirement: real, isolated Docker containers

Two steps in the pipeline run inside Docker containers, and this is not
incidental infrastructure choice, it is the actual security mechanism the
service depends on:

- The **rebuild step** (`runRebuild` in `src/rebuild.ts`) runs
  attacker-controlled source code. It depends on the container runtime
  genuinely enforcing `--network none` (zero network egress), `--memory` /
  `--memory-swap` / `--cpus` / `--pids-limit` (resource limits), and actual
  process isolation from the host. See
  [THREAT-MODEL.md](THREAT-MODEL.md) for why each of these matters: this is
  the boundary between "arbitrary code from a stranger runs somewhere safe"
  and "arbitrary code from a stranger runs with access to your
  infrastructure."
- The **source-fetch step** (`fetchSourceTarball`, also in `src/rebuild.ts`)
  clones a submitter-supplied git URL inside its own throwaway container.

Both steps invoke the real `docker` CLI (`create`, `start`, `wait`, `cp`,
`kill`, `rm`, `logs`) via `child_process.execFile`, against a real Docker
daemon the process has a socket connection to. There is no in-process
sandbox, no WebAssembly-based isolation, and no fallback path that skips
containerization. If the process cannot reach a working Docker daemon that
will actually create and run containers with those isolation flags, the
rebuild step fails outright, and every submission resolves `inconclusive`
(or, if the daemon is entirely unreachable, the process may not even start
cleanly, depending on how far into a job it gets before the first `docker`
invocation).

## What this rules out

Most **free or serverless hosting tiers do not give you this.** Platforms
built around running a stateless application process, or around running a
single, already-built container without granting it the ability to
create and manage further sibling containers, generally fall into one of two
categories:

- **No Docker access at all.** Traditional serverless/FaaS platforms (the
  kind that run your code per-request in a managed, ephemeral runtime) and
  many "deploy your app, we handle the infrastructure" PaaS free tiers do
  not expose a Docker socket or any equivalent to your process. There is
  nothing for `execFile('docker', ...)` to talk to.
- **You are already inside a container, with no way to create more.**
  Platforms that deploy your service as a single container typically do not
  grant that container privileged access to a host Docker daemon
  (Docker-in-Docker, or a mounted host Docker socket) by default, and many
  explicitly forbid it on shared/free tiers as a matter of policy, because
  granting one tenant's container control over sibling container creation on
  shared infrastructure is itself a security and resource-isolation problem
  for the platform operator.

Concretely, this means: if a hosting option's free tier does not let you
either (a) provision a real Docker daemon your process can control, or (b)
run your service on infrastructure you fully control (a VM, a bare-metal
host, or a container platform that explicitly grants Docker-in-Docker /
privileged execution), soroverify-verifier will not function correctly on
it. The service will typically still start and answer `GET /health`
(liveness only, as documented in [OPERATIONS.md](OPERATIONS.md)), which can
be misleading: the process being "up" says nothing about whether it can
actually execute the rebuild pipeline that is the entire point of running
it.

## What does work

- A VM or bare-metal host you control (cloud or otherwise), with Docker
  installed directly on it, running the Node process alongside the Docker
  daemon it needs to reach.
- A container platform that explicitly supports Docker-in-Docker or grants
  your container access to a host Docker socket, typically a paid tier
  designed for CI/build workloads rather than a free tier designed for
  stateless web apps.
- Any of the above paired with a separately hosted Postgres instance
  (managed or self-run) reachable via `DATABASE_URL`, and network access to
  a Soroban RPC endpoint.

Whichever route is chosen, the account or service running the container
creation commands needs whatever privileges the local Docker setup requires
for `docker create`/`start`/`cp`/`kill`/`rm` to work against images that are
not already resident (or that need pulling from a registry the deploy
environment can reach). This is the same requirement as running Docker
locally for development; there is no special deployment-only mode with
reduced privileges.

## Practical implication for self-hosting

Someone evaluating whether they can "just deploy this on my usual free
hosting" should check, before doing anything else, whether that platform
gives their process genuine control over creating and running isolated
Docker containers with resource and network limits. If the honest answer is
no, the fix is not a workaround inside this codebase (there is deliberately
no non-containerized fallback for running attacker-controlled build code,
because that would remove the isolation the whole threat model depends on);
the fix is choosing a hosting option from the list above. See
[guide-operators.md](guide-operators.md) for the full setup walkthrough once
a suitable host is chosen, and [OPERATIONS.md](OPERATIONS.md) for the
complete environment-variable reference.
