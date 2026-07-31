/**
 * Tooling smoke test.
 *
 * Deliberately trivial: it exists to pin the toolchain assumptions the whole
 * suite relies on — that vitest resolves NodeNext-style `.js` specifiers to
 * their `.ts` sources (the same specifier style the emitted Node ESM build
 * uses), and that the strict type surface in src/db.ts stays importable.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { createDatabase, Database } from '../src/db.js';

describe('tooling smoke', () => {
  const db = createDatabase({ connectionString: 'postgres://smoke-test.invalid/db' });

  afterAll(() => db.close());

  it('resolves NodeNext .js specifiers to .ts sources', () => {
    // Constructing a Database must not require a live Postgres connection
    // (the pool connects lazily), so this runs anywhere.
    expect(db).toBeInstanceOf(Database);
  });
});
