# Running your own verifier

Soroverify is designed so that no consumer has to trust a single verifier's
allowlist, infrastructure, or honesty. Running an independent instance and
having its results appear alongside others for the same Wasm hash is a
first-class path, not an afterthought.

## Why you would do this

If you operate an explorer, a wallet, or any service that shows verification
status to users, running your own verifier means your users' trust rests on
your own infrastructure and your own vetted build-image allowlist, not a
third party's. Multiple independent verifiers agreeing on a result is a
materially stronger signal than any single verifier's assertion.

## What you need

- Docker, for the isolated rebuild containers.
- Postgres, for the submission queue and result storage.
- An Ed25519 keypair, to sign your instance's results.
- A vetted, digest-pinned list of build images you're willing to run
  submitted source inside. An empty or unset list means this instance
  rejects every submission — that is the fail-closed default, not a bug to
  work around.

## Setup

Full environment variable reference and setup steps are in the
[developer guide](developer-guide.md). The short version:

```bash
git clone https://github.com/soroverify/soroverify-verifier.git
cd soroverify-verifier
npm install
cp .env.example .env
# edit .env: set DATABASE_URL, STELLAR_RPC_URL, ALLOWED_BUILD_IMAGES,
# and generate a VERIFIER_PRIVATE_KEY (see .env.example for the exact command)
node --env-file=.env node_modules/.bin/tsx watch src/index.ts
```

If `VERIFIER_PRIVATE_KEY` is left unset, an ephemeral identity is generated on
each boot. Results still self-verify, but the verifier's identity changes
across restarts, which defeats the purpose of building a reputation as a
consistent, trusted verifier over time. Set a persistent key for any instance
you intend consumers to actually trust.

## Vetting build images

The `ALLOWED_BUILD_IMAGES` allowlist is the single most consequential setting
you control. Every entry must be digest-pinned, not tag-referenced — a tag can
be repointed to a different image after you've vetted it; a digest cannot.
Before adding an image, understand what it actually does when it builds
untrusted source: what it has network access to during the fetch step, what
it runs, and what it can read or write. The verifier's own container
isolation (no network egress during build, no host bind mounts) protects
against a compromised build reaching your infrastructure, but it does not
vet the image itself — that vetting is your responsibility as an operator.

## What consumers see once you're running

Once your instance has published a signed result for a Wasm hash, any
consumer querying `GET /verifications/:wasmHash` against your API — or
against any other verifier's API that also knows about your instance — will
see your result alongside others. There is no registration step with a
central authority; a consumer chooses to trust your verifier ID by including
it in their own trusted-set configuration.
