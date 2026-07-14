// Dependency-FREE ZIP entry extraction — just enough to pull the text members out of a
// Playwright `trace.zip` using only Node's built-in `zlib`. The package ships 4 runtime deps and
// a trace reader must not add a fifth; a full ZIP library is overkill for reading two or three
// stored/deflated entries. We read the CENTRAL DIRECTORY (authoritative sizes) rather than trust
// the local header — Playwright streams entries with data descriptors (local sizes are 0), so the
// central directory is the only reliable size source. Its output was checked byte-for-byte against
// system `unzip` on real v8 traces during development. Not a general ZIP reader: ZIP64 and
// encryption are explicitly refused, not guessed.

import { inflateRawSync } from 'node:zlib';

const EOCD_SIG = 0x06054b50; // End Of Central Directory
const CEN_SIG = 0x02014b50; // Central directory file header
const LOC_SIG = 0x04034b50; // Local file header
const ZIP64_MARK = 0xffffffff; // a size/offset field of all-ones ⇒ real value is in a ZIP64 record

/** A ZIP that is malformed, truncated, or uses a feature we deliberately do not support. */
export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipError';
  }
}

interface CentralEntry {
  name: string;
  /** Compression method: 0 = stored, 8 = deflate. */
  method: number;
  /** Compressed size, from the central directory (authoritative). */
  compSize: number;
  /** Offset of the local file header. */
  localOff: number;
}

/** Locate the End Of Central Directory record by scanning backward from the end. */
function findEOCD(buf: Buffer): number {
  const MIN = 22; // EOCD is 22 bytes with an empty comment
  const MAX_COMMENT = 0xffff;
  const floor = Math.max(0, buf.length - (MIN + MAX_COMMENT));
  for (let i = buf.length - MIN; i >= floor; i--) {
    if (buf.readUInt32LE(i) !== EOCD_SIG) continue;
    // Validate the comment length points exactly at end-of-buffer, so the signature bytes appearing
    // INSIDE an archive comment can't be mistaken for the real (earlier) EOCD record.
    if (i + MIN + buf.readUInt16LE(i + 20) === buf.length) return i;
  }
  throw new ZipError('not a ZIP archive (no End-Of-Central-Directory record found)');
}

/** Parse the central directory into its entries. */
function centralDirectory(buf: Buffer): CentralEntry[] {
  const eocd = findEOCD(buf);
  const total = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset === ZIP64_MARK || total === 0xffff) {
    throw new ZipError(
      'ZIP64 archives are not supported — regenerate the trace with a smaller run',
    );
  }
  const entries: CentralEntry[] = [];
  let off = cdOffset;
  for (let n = 0; n < total; n++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== CEN_SIG) {
      throw new ZipError('corrupt ZIP central directory');
    }
    const flags = buf.readUInt16LE(off + 8);
    if (flags & 0x1) throw new ZipError('encrypted ZIP entries are not supported');
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    if (compSize === ZIP64_MARK || localOff === ZIP64_MARK) {
      throw new ZipError('ZIP64 archives are not supported');
    }
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    entries.push({ name, method, compSize, localOff });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Decompress one central-directory entry's bytes from its local header. */
function inflateEntry(buf: Buffer, entry: CentralEntry): Buffer {
  const o = entry.localOff;
  if (o + 30 > buf.length || buf.readUInt32LE(o) !== LOC_SIG) {
    throw new ZipError(`corrupt ZIP local header for "${entry.name}"`);
  }
  const nameLen = buf.readUInt16LE(o + 26);
  const extraLen = buf.readUInt16LE(o + 28);
  const start = o + 30 + nameLen + extraLen;
  const data = buf.subarray(start, start + entry.compSize);
  if (entry.method === 0) return Buffer.from(data); // stored
  if (entry.method === 8) {
    // Wrap zlib's generic error so a corrupt/truncated entry surfaces as a ZipError — the one
    // failure type callers are told to expect (never an undocumented raw zlib throw).
    try {
      return inflateRawSync(data);
    } catch (err) {
      throw new ZipError(`corrupt deflate stream for "${entry.name}": ${(err as Error).message}`);
    }
  }
  throw new ZipError(`unsupported ZIP compression method ${entry.method} for "${entry.name}"`);
}

/** List the entry names in a ZIP buffer. */
export function zipEntryNames(buf: Buffer): string[] {
  return centralDirectory(buf).map((e) => e.name);
}

/**
 * Extract and decompress one named entry from a ZIP buffer, or null if the entry is absent.
 * Throws `ZipError` for a malformed archive or an unsupported feature (ZIP64 / encryption /
 * unknown compression) — we never guess at bytes we can't decode.
 */
export function readZipEntry(buf: Buffer, name: string): Buffer | null {
  const entry = centralDirectory(buf).find((e) => e.name === name);
  if (!entry) return null;
  return inflateEntry(buf, entry);
}
