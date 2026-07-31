/**
 * Content-addressed tarball storage.
 *
 * Every submitted source archive is stored under the SHA-256 of its exact
 * bytes, so a stored artifact cannot be silently swapped after the fact: any
 * read re-hashes the bytes and rejects a mismatch. This is what
 * "tamper-evident storage" means in the RFP — implemented as a property of the
 * storage layer, not a comment.
 *
 * Layout: <baseDir>/<first two hex chars>/<full sha256>.
 *
 * Failure modes:
 *  - get throws for a missing artifact or (critically) for an integrity
 *    violation — bytes that do not hash to the requested address.
 *  - put returns the address and is idempotent (an existing artifact is not
 *    rewritten).
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const HEX_64 = /^[0-9a-f]{64}$/;

export class ContentStore {
  constructor(private readonly baseDir: string) {}

  /** Store bytes content-addressed; returns the sha256 address. */
  async put(bytes: Buffer): Promise<string> {
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const finalPath = this.pathFor(sha256);
    if (await exists(finalPath)) {
      return sha256; // already present — nothing to do
    }
    const tmpPath = `${finalPath}.tmp-${randomUUID()}`;
    await mkdir(dirname(finalPath), { recursive: true });
    await writeFile(tmpPath, bytes, { flag: 'wx' });
    await rename(tmpPath, finalPath);
    return sha256;
  }

  /** Read stored bytes, verifying they hash to the requested address. */
  async get(sha256: string): Promise<Buffer> {
    if (!HEX_64.test(sha256)) {
      throw new Error(`invalid content address: ${sha256}`);
    }
    const bytes = await readFile(this.pathFor(sha256));
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== sha256) {
      throw new Error(`content-addressed storage integrity violation for ${sha256}`);
    }
    return bytes;
  }

  /** Whether an artifact is present under the given address. */
  async has(sha256: string): Promise<boolean> {
    if (!HEX_64.test(sha256)) {
      return false;
    }
    return exists(this.pathFor(sha256));
  }

  private pathFor(sha256: string): string {
    return join(this.baseDir, sha256.slice(0, 2), sha256);
  }
}

/** Cheap existence probe without buffering the file contents. */
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
