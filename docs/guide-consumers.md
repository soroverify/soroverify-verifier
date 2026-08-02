# For wallets and explorers: showing verification status

Soroverify's consumer-facing surface lives in a separate repository,
[`soroverify-consume`](https://github.com/soroverify/soroverify-consume),
which provides an SDK, an embeddable widget, and a reference integration.

## The embeddable widget

The simplest integration is the `<soroverify-badge>` custom element:

```html
<soroverify-badge
  contract-id="CDNA2XPXQ5XEVG4J5S4CFD5XJ7RI7O5G3HBU3TALYXUMVA3KVMFW3RCE"
  api-base-url="https://your-verifier-instance"
></soroverify-badge>
```

It resolves the contract to its Wasm hash, queries the verifier's public API,
and renders one of three visual states:

- **Green** — verified by a trusted verifier, with the result's age shown. A
  stale result (the threshold is documented in the widget's own README) is
  rendered as muted green, not full-strength, so age is visible rather than
  hidden.
- **Red** — any trusted verifier reports a mismatch. This state is
  intentionally impossible to soften with styling. A single credible mismatch
  outranks any number of agreeing verified results.
- **Neutral/grey** — unverified, inconclusive, disagreement among trusted
  verifiers, or the API being unreachable. None of these render as a false
  pass or fail.

Clicking the badge expands a panel with the source repository, commit, which
verifier produced the result, and — for a mismatch — a plain-language warning
meant to be read before a user signs a transaction.

## Framework-specific note: server-side rendering

The widget's custom element extends `HTMLElement`, a browser-only global. If
you're integrating into a framework that server-side renders by default (for
example, Next.js), load the widget client-side only:

```tsx
import dynamic from 'next/dynamic';

const SoroverifyBadge = dynamic(
  () => import('@soroverify/widget/react').then((mod) => mod.SoroverifyBadge),
  { ssr: false }
);
```

Omitting this causes a server-side crash (`HTMLElement is not defined`) that
only surfaces once the framework actually attempts to render the page on the
server — this was found and fixed during this project's own reference
integration, and is worth knowing before you hit it yourself.

## Using the SDK directly

If you want the raw data rather than the widget's rendering, the SDK exposes
the same lookups the widget uses internally:

```typescript
import { resolveContract, resolveTrust } from '@soroverify/sdk';

const response = await resolveContract(apiBaseUrl, contractId);
const summary = resolveTrust(response.results, trustedVerifierIds);
```

`resolveTrust` reduces potentially multiple, potentially disagreeing verifier
results into one summary: whether there's agreement across your chosen
trusted set, the most recent verified result and its age, and whether any
trusted verifier reports a mismatch. It never averages away a mismatch — a
single credible one always surfaces.

## Multi-verifier consumption

If you want to require agreement across more than one verifier rather than
trusting a single instance, pass the set of verifier IDs you trust:

```typescript
const summary = resolveTrust(response.results, [
  'verifier-id-one',
  'verifier-id-two',
]);
```

This is the mechanism that lets a consumer avoid depending on any single
operator's honesty or infrastructure.
