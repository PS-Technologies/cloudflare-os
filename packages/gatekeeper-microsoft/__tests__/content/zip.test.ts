import { Inflate } from "pako";
import { describe, expect, it, vi } from "vitest";
import { buildZip, deflateRaw } from "./test-fixtures";
import { ZipError, crc32, openZip, type ZipErrorCode } from "../../src/content/zip";
import { writeZip } from "../../src/content/zip-write";

async function expectZipError(promise: Promise<unknown> | (() => unknown), code: ZipErrorCode): Promise<void> {
  const attempt = typeof promise === "function" ? Promise.resolve().then(promise) : promise;
  await expect(attempt).rejects.toSatisfy((error: unknown) => error instanceof ZipError && error.code === code);
}

function patchUint32(bytes: Uint8Array, offset: number, value: number): Uint8Array {
  const copy = bytes.slice();
  new DataView(copy.buffer).setUint32(offset, value, true);
  return copy;
}

function patchUint16(bytes: Uint8Array, offset: number, value: number): Uint8Array {
  const copy = bytes.slice();
  new DataView(copy.buffer).setUint16(offset, value, true);
  return copy;
}

/** `size` zeros deflated into an entry that claims 100 bytes: written as stored, then relabelled deflated in both headers. */
async function deflatedBomb(size: number): Promise<Uint8Array> {
  const archive = await buildZip([{ name: "bomb", data: await deflateRaw(new Uint8Array(size)), method: "store", declaredSize: 100 }]);
  const centralStart = archive.length - 22 - 50;
  return patchUint16(patchUint16(archive, 8, 8), centralStart + 10, 8);
}

/** `stream` as a deflated entry holding `text`, so a reader that accepts the stream reads `text` and passes every check. */
async function deflatedEntry(stream: Uint8Array, text: string): Promise<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  const archive = await buildZip([{ name: "a.txt", data: stream, method: "store", declaredSize: bytes.length, crc: crc32(bytes) }]);
  return patchUint16(patchUint16(archive, 8, 8), archive.length - 22 - 51 + 10, 8);
}

/**
 * workerd's DecompressionStream inflates whatever is written to it whether or not anything reads
 * the output: it applies no backpressure. This stand-in for it does the same.
 */
class EagerDecompressionStream extends TransformStream<Uint8Array, Uint8Array> {
  constructor() {
    const inflater = new Inflate({ raw: true });
    super({
      start: controller => { inflater.onData = chunk => controller.enqueue(chunk); },
      transform: chunk => { inflater.push(chunk, false); },
      flush: () => { inflater.push(new Uint8Array(0), true); },
    }, undefined, { highWaterMark: Infinity });
  }
}

describe("openZip", () => {
  it("reads stored and deflated entries", async () => {
    const zip = openZip(await buildZip([
      { name: "a.txt", data: "stored text", method: "store" },
      { name: "dir/b.xml", data: "<x>deflated</x>".repeat(100) },
    ]));
    expect(zip.entries().map(entry => entry.name)).toEqual(["a.txt", "dir/b.xml"]);
    expect(await zip.readText("a.txt")).toBe("stored text");
    expect(await zip.readText("dir/b.xml")).toBe("<x>deflated</x>".repeat(100));
  });

  it("looks names up case-insensitively, as OPC part names are", async () => {
    const zip = openZip(await buildZip([{ name: "Word/Document.xml", data: "x" }]));
    expect(zip.has("word/document.xml")).toBe(true);
    expect(await zip.readText("WORD/DOCUMENT.XML")).toBe("x");
    await expectZipError(zip.readText("missing.xml"), "not-found");
  });

  it("reads text through a byte order mark, as any UTF-16 part would have", async () => {
    const utf16 = new Uint8Array([0xff, 0xfe, ...[..."<a/>"].flatMap(char => [char.charCodeAt(0), 0])]);
    const zip = openZip(await buildZip([{ name: "a.xml", data: utf16 }, { name: "b.xml", data: new Uint8Array([0xef, 0xbb, 0xbf, 0x3c, 0x62, 0x2f, 0x3e]) }]));
    expect(await zip.readText("a.xml")).toBe("<a/>");
    expect(await zip.readText("b.xml")).toBe("<b/>");
  });

  it("decodes names as UTF-8 when flagged and as code page 437 otherwise", async () => {
    const zip = openZip(await buildZip([
      { name: "résumé.txt", data: "utf8" },
      { name: "cp437", nameBytes: new Uint8Array([0x81, 0x62, 0x65, 0x72]), flags: 0, data: "cp437" },
    ]));
    expect(zip.entries().map(entry => entry.name)).toEqual(["résumé.txt", "über"]);
  });

  it("finds the directory behind an archive comment", async () => {
    const archive = await buildZip([{ name: "a.txt", data: "hi" }]);
    const comment = new TextEncoder().encode("PK\x05\x06 a comment that mimics a signature");
    const withComment = new Uint8Array(archive.length + comment.length);
    withComment.set(patchUint16(archive, archive.length - 2, comment.length));
    withComment.set(comment, archive.length);
    expect(await openZip(withComment).readText("a.txt")).toBe("hi");
  });

  it("refuses bytes that are not an archive", async () => {
    await expectZipError(() => openZip(new TextEncoder().encode("not a zip file at all")), "malformed");
    await expectZipError(() => openZip(new Uint8Array(0)), "malformed");
  });

  it("refuses a truncated archive", async () => {
    const archive = await buildZip([{ name: "a.txt", data: "hello" }]);
    await expectZipError(() => openZip(archive.subarray(0, archive.length - 10)), "malformed");
  });

  it("refuses a directory that points outside the file", async () => {
    const archive = await buildZip([{ name: "a.txt", data: "hello" }]);
    await expectZipError(() => openZip(patchUint32(archive, archive.length - 6, 0x00ffffff)), "malformed");
  });

  it("refuses encrypted entries", async () => {
    await expectZipError(async () => openZip(await buildZip([{ name: "secret.xml", data: "x", flags: 1 }])), "encrypted");
  });

  it("refuses Zip64 archives and entries", async () => {
    const archive = await buildZip([{ name: "a.txt", data: "x" }]);
    await expectZipError(() => openZip(patchUint32(archive, archive.length - 6, 0xffffffff)), "zip64");
    await expectZipError(async () => openZip(await buildZip([{ name: "big", data: "x", declaredSize: 0xffffffff }])), "zip64");
  });

  it("refuses multi-disk archives", async () => {
    const archive = await buildZip([{ name: "a.txt", data: "x" }]);
    await expectZipError(() => openZip(patchUint16(archive, archive.length - 18, 1)), "multi-disk");
  });

  it("refuses duplicate names, which different readers could resolve differently", async () => {
    await expectZipError(async () => openZip(await buildZip([{ name: "a.xml", data: "1" }, { name: "A.XML", data: "2" }])), "duplicate-entry");
  });

  it("refuses unsupported compression methods", async () => {
    const archive = await buildZip([{ name: "a.txt", data: "x", method: "store" }]);
    // The central header's method field: 22-byte EOCD, then a 46+5 byte central entry before it.
    const centralStart = archive.length - 22 - 51;
    await expectZipError(openZip(patchUint16(archive, centralStart + 10, 12)).readBytes("a.txt"), "unsupported-method");
  });

  it("refuses more entries than the limit", async () => {
    const entries = Array.from({ length: 11 }, (_, index) => ({ name: `${index}.txt`, data: "x" }));
    await expectZipError(async () => openZip(await buildZip(entries), { maxEntries: 10 }), "too-many-entries");
  });

  it("detects corrupt data by checksum", async () => {
    const zip = openZip(await buildZip([{ name: "a.txt", data: "hello", crc: 1234 }]));
    await expectZipError(zip.readText("a.txt"), "checksum");
  });

  it("refuses corrupt deflate data", async () => {
    const archive = await buildZip([{ name: "a.txt", data: "hello world hello world" }]);
    // Flip bits inside the compressed stream (local header 30 + name 5).
    const corrupt = archive.slice();
    for (let at = 35; at < 40; at++) corrupt[at] = corrupt[at]! ^ 0xff;
    await expect(openZip(corrupt).readText("a.txt")).rejects.toBeInstanceOf(ZipError);
  });

  it("refuses deflate data cut short or followed by trailing bytes", async () => {
    const text = "hello world hello world";
    // One stored block not marked final: complete output, but the stream never ends.
    const unfinished = new Uint8Array([0x00, text.length, 0x00, ~text.length & 0xff, 0xff, ...new TextEncoder().encode(text)]);
    await expectZipError(openZip(await deflatedEntry(unfinished, text)).readText("a.txt"), "malformed");
    const trailing = new Uint8Array([...await deflateRaw(new TextEncoder().encode(text)), 1, 2, 3]);
    await expectZipError(openZip(await deflatedEntry(trailing, text)).readText("a.txt"), "malformed");
    // The same bytes, well formed, read: the refusals above are the stream's and nothing else.
    expect(await openZip(await deflatedEntry(await deflateRaw(new TextEncoder().encode(text)), text)).readText("a.txt")).toBe(text);
  });

  it("refuses an entry whose real size differs from what it declares", async () => {
    const zip = openZip(await buildZip([{ name: "a.txt", data: "hello", declaredSize: 50 }]));
    await expectZipError(zip.readText("a.txt"), "malformed");
  });

  it("keeps traversal names inert rather than aliasing Office parts", async () => {
    const zip = openZip(await buildZip([
      { name: "../word/document.xml", data: "crafted" },
      { name: "word/document.xml", data: "legitimate" },
      { name: "../outside", data: "inert" },
    ]));
    expect(await zip.readText("word/document.xml")).toBe("legitimate");
    expect(await zip.readText("../word/document.xml")).toBe("crafted");
    expect(zip.has("outside")).toBe(false);
    await expectZipError(zip.readBytes("outside"), "not-found");
  });

  describe("decompression bombs", () => {
    it("refuses an entry that declares more than the limit without inflating it", async () => {
      const zip = openZip(await buildZip([{ name: "big", data: "x", declaredSize: 30 * 1024 * 1024 }]));
      await expectZipError(zip.readBytes("big"), "entry-too-large");
    });

    it("stops inflating once the output passes the limit, whatever the entry declares", async () => {
      // 30 MiB of zeros deflates to about 30 KiB; it claims to be 100 bytes.
      const zeros = new Uint8Array(30 * 1024 * 1024);
      const compressed = await deflateRaw(zeros);
      expect(compressed.length).toBeLessThan(100_000);
      const archive = await buildZip([{ name: "bomb", data: compressed, method: "store", declaredSize: 100 }]);
      // Rewrite the entry as deflated without re-compressing: method field in local and central headers.
      const centralStart = archive.length - 22 - 50;
      const patched = patchUint16(patchUint16(archive, 8, 8), centralStart + 10, 8);
      const started = performance.now();
      await expectZipError(openZip(patched).readBytes("bomb"), "entry-too-large");
      expect(performance.now() - started).toBeLessThan(5_000);
    });

    it("never inflates much past the limit, on a runtime whose inflater does not wait for its reader", async () => {
      let inflated = 0;
      const counted = new WeakSet<Inflate>();
      const push = Inflate.prototype.push;
      vi.spyOn(Inflate.prototype, "push").mockImplementation(function (this: Inflate, ...args: Parameters<Inflate["push"]>) {
        if (!counted.has(this)) {
          counted.add(this);
          const onData = this.onData;
          this.onData = chunk => {
            inflated += chunk.length;
            onData.call(this, chunk);
          };
        }
        return push.apply(this, args);
      });
      vi.stubGlobal("DecompressionStream", EagerDecompressionStream);
      try {
        const zip = openZip(await deflatedBomb(32 * 1024 * 1024), { maxEntryBytes: 1024 * 1024 });
        await expectZipError(zip.readBytes("bomb"), "entry-too-large");
        // The limit plus at most one 64 KiB output chunk, not the 32 MiB the entry inflates to.
        expect(inflated).toBeLessThanOrEqual(1024 * 1024 + 64 * 1024);
      } finally {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
      }
    });

    it("bounds the total inflated across one archive's entries, counting an entry once however often it is read", async () => {
      const zip = openZip(await buildZip([
        { name: "a", data: "a".repeat(600) },
        { name: "b", data: "b".repeat(600) },
      ]), { maxEntryBytes: 1000, maxTotalBytes: 1000 });
      expect((await zip.readBytes("a")).length).toBe(600);
      expect(await zip.readText("A")).toBe("a".repeat(600));
      expect((await zip.readBytes("a")).length).toBe(600);
      await expectZipError(zip.readBytes("b"), "archive-too-large");
    });

    it("lets a package just inside the budget be read part by part as many times as editing needs", async () => {
      const entries = Array.from({ length: 5 }, (_, index) => ({ name: `part${index}.xml`, data: "x".repeat(190) }));
      const zip = openZip(await buildZip(entries), { maxTotalBytes: 1000 });
      for (let pass = 0; pass < 3; pass++) for (const entry of entries) expect((await zip.readBytes(entry.name)).length).toBe(190);
    });

    it("applies the limit to stored entries too", async () => {
      const zip = openZip(await buildZip([{ name: "a", data: "a".repeat(2000), method: "store" }]), { maxEntryBytes: 1000 });
      await expectZipError(zip.readBytes("a"), "entry-too-large");
    });
  });
});

describe("writeZip", () => {
  it("round-trips entries and refuses what a reader could misplace or not list", async () => {
    const zip = openZip(await writeZip([{ name: "[Content_Types].xml", data: "<Types/>" }, { name: "word/document.xml", data: "x".repeat(5000) }]));
    expect(await zip.readText("word/document.xml")).toBe("x".repeat(5000));
    await expect(writeZip([{ name: "a.xml", data: "1" }, { name: "A.XML", data: "2" }])).rejects.toThrow(/twice/);
    for (const name of ["../escape.xml", "/absolute.xml", "a//b.xml", "a\\b.xml", "./a.xml", ""]) {
      await expect(writeZip([{ name, data: "x" }]), name).rejects.toThrow(/not a valid part name/);
    }
    await expect(writeZip(Array.from({ length: 65_536 }, (_, index) => ({ name: `${index}`, data: "" })))).rejects.toThrow(/at most 65535 entries/);
  });
});

describe("crc32", () => {
  it("matches the standard check value", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });
});
