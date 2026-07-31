# docker/verify-image/Dockerfile
#
# The pinned stellar-cli image used for verify jobs. It is the image the
# service runs for the source-fetch step (clone/checkout/archive) and the
# container the CLI runs in once the upstream `stellar contract build verify`
# subcommand is available (see src/rebuild.ts).
#
# The base is pinned by digest — never `latest`. Bump only deliberately: the
# new digest must be re-vetted against the SEP-58 image trust requirements
# (single-architecture manifest, CI provenance, SBOM, self-contained toolchain)
# and the pinned reference updated in CI and the README.
FROM docker.io/stellar/stellar-cli@sha256:c1297d0c2c6790dda6afaa3edd39a959ec12edd6ebe30282dd1d7a663e7c4109

# The base image runs as a non-root user, but apt needs root; switch for the
# install step only (the fetch step passes its own commands explicitly).
USER root

# git + tar are required by the source-fetch step (clone, checkout, archive);
# ca-certificates keep https git remotes working.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git tar ca-certificates \
 && rm -rf /var/lib/apt/lists/*
