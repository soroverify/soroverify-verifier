/**
 * SEP-58 / SEP-46 build-metadata reader.
 *
 * Reads the `contractmetav0` Wasm custom sections (SEP-46) from a compiled
 * contract and extracts the SEP-58 build-environment and source-identity
 * fields — `bldimg`, `bldopt`, `bldarg`, `source_sha256`, `source_uri`, plus
 * the CLI/SDK-recorded `cliver`, `rsver`, `source_repo`, `source_rev`. These
 * fields tell the rebuild step exactly which environment to replay; see
 * rebuild.ts.
 *
 * Encoding reference: each custom section is a stream of `SCMetaEntry` XDR
 * values, appended with no frame or length prefix: a u32 discriminant
 * (SC_META_V0 = 0) followed by two XDR strings (u32 length + bytes, padded to
 * a multiple of 4). Multiple `contractmetav0` sections are interpreted as one
 * section appended in order (SEP-46).
 *
 * Failure modes:
 *  - parseWasmMeta never throws: a malformed section (truncated wasm, bad
 *    LEB128, unparseable XDR) is skipped and parsing continues with the next
 *    section, so a corrupted section degrades to 'no metadata' rather than
 *    failing the job.
 *  - readBuildEnvironment returns explicit nulls for absent fields.
 */

/** One key/value metadata entry from a contractmetav0 section. Duplicate keys
 * are preserved: SEP-58's `bldopt`/`bldarg` fields legitimately repeat. */
export interface MetaEntry {
  key: string;
  value: string;
}

/** Decoded build environment for a Wasm, per SEP-58 field vocabulary. */
export interface BuildEnvironment {
  /** Fully-qualified, digest-pinned build image (`bldimg`). Null when absent. */
  buildImage: string | null;
  /** Rust version recorded by the SDK (`rsver`). Null when absent. */
  rustVersion: string | null;
  /** CLI version that produced the Wasm (`cliver`). Null when absent. */
  cliVersion: string | null;
  /** Source repository recorded by the CLI (`source_repo`). Null when absent. */
  sourceRepo: string | null;
  /** Source revision recorded by the CLI (`source_rev`). Null when absent. */
  sourceRev: string | null;
  /** Source archive SHA-256 (`source_sha256`). Null when absent. */
  sourceSha256: string | null;
  /** Source archive URI (`source_uri`). Null when absent. */
  sourceUri: string | null;
  /**
   * Build arguments replayed ahead of the build options (`bldarg` entries, in
   * order). Per SEP-58, when no `bldarg` is recorded the replay defaults to
   * `contract build`.
   */
  buildArgs: string[];
  /**
   * Build options replayed as flags. `bldopt` entries are passed verbatim;
   * PR-style `bldopt_*` entries are translated to their flag form (e.g.
   * `bldopt_manifest_path` -> `--manifest-path=...`).
   */
  buildOptions: string[];
  /** True when any build-environment or source-identity field is present. */
  present: boolean;
}

const WASM_MAGIC_LEN = 8; // \0asm + u32 version

/** Read an unsigned LEB128 integer starting at offset; returns value + bytes consumed. */
function readU32Leb128(buf: Buffer, offset: number): { value: number; bytes: number } {
  let result = 0;
  let shift = 0;
  let bytes = 0;
  for (;;) {
    const byte = buf[offset + bytes];
    if (byte === undefined) {
      throw new Error('unexpected end of wasm while reading LEB128');
    }
    result += (byte & 0x7f) << shift;
    shift += 7;
    bytes += 1;
    if ((byte & 0x80) === 0) {
      break;
    }
    if (shift > 35) {
      throw new Error('LEB128 value too large');
    }
  }
  return { value: result >>> 0, bytes };
}

/** Read an XDR string (u32 length + bytes, zero-padded to 4 bytes) at offset. */
function readXdrString(buf: Buffer, offset: number): { str: string; offset: number } {
  const len = buf.readUInt32BE(offset);
  if (len > 0xffff) {
    throw new Error('XDR string length out of range');
  }
  const dataStart = offset + 4;
  const bytes = buf.subarray(dataStart, dataStart + len);
  const padded = (len + 3) & ~3;
  return { str: bytes.toString('utf8'), offset: dataStart + padded };
}

/**
 * Parse one `contractmetav0` section payload into entries. The payload is a
 * stream of SCMetaEntry XDR values; an unknown discriminant means the stream
 * cannot be resynchronized, so parsing stops there.
 */
function parseMetaEntries(payload: Buffer): MetaEntry[] {
  const entries: MetaEntry[] = [];
  let offset = 0;
  while (offset + 4 <= payload.length) {
    const discriminant = payload.readUInt32BE(offset);
    offset += 4;
    if (discriminant !== 0) {
      // SC_META_V0 is the only defined variant (0). Stop, not resync.
      break;
    }
    const key = readXdrString(payload, offset);
    const val = readXdrString(payload, key.offset);
    entries.push({ key: key.str, value: val.str });
    offset = val.offset;
  }
  return entries;
}

/**
 * Extract every metadata entry from a contract Wasm buffer.
 *
 * Walks the Wasm binary's sections, collects the payloads of all
 * `contractmetav0` custom sections, and parses their XDR entry streams. A
 * section that fails to parse is skipped without failing the whole read.
 * Returns an empty array when the Wasm carries no metadata.
 */
export function parseWasmMeta(wasm: Buffer): MetaEntry[] {
  const entries: MetaEntry[] = [];
  let offset = WASM_MAGIC_LEN;
  while (offset < wasm.length) {
    const sectionId = wasm[offset];
    if (sectionId === undefined) {
      break;
    }
    offset += 1;
    let sectionSize: number;
    try {
      const size = readU32Leb128(wasm, offset);
      sectionSize = size.value;
      offset += size.bytes;
    } catch {
      break; // truncated size — nothing further can be read
    }
    const sectionEnd = offset + sectionSize;
    if (sectionEnd > wasm.length) {
      break; // truncated section — stop walking
    }
    if (sectionId === 0) {
      // Custom section: name (LEB128 length + UTF-8), then payload.
      try {
        const nameLen = readU32Leb128(wasm, offset);
        const nameStart = offset + nameLen.bytes;
        const name = wasm.subarray(nameStart, nameStart + nameLen.value).toString('utf8');
        const payload = wasm.subarray(nameStart + nameLen.value, sectionEnd);
        if (name === 'contractmetav0') {
          entries.push(...parseMetaEntries(payload));
        }
      } catch {
        // Skip a malformed custom section and keep walking the next one.
      }
    }
    offset = sectionEnd;
  }
  return entries;
}

/**
 * True when any SEP-58 build-environment field is recorded (bldimg, bldopt,
 * bldarg, rsver). Arbitrary/unknown meta keys do not count — compare.ts uses
 * this to decide whether the environment can be replayed at all.
 */
export function hasBuildEnvironment(entries: readonly MetaEntry[]): boolean {
  return entries.some(
    (entry) =>
      entry.key === 'bldimg' ||
      entry.key === 'bldopt' ||
      entry.key.startsWith('bldopt_') ||
      entry.key === 'bldarg' ||
      entry.key === 'rsver',
  );
}

/** Value of a single-valued meta key (last entry wins), or null. */
export function getMetaValue(entries: readonly MetaEntry[], key: string): string | null {
  let found: string | null = null;
  for (const entry of entries) {
    if (entry.key === key) {
      found = entry.value;
    }
  }
  return found;
}

/** Every value recorded under a meta key, in stream order. */
export function getMetaValues(entries: readonly MetaEntry[], key: string): string[] {
  return entries.filter((entry) => entry.key === key).map((entry) => entry.value);
}

/**
 * Decode the SEP-58 build environment from parsed metadata.
 *
 * `bldopt` values are passed through verbatim; PR-style `bldopt_*` fields are
 * translated to their equivalent flags so both vocabularies replay correctly.
 * When no `bldarg` entries are recorded the replay defaults to `contract
 * build` per SEP-58.
 */
export function readBuildEnvironment(entries: readonly MetaEntry[]): BuildEnvironment {
  const buildOptions = [...getMetaValues(entries, 'bldopt')];
  for (const entry of entries) {
    if (entry.key.startsWith('bldopt_')) {
      const translated = translateBldopt(entry.key, entry.value);
      if (translated !== null) {
        buildOptions.push(translated);
      }
    }
  }

  const buildArgs = getMetaValues(entries, 'bldarg');
  const present = entries.length > 0;

  return {
    buildImage: getMetaValue(entries, 'bldimg'),
    rustVersion: getMetaValue(entries, 'rsver'),
    cliVersion: getMetaValue(entries, 'cliver'),
    sourceRepo: getMetaValue(entries, 'source_repo'),
    sourceRev: getMetaValue(entries, 'source_rev'),
    sourceSha256: getMetaValue(entries, 'source_sha256'),
    sourceUri: getMetaValue(entries, 'source_uri'),
    buildArgs: buildArgs.length > 0 ? buildArgs : ['contract', 'build'],
    buildOptions,
    present,
  };
}

/** Translate a PR-style bldopt_* meta key to its flag form, or null. */
function translateBldopt(key: string, value: string): string | null {
  switch (key) {
    case 'bldopt_manifest_path':
      return `--manifest-path=${value}`;
    case 'bldopt_package':
      return `--package=${value}`;
    case 'bldopt_profile':
      return `--profile=${value}`;
    case 'bldopt_optimize':
      return value === 'true' ? '--optimize' : '--optimize=false';
    default:
      return null; // unknown structured field — ignore rather than guess
  }
}
