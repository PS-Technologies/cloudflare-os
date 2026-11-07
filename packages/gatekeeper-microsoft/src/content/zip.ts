// A minimal ZIP reader for the Office Open XML containers the content converters read. The bytes
// come from a user's tenant and are untrusted, so the reader accepts only the subset of the format
// Office writes (one disk, no Zip64, no encryption, stored or deflated entries) and bounds what it
// inflates by its own count of bytes produced: no entry past the size it declares, which must be
// within the limits before anything is inflated, and must be what it inflates to. An entry is
// inflated once and kept, so the bound is on the archive's content rather than on how often a
// converter reads a part.

import { Inflate } from "pako";
import { decodeText } from "./text";

/** Why an archive was refused. */
export type ZipErrorCode =
  | "malformed"
  | "zip64"
  | "encrypted"
  | "multi-disk"
  | "unsupported-method"
  | "duplicate-entry"
  | "too-many-entries"
  | "entry-too-large"
  | "archive-too-large"
  | "checksum"
  | "not-found";

/** An archive the reader will not open, or an entry it will not read. */
export class ZipError extends Error {
  override readonly name = "ZipError";
  constructor(readonly code: ZipErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

/** Bounds on what one archive may make the reader allocate. */
export interface ZipLimits {
  /** The most central-directory entries an archive may list. */
  readonly maxEntries: number;
  /** The most bytes one entry may inflate to. */
  readonly maxEntryBytes: number;
  /** The most bytes the entries read from one archive may inflate to, together, each counted once. */
  readonly maxTotalBytes: number;
}

/** Generous for any real Office document, small enough to keep a Worker isolate well inside its memory. */
const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxEntries: 5_000,
  maxEntryBytes: 20 * 1024 * 1024,
  maxTotalBytes: 50 * 1024 * 1024,
};

/** One file in an archive, as its central directory describes it. */
export interface ZipEntry {
  readonly name: string;
  /** 0 (stored) or 8 (deflated). */
  readonly method: number;
  /** What the archive claims; reads verify it rather than trust it. */
  readonly declaredSize: number;
}

/** A directory entry with what a read needs to find and verify its data. */
interface DirectoryEntry extends ZipEntry {
  readonly compressedSize: number;
  readonly crc32: number;
  readonly localHeaderOffset: number;
}

/** An opened archive. Lookups are case-insensitive, as OPC part names are. */
export interface ZipArchive {
  entries(): readonly ZipEntry[];
  has(name: string): boolean;
  /** The entry's content. Reads of one entry share one array, which callers must not modify. */
  readBytes(name: string): Promise<Uint8Array>;
  /** The entry decoded as text: UTF-8, or UTF-16 after a byte order mark, with invalid bytes replaced. */
  readText(name: string): Promise<string>;
}

const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_SIZE = 22;
const ZIP64_LOCATOR_SIZE = 20;
const CENTRAL_HEADER_SIZE = 46;
const LOCAL_HEADER_SIZE = 30;
const MAX_COMMENT_SIZE = 0xffff;

const FLAG_ENCRYPTED = 1 << 0;
const FLAG_STRONG_ENCRYPTION = 1 << 6;
const FLAG_UTF8 = 1 << 11;
const FLAG_ENCRYPTED_DIRECTORY = 1 << 13;

const METHOD_STORED = 0;
const METHOD_DEFLATED = 8;

/** Parses the archive's directory. Entry contents are inflated only when read. */
export function openZip(bytes: Uint8Array, limits: Partial<ZipLimits> = {}): ZipArchive {
  const bounds: ZipLimits = { ...DEFAULT_ZIP_LIMITS, ...limits };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const directory = readEndOfCentralDirectory(bytes, view);
  if (directory.entryCount > bounds.maxEntries) {
    throw new ZipError("too-many-entries", `Archive lists ${directory.entryCount} entries; the limit is ${bounds.maxEntries}`);
  }
  const entries = readCentralDirectory(bytes, view, directory);
  return new Archive(bytes, view, entries, directory.offset, bounds);
}

interface CentralDirectoryLocation {
  readonly offset: number;
  readonly size: number;
  readonly entryCount: number;
}

/**
 * Finds the End of Central Directory record, which sits in the last 22 bytes plus up to a 64 KiB
 * comment, by scanning backwards for the last signature whose comment fits the file.
 */
function readEndOfCentralDirectory(bytes: Uint8Array, view: DataView): CentralDirectoryLocation {
  const lowest = Math.max(0, bytes.length - EOCD_SIZE - MAX_COMMENT_SIZE);
  for (let at = bytes.length - EOCD_SIZE; at >= lowest; at--) {
    if (view.getUint32(at, true) !== EOCD_SIGNATURE) continue;
    if (at + EOCD_SIZE + view.getUint16(at + 20, true) > bytes.length) continue;
    return parseEndOfCentralDirectory(view, at);
  }
  throw new ZipError("malformed", "Not a ZIP archive: no end of central directory record");
}

function parseEndOfCentralDirectory(view: DataView, at: number): CentralDirectoryLocation {
  const disk = view.getUint16(at + 4, true);
  const directoryDisk = view.getUint16(at + 6, true);
  const entriesOnDisk = view.getUint16(at + 8, true);
  const entryCount = view.getUint16(at + 10, true);
  const size = view.getUint32(at + 12, true);
  const offset = view.getUint32(at + 16, true);
  const hasZip64Locator = at >= ZIP64_LOCATOR_SIZE && view.getUint32(at - ZIP64_LOCATOR_SIZE, true) === ZIP64_LOCATOR_SIGNATURE;
  if (hasZip64Locator || entryCount === 0xffff || size === 0xffffffff || offset === 0xffffffff) {
    throw new ZipError("zip64", "Zip64 archives are not supported");
  }
  if (disk !== 0 || directoryDisk !== 0 || entriesOnDisk !== entryCount) {
    throw new ZipError("multi-disk", "Multi-disk archives are not supported");
  }
  if (offset + size > at) throw new ZipError("malformed", "Central directory lies outside the archive");
  return { offset, size, entryCount };
}

function readCentralDirectory(bytes: Uint8Array, view: DataView, directory: CentralDirectoryLocation): Map<string, DirectoryEntry> {
  const entries = new Map<string, DirectoryEntry>();
  const end = directory.offset + directory.size;
  let at = directory.offset;
  for (let index = 0; index < directory.entryCount; index++) {
    if (at + CENTRAL_HEADER_SIZE > end || view.getUint32(at, true) !== CENTRAL_SIGNATURE) {
      throw new ZipError("malformed", "Truncated or corrupt central directory");
    }
    const { entry, headerSize } = parseCentralHeader(bytes, view, at, end);
    const key = entry.name.toLowerCase();
    if (entries.has(key)) throw new ZipError("duplicate-entry", `Archive lists "${entry.name}" more than once`);
    entries.set(key, entry);
    at += headerSize;
  }
  return entries;
}

function parseCentralHeader(bytes: Uint8Array, view: DataView, at: number, end: number): { entry: DirectoryEntry; headerSize: number } {
  const flags = view.getUint16(at + 8, true);
  const method = view.getUint16(at + 10, true);
  const crc32 = view.getUint32(at + 16, true);
  const compressedSize = view.getUint32(at + 20, true);
  const declaredSize = view.getUint32(at + 24, true);
  const nameLength = view.getUint16(at + 28, true);
  const extraLength = view.getUint16(at + 30, true);
  const commentLength = view.getUint16(at + 32, true);
  const startDisk = view.getUint16(at + 34, true);
  const localHeaderOffset = view.getUint32(at + 42, true);
  const headerSize = CENTRAL_HEADER_SIZE + nameLength + extraLength + commentLength;
  if (at + headerSize > end) throw new ZipError("malformed", "Truncated central directory entry");
  const name = decodeEntryName(bytes.subarray(at + CENTRAL_HEADER_SIZE, at + CENTRAL_HEADER_SIZE + nameLength), flags);

  if (flags & (FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION | FLAG_ENCRYPTED_DIRECTORY)) {
    throw new ZipError("encrypted", `Entry "${name}" is encrypted`);
  }
  if (compressedSize === 0xffffffff || declaredSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
    throw new ZipError("zip64", `Entry "${name}" needs Zip64`);
  }
  if (startDisk !== 0) throw new ZipError("multi-disk", `Entry "${name}" starts on another disk`);
  return { entry: { name, method, compressedSize, declaredSize, crc32, localHeaderOffset }, headerSize };
}

/** Entry names are UTF-8 when flag bit 11 is set, and IBM code page 437 otherwise (APPNOTE 4.4.4). */
function decodeEntryName(raw: Uint8Array, flags: number): string {
  if (flags & FLAG_UTF8) return new TextDecoder("utf-8").decode(raw);
  let name = "";
  for (const byte of raw) name += byte < 0x80 ? String.fromCharCode(byte) : CP437_HIGH[byte - 0x80];
  return name;
}

/** Code page 437's characters for bytes 0x80 to 0xFF. */
const CP437_HIGH =
  "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀" +
  "αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ";

class Archive implements ZipArchive {
  #inflatedSoFar = 0;
  /** Verified content by lower-case name, so an entry costs one inflate and one count against the budget. */
  readonly #inflated = new Map<string, Uint8Array>();

  constructor(
    private readonly bytes: Uint8Array,
    private readonly view: DataView,
    private readonly byName: ReadonlyMap<string, DirectoryEntry>,
    private readonly centralDirectoryOffset: number,
    private readonly limits: ZipLimits,
  ) {}

  entries(): readonly ZipEntry[] {
    return [...this.byName.values()];
  }

  has(name: string): boolean {
    return this.byName.has(name.toLowerCase());
  }

  async readText(name: string): Promise<string> {
    return decodeText(await this.readBytes(name));
  }

  async readBytes(name: string): Promise<Uint8Array> {
    const key = name.toLowerCase();
    const cached = this.#inflated.get(key);
    if (cached) return cached;
    const entry = this.byName.get(key);
    if (!entry) throw new ZipError("not-found", `Archive has no entry "${name}"`);
    const limit = Math.min(this.limits.maxEntryBytes, this.limits.maxTotalBytes - this.#inflatedSoFar);
    if (entry.declaredSize > limit) throw this.#limitError(entry, limit);

    const data = this.#entryData(entry);
    const content = this.#decompress(entry, data, limit);
    if (content.length !== entry.declaredSize) {
      throw new ZipError("malformed", `Entry "${entry.name}" is ${content.length} bytes, not the ${entry.declaredSize} it declares`);
    }
    if (crc32(content) !== entry.crc32) throw new ZipError("checksum", `Entry "${entry.name}" fails its checksum`);
    this.#inflated.set(key, content);
    return content;
  }

  /**
   * The entry's compressed bytes. The local header repeats the name and carries its own extra
   * field, so the data's start is read from it; its sizes may be zero (flag bit 3 defers them to a
   * data descriptor), so the central directory's sizes are the ones used.
   */
  #entryData(entry: DirectoryEntry): Uint8Array {
    const at = entry.localHeaderOffset;
    if (at + LOCAL_HEADER_SIZE > this.centralDirectoryOffset || this.view.getUint32(at, true) !== LOCAL_SIGNATURE) {
      throw new ZipError("malformed", `Entry "${entry.name}" has no local header`);
    }
    const start = at + LOCAL_HEADER_SIZE + this.view.getUint16(at + 26, true) + this.view.getUint16(at + 28, true);
    const end = start + entry.compressedSize;
    if (end > this.centralDirectoryOffset) throw new ZipError("malformed", `Entry "${entry.name}" runs past the archive's data`);
    return this.bytes.subarray(start, end);
  }

  #decompress(entry: DirectoryEntry, data: Uint8Array, limit: number): Uint8Array {
    switch (entry.method) {
      case METHOD_STORED:
        if (data.length > limit) throw this.#limitError(entry, limit);
        this.#inflatedSoFar += data.length;
        return data.slice();
      case METHOD_DEFLATED: {
        const content = inflateRaw(data, entry.declaredSize, entry.name);
        this.#inflatedSoFar += content.length;
        return content;
      }
      default:
        throw new ZipError("unsupported-method", `Entry "${entry.name}" uses compression method ${entry.method}`);
    }
  }

  #limitError(entry: DirectoryEntry, limit: number): ZipError {
    return limit < this.limits.maxEntryBytes
      ? new ZipError("archive-too-large", `Archive inflates past ${this.limits.maxTotalBytes} bytes`)
      : new ZipError("entry-too-large", `Entry "${entry.name}" inflates past ${limit} bytes`);
  }
}

/**
 * Inflates raw deflate data into an array of the `size` the entry declares (which its caller has
 * held to the limits), stopping as soon as the output passes it. pako hands over its output a chunk
 * (64 KiB at most) at a time, and a chunk that would pass the size is refused before it is copied,
 * so a bomb costs the declared size plus one chunk, and an entry that declares less than it holds
 * costs no more than it declares. workerd's DecompressionStream can't be stopped that way: it
 * applies no backpressure, inflating everything written to it whether or not its output is read. A
 * stream that is cut short, damaged or followed by more bytes is refused, as the platform's inflater
 * refuses it. Shorter output is returned as it is, for the caller to refuse against the size.
 */
function inflateRaw(data: Uint8Array, size: number, name: string): Uint8Array {
  const inflater = new Inflate({ raw: true }) as unknown as InflateWithInternals;
  const content = new Uint8Array(size);
  let total = 0;
  inflater.onData = chunk => {
    // pako offers no abort; raising here unwinds through push() below.
    if (total + chunk.length > size) throw new ZipError("malformed", `Entry "${name}" inflates past the ${size} bytes it declares`);
    content.set(chunk, total);
    total += chunk.length;
  };
  inflater.push(data, true);
  if (inflater.err !== 0 || !inflater.ended || inflater.strm.avail_in > 0) {
    throw new ZipError("malformed", `Entry "${name}" is not valid deflate data${inflater.msg ? ` (${inflater.msg})` : ""}`);
  }
  return total === size ? content : content.subarray(0, total);
}

// pako's Inflate as this reader uses it: `strm.avail_in`, which pako's declarations keep private,
// is how many input bytes the stream left unread once it ended.
interface InflateWithInternals {
  ended: boolean;
  err: number;
  msg: string;
  strm: { avail_in: number };
  onData: (chunk: Uint8Array) => void;
  push(data: Uint8Array, flush: boolean): boolean;
}

/** The chunks as one array; `total` is their combined length when the caller already has it. */
export function concat(chunks: readonly Uint8Array[], total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)): Uint8Array {
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

let crcTable: Uint32Array | undefined;

/** The CRC-32 (IEEE 802.3) ZIP records for each entry. */
export function crc32(data: Uint8Array): number {
  crcTable ??= buildCrcTable();
  let crc = 0xffffffff;
  for (const byte of data) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function buildCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let bit = 0; bit < 8; bit++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
}
