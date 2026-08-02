# Contributing

The authoritative, day-to-day contributing guide lives in the repository's
own [`CONTRIBUTING.md`](https://github.com/soroverify/soroverify-verifier/blob/main/CONTRIBUTING.md).
This page covers how documentation itself gets contributed to and kept
correct.

## Keeping docs honest

Every claim in this documentation should be checkable against the actual
running code or a real, reproducible command. When a behavior changes —
an endpoint's response shape, an environment variable's default, a known
gap getting fixed — the corresponding doc page should change in the same
pull request as the code, not as a follow-up that may or may not happen.

If you find a page describing behavior that no longer matches the code,
that's a legitimate documentation bug. Open an issue or, better, a PR fixing
it directly — this is exactly the kind of contribution that's easy to scope
and genuinely useful.

## Where things live

Documentation is plain markdown under `docs/` in the `soroverify-verifier`
repository, versioned alongside the code it describes. There is no separate
external documentation platform to keep in sync.

## Reporting a documentation gap

If something you needed to know wasn't covered here, that's worth an issue
even if you don't have time to write the fix yourself — a documented gap is
more useful to the next person than a silent one.
