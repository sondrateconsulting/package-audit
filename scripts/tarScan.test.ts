import { expect, test, describe } from "bun:test";
// node:zlib, not Bun.gzipSync/gunzipSync: @types/bun >=1.3 requires Uint8Array<ArrayBuffer>,
// which neither the tar builders' return type nor scanTarball's gunzip-callback parameter
// guarantees — and production feeds scanTarball node:zlib via inflateBounded anyway.
import { gzipSync, gunzipSync } from "node:zlib";
import { parseTarEntries, validateEntries, scanTarball, type TarEntry } from "./tarScan.ts";

// ---- a minimal tar builder (checksums are not validated by the scanner) --------------------
const BLOCK = 512;
function octal(n: number, len: number): string {
  return n.toString(8).padStart(len - 1, "0") + "\0";
}
interface BuildEntry {
  name: string;
  type?: string; // '0' file, '5' dir, '2' symlink, '1' hardlink, '3' char, '6' fifo
  data?: Uint8Array;
  size?: number; // override (defaults to data length)
  prefix?: string;
}
function header(e: BuildEntry): Uint8Array {
  const h = new Uint8Array(BLOCK);
  const enc = new TextEncoder();
  const put = (s: string, off: number, len: number) => h.set(enc.encode(s).subarray(0, len), off);
  put(e.name, 0, 100);
  put(octal(0o644, 8), 100, 8);
  put(octal(0, 8), 108, 8);
  put(octal(0, 8), 116, 8);
  put(octal(e.size ?? e.data?.length ?? 0, 12), 124, 12);
  put(octal(0, 12), 136, 12);
  h[156] = (e.type ?? "0").charCodeAt(0);
  put("ustar\0", 257, 6);
  put("00", 263, 2);
  if (e.prefix) put(e.prefix, 345, 155);
  return h;
}
function buildTar(entries: BuildEntry[]): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const e of entries) {
    blocks.push(header(e));
    if (e.data && e.data.length > 0) {
      const padded = new Uint8Array(Math.ceil(e.data.length / BLOCK) * BLOCK);
      padded.set(e.data);
      blocks.push(padded);
    }
  }
  blocks.push(new Uint8Array(BLOCK), new Uint8Array(BLOCK)); // two zero blocks
  const total = blocks.reduce((n, b) => n + b.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const b of blocks) {
    out.set(b, off);
    off += b.length;
  }
  return out;
}
const data = (s: string): Uint8Array => new TextEncoder().encode(s);

describe("parseTarEntries — happy path", () => {
  test("parses names, sizes, typeflags and ustar prefix", () => {
    const tar = buildTar([
      { name: "package/", type: "5" },
      { name: "package.json", prefix: "package", data: data(`{"name":"x"}`) },
      { name: "index.d.ts", prefix: "package", data: data("export const a=1;") },
    ]);
    const r = parseTarEntries(tar);
    expect(r.ok).toBe(true);
    expect(r.entries.map((e) => e.name)).toEqual(["package/", "package/package.json", "package/index.d.ts"]);
    expect(r.entries[1]!.size).toBe(12);
  });
  test("stops at the end-of-archive zero blocks", () => {
    const r = parseTarEntries(buildTar([{ name: "package/a", data: data("hi") }]));
    expect(r.entries.length).toBe(1);
  });
});

describe("validateEntries — §5.E safety rejections", () => {
  const scan = (entries: BuildEntry[]) => validateEntries(parseTarEntries(buildTar(entries)).entries);
  test("accepts plain files and dirs", () => {
    expect(scan([{ name: "package/", type: "5" }, { name: "package/a.js", data: data("x") }]).ok).toBe(true);
  });
  test("rejects a symlink member", () => {
    expect(scan([{ name: "package/evil", type: "2" }]).ok).toBe(false);
  });
  test("rejects a hardlink member", () => {
    expect(scan([{ name: "package/evil", type: "1" }]).ok).toBe(false);
  });
  test("rejects a device/fifo member", () => {
    expect(scan([{ name: "package/dev", type: "3" }]).ok).toBe(false);
    expect(scan([{ name: "package/fifo", type: "6" }]).ok).toBe(false);
  });
  test("a DIRECTORY with a bogus nonzero size cannot hide a trailing symlink (data-block skip attack)", () => {
    // a dir entry only occupies its header block (tar ignores its size), so the symlink header
    // that follows MUST be parsed and rejected — advancing by the dir's bogus size would skip it.
    const r = parseTarEntries(buildTar([
      { name: "package/dir/", type: "5", size: 512 }, // bogus 512-byte size on a directory
      { name: "package/evil", type: "2" }, // symlink hidden in the "skipped" block
      { name: "package/normal.txt", data: data("x") },
    ]));
    expect(r.entries.some((e) => e.name === "package/evil" && e.typeflag === "2")).toBe(true);
    expect(validateEntries(r.entries).ok).toBe(false); // the symlink is now seen and rejected
  });
  test("rejects an absolute path", () => {
    expect(scan([{ name: "/etc/passwd", data: data("x") }]).ok).toBe(false);
  });
  test("rejects a .. traversal component (forward AND backslash)", () => {
    expect(scan([{ name: "package/../escape", data: data("x") }]).ok).toBe(false);
    expect(validateEntries([{ name: "package\\..\\escape", size: 1, typeflag: "0" }]).ok).toBe(false);
    expect(validateEntries([{ name: "\\etc\\passwd", size: 1, typeflag: "0" }]).ok).toBe(false);
  });
});

describe("parseTarEntries — PAX and GNU long names", () => {
  test("a PAX path record overrides the following entry name", () => {
    const longName = "package/" + "a".repeat(120) + ".d.ts";
    const rec = `path=${longName}\n`;
    const record = `${(rec.length + String(rec.length).length + 1)} ${rec}`;
    // recompute self-referential length
    let recStr = "";
    let len = rec.length + 3;
    for (;;) {
      recStr = `${len} ${rec}`;
      if (recStr.length === len) break;
      len = recStr.length;
    }
    const paxData = new TextEncoder().encode(recStr);
    const tar = buildTar([
      { name: "shortname", type: "x", data: paxData },
      { name: "shortname", data: data("export const a=1;") },
    ]);
    const r = parseTarEntries(tar);
    expect(r.entries.length).toBe(1);
    expect(r.entries[0]!.name).toBe(longName);
  });
  test("a PAX size override governs data-block advancement (next entry not misparsed)", () => {
    // the PAX'd entry has ustar size 0 but a PAX size of 600 (2 data blocks); the FOLLOWING
    // entry must still be located correctly.
    const content = "z".repeat(600);
    let recStr = "";
    const rec = `size=600\n`;
    let len = rec.length + 3;
    for (;;) {
      recStr = `${len} ${rec}`;
      if (recStr.length === len) break;
      len = recStr.length;
    }
    const paxData = new TextEncoder().encode(recStr);
    const tar = buildTar([
      { name: "package/big.js", type: "x", data: paxData }, // PAX header
      { name: "package/big.js", type: "0", size: 600, data: data(content) }, // ustar header says 600 here; real npm PAX'd entries often say 0, but either way advancement uses the effective size
      { name: "package/after.d.ts", data: data("export const after=1;") },
    ]);
    const r = parseTarEntries(tar);
    expect(r.ok).toBe(true);
    expect(r.entries.map((e) => e.name)).toContain("package/after.d.ts");
  });
  test("an invalid PAX size override fails closed", () => {
    const rec = `size=-5\n`;
    const recStr = `${rec.length + 3} ${rec}`;
    const tar = buildTar([
      { name: "x", type: "x", data: new TextEncoder().encode(recStr) },
      { name: "package/y", data: data("y") },
    ]);
    expect(parseTarEntries(tar).ok).toBe(false);
  });
  test("a GNU longname header overrides the following entry name", () => {
    const longName = "package/" + "b".repeat(150) + ".js";
    const tar = buildTar([
      { name: "././@LongLink", type: "L", data: data(longName + "\0") },
      { name: "shortname", data: data("x") },
    ]);
    const r = parseTarEntries(tar);
    expect(r.entries[0]!.name).toBe(longName);
  });
  // Build a byte-accurate PAX extended-header body from raw record STRINGS ("key=value"), each
  // framed with the self-referential "<len> <record>\n" where <len> counts BYTES.
  const paxBody = (records: string[]): Uint8Array => {
    const enc = new TextEncoder();
    const frames: Uint8Array[] = [];
    for (const kv of records) {
      const rec = `${kv}\n`;
      const recBytes = enc.encode(rec).length;
      let len = recBytes + 2;
      let s = "";
      for (;;) {
        s = `${len} ${rec}`;
        const b = enc.encode(s).length;
        if (b === len) break;
        len = b;
      }
      frames.push(enc.encode(s));
    }
    const total = frames.reduce((n, f) => n + f.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const f of frames) { out.set(f, off); off += f.length; }
    return out;
  };
  test("a MULTIBYTE PAX record before a path override does not desync the parser (byte-counted LEN)", () => {
    // `comment=é` is 2 bytes for é: a code-unit-indexed parser would skip the following path=
    // override and MISS the traversal; a byte-correct parser applies it, and validateEntries rejects it.
    const body = paxBody(["comment=é", "path=../evil"]);
    const tar = buildTar([
      { name: "package/safe", type: "x", data: body },
      { name: "package/safe", type: "0", data: data("x") },
    ]);
    const parsed = parseTarEntries(tar);
    expect(parsed.entries.map((e) => e.name)).toContain("../evil"); // override applied, not skipped
    expect(validateEntries(parsed.entries).ok).toBe(false); // and the traversal is rejected
  });
  test("a NON-DECIMAL PAX size (0x10 / 1e2) fails closed (matches C tar's base-10 parse)", () => {
    for (const bad of ["size=0x10", "size=1e2", "size=0o20", "size= 16"]) {
      const tar = buildTar([
        { name: "package/f", type: "x", data: paxBody([bad]) },
        { name: "package/f", type: "0", data: data("x") },
        { name: "package/evil", type: "2" }, // a symlink hiding in a data block if size over-advances
      ]);
      expect(parseTarEntries(tar).ok).toBe(false); // fail-closed rather than diverge from the extractor
    }
  });
  // Build a raw 12-byte size field from explicit bytes (to inject embedded separators).
  const rawSizeField = (bytes: readonly number[]): Uint8Array => {
    const a = new Uint8Array(12);
    a.set(bytes.slice(0, 12));
    return a;
  };
  // A file header whose 12-byte size field is set from raw bytes (checksum is not validated).
  const fileHeaderRawSize = (name: string, sizeBytes: readonly number[]): Uint8Array => {
    const h = header({ name, type: "0" });
    h.set(rawSizeField(sizeBytes), 124);
    return h;
  };
  const dig = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
  const concatBlocks = (arrs: Uint8Array[]): Uint8Array => {
    const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
    let off = 0;
    for (const a of arrs) { out.set(a, off); off += a.length; }
    return out;
  };
  const padData = (bytes: Uint8Array): Uint8Array => {
    const padded = new Uint8Array(Math.ceil(bytes.length / BLOCK) * BLOCK);
    padded.set(bytes);
    return padded;
  };
  test("an EMBEDDED space/NUL in the size field fails closed (tar terminates at the separator)", () => {
    // `1000`<sep>`0000`: the old parser read octal 10000000 (over-declares 2MB), over-advancing
    // past — and hiding — the trailing symlink header. tar reads only `1000`=512 and extracts it.
    for (const [label, sizeBytes] of [
      ["embedded space", [...dig("1000"), 0x20, ...dig("0000"), 0]],
      ["embedded NUL", [...dig("1000"), 0, ...dig("7777"), 0]],
    ] as const) {
      const tar = concatBlocks([
        header({ name: "package/", type: "5" }),
        fileHeaderRawSize("package/realfile", sizeBytes),
        new Uint8Array(BLOCK), // one real data block
        header({ name: "package/evil", type: "2" }), // the symlink an over-advance would hide
        new Uint8Array(BLOCK), new Uint8Array(BLOCK),
      ]);
      expect(parseTarEntries(tar).ok, label).toBe(false); // fail-closed on an over-declared size
    }
  });
  test("a LEGITIMATE space/NUL-terminated size field still parses correctly", () => {
    for (const pad of [0x20, 0]) {
      const bytes = [...dig("600"), pad, pad, pad, pad, pad, pad, pad, pad, pad]; // octal 600 = 384
      const tar = concatBlocks([fileHeaderRawSize("package/f", bytes), new Uint8Array(BLOCK), new Uint8Array(BLOCK), new Uint8Array(BLOCK)]);
      const r = parseTarEntries(tar);
      expect(r.ok).toBe(true);
      expect(r.entries[0]!.size).toBe(384);
    }
  });
  const globalPaxHeader = (records: string[]): Uint8Array => {
    const body = paxBody(records);
    return concatBlocks([header({ name: "pax_global", type: "g", size: body.length }), padData(body)]);
  };
  const perEntryPaxHeader = (records: string[]): Uint8Array => {
    const body = paxBody(records);
    return concatBlocks([header({ name: "pax_entry", type: "x", size: body.length }), padData(body)]);
  };
  test("a GLOBAL PAX ('g') header applies NO path override to the next entry (fail-closed)", () => {
    // global path=package/safe must NOT mask a following '../evil' traversal header
    const tar = concatBlocks([
      globalPaxHeader(["path=package/safe"]),
      header({ name: "../evil", type: "0", data: data("x") }), padData(data("x")),
      new Uint8Array(BLOCK), new Uint8Array(BLOCK),
    ]);
    const parsed = parseTarEntries(tar);
    expect(parsed.entries.map((e) => e.name)).toContain("../evil"); // raw name seen, not masked
    expect(validateEntries(parsed.entries).ok).toBe(false); // traversal rejected
  });
  test("a GLOBAL PAX ('g') size does NOT over-advance past a following symlink", () => {
    const tar = concatBlocks([
      globalPaxHeader(["size=512"]),
      header({ name: "package/f", type: "0" }), // ustar size 0
      header({ name: "package/evil", type: "2" }), // symlink a global size=512 would skip past
      new Uint8Array(BLOCK), new Uint8Array(BLOCK),
    ]);
    expect(validateEntries(parseTarEntries(tar).entries).ok).toBe(false); // symlink seen + rejected
  });
  test("a GNU.sparse.name PAX record fails the archive closed (bsdtar honors it as the real path)", () => {
    // bsdtar treats GNU.sparse.name=../evil as the effective member path → traversal; parsePax
    // only reads `path`, so instead of silently validating the safe raw name we reject outright.
    const tar = concatBlocks([
      perEntryPaxHeader(["GNU.sparse.name=../evil"]),
      header({ name: "package/safe", type: "0", data: data("x") }), padData(data("x")),
      new Uint8Array(BLOCK), new Uint8Array(BLOCK),
    ]);
    expect(parseTarEntries(tar).ok).toBe(false);
  });
  test("a type-'0' entry whose NAME ENDS IN '/' does NOT over-advance past a following symlink", () => {
    // bsdtar coerces `package/sub/` (type 0) to a zero-length dir and ignores its size; if tarScan
    // advanced by the bogus size it would skip — and hide — the planted symlink header.
    const sub = header({ name: "package/sub/", type: "0", size: 512 }); // bogus 512-byte "data"
    const tar = concatBlocks([
      header({ name: "package/", type: "5" }),
      sub,
      header({ name: "package/evil", type: "2" }), // symlink hidden in the "skipped" block
      new Uint8Array(BLOCK), new Uint8Array(BLOCK),
    ]);
    const parsed = parseTarEntries(tar);
    expect(parsed.entries.map((e) => e.name)).toContain("package/evil"); // symlink is SEEN
    expect(validateEntries(parsed.entries).ok).toBe(false); // and rejected
  });
  test("a stale GNU longname that lost to a PAX path override does not leak to a later entry", () => {
    const tar = buildTar([
      { name: "././@LongLink", type: "L", data: data("package/gnu-name.js\0") },
      { name: "shortA", type: "x", data: paxBody(["path=package/pax-name.js"]) },
      { name: "shortA", type: "0", data: data("a") }, // PAX path wins here; GNU name must be discarded
      { name: "package/second.js", type: "0", data: data("b") }, // must NOT inherit the GNU name
    ]);
    const names = parseTarEntries(tar).entries.map((e) => e.name);
    expect(names).toEqual(["package/pax-name.js", "package/second.js"]);
  });
});

describe("parseTarEntries — decompression-bomb caps", () => {
  test("rejects a member whose declared size exceeds the total cap", () => {
    const tar = buildTar([{ name: "package/huge", size: 200 * 1024 * 1024, data: data("x") }]);
    const r = parseTarEntries(tar);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("uncompressed size");
  });
  test("rejects a base-256 (non-octal) size field fail-closed", () => {
    const tar = buildTar([{ name: "package/x", data: data("x") }]);
    tar[124] = 0x80; // set the base-256 high bit in the size field
    expect(parseTarEntries(tar).ok).toBe(false);
  });
});

describe("scanTarball — gunzip integration", () => {
  test("gunzips, parses, validates a clean tarball", () => {
    const tar = buildTar([
      { name: "package/", type: "5" },
      { name: "package/package.json", data: data(`{"name":"x"}`) },
    ]);
    const gz = gzipSync(tar);
    const r = scanTarball(gz, (b) => gunzipSync(b));
    expect(r.ok).toBe(true);
    expect(r.entries.map((e) => e.name)).toContain("package/package.json");
  });
  test("a malformed gzip fails closed", () => {
    const r = scanTarball(new Uint8Array([1, 2, 3, 4]), (b) => gunzipSync(b));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("gunzip failed");
  });
  test("a symlink in a gzipped tarball is rejected", () => {
    const tar = buildTar([{ name: "package/evil", type: "2" }]);
    const r = scanTarball(gzipSync(tar), (b) => gunzipSync(b));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("disallowed member type");
  });
});

// exhaustiveness / type sanity
const _typecheck: TarEntry = { name: "x", size: 0, typeflag: "0" };
