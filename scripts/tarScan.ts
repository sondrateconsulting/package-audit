// tarScan.ts — pure PRE-EXTRACTION validation of a registry .tgz (§5.E). Registry tarballs are
// untrusted third-party input, so BEFORE handing the archive to system `tar` we gunzip it and
// parse the tar HEADERS in TypeScript (which `tar -tzf` cannot show: link type, size, PAX
// overrides) and REJECT the archive if any member is an absolute path, contains a `..`
// component, or is a symlink/hardlink/device/fifo, or if cumulative uncompressed size or entry
// count exceeds a decompression-bomb cap. Handles ustar, PAX (`x`/`g`) path/size overrides, and
// GNU long-name (`L`) headers; unknown/dangerous typeflags are rejected fail-closed.

const BLOCK = 512;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024; // 100 MB uncompressed cap
const MAX_ENTRIES = 20_000;

export interface TarEntry {
  name: string;
  size: number;
  typeflag: string; // '0'/'' = file, '5' = dir, '2' = symlink, '1' = hardlink, '3'/'4' = device, '6' = fifo
}

export interface ScanResult {
  ok: boolean;
  reason: string | null; // populated when ok === false
  entries: TarEntry[]; // regular file/dir entries (validated when ok)
  totalBytes: number;
}

const fail = (reason: string, entries: TarEntry[], totalBytes: number): ScanResult => ({ ok: false, reason, entries, totalBytes });

function roundUp(n: number): number {
  return Math.ceil(n / BLOCK) * BLOCK;
}

function readCString(buf: Uint8Array, offset: number, length: number): string {
  let end = offset;
  const limit = offset + length;
  while (end < limit && buf[end] !== 0) end++;
  return new TextDecoder("utf-8", { fatal: false }).decode(buf.subarray(offset, end));
}

// Parse a tar `size`/octal field (may be space/null padded; base-256 GNU extension for huge
// sizes is rejected by returning NaN so the caller fails closed).
function parseOctal(buf: Uint8Array, offset: number, length: number): number {
  const end = offset + length;
  let i = offset;
  while (i < end && (buf[i] === 0x20 || buf[i] === 0)) i++; // skip LEADING space/NUL padding
  let s = "";
  for (; i < end; i++) {
    const c = buf[i]!;
    // CRITICAL: a space/NUL TERMINATES the field (matches libarchive tar_atol8 / GNU from_oct).
    // The old code SKIPPED embedded separators and concatenated digits across them, reading a
    // value LARGER than the real extractor — letting a crafted `1000<sp>0000` size over-advance
    // the walk past (and hide) a following symlink header that system tar still extracts.
    if (c === 0x20 || c === 0) break;
    if (c < 0x30 || c > 0x37) return NaN; // not an octal digit (e.g. base-256 high bit) → reject
    s += String.fromCharCode(c);
  }
  // Everything after the terminator MUST be pure space/NUL padding; trailing digits are malformed
  // (and are exactly the over-declaration vector), so fail closed rather than diverge from tar.
  for (; i < end; i++) if (buf[i] !== 0x20 && buf[i] !== 0) return NaN;
  return s === "" ? 0 : parseInt(s, 8);
}

function isZeroBlock(buf: Uint8Array, offset: number): boolean {
  for (let i = offset; i < offset + BLOCK; i++) if (buf[i] !== 0) return false;
  return true;
}

// Parse PAX extended-header records ("LEN KEY=VALUE\n") for the path/size overrides. Operates on
// RAW BYTES: the PAX LEN field counts BYTES (POSIX), so decoding to a JS string first and indexing
// by UTF-16 code units DESYNCS on any multibyte record and can skip a later `path=` override that
// system tar still honors (a traversal bypass). The `size` VALUE is parsed with STRICT base-10
// semantics matching C tar's strtoumax(…,10): a non-decimal value (`0x10`, `1e2`) yields NaN so
// the caller fails closed rather than over-advancing past — and hiding — the next header.
function parsePax(data: Uint8Array): { path?: string; size?: number; sparse?: boolean } {
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const out: { path?: string; size?: number; sparse?: boolean } = {};
  let i = 0;
  while (i < data.length) {
    // LEN = ASCII decimal digits terminated by ONE space, counting the WHOLE record's bytes.
    let sp = i;
    while (sp < data.length && data[sp] !== 0x20) sp++;
    if (sp >= data.length || sp === i) break;
    let len = 0;
    let lenOk = true;
    for (let d = i; d < sp; d++) {
      const c = data[d]!;
      if (c < 0x30 || c > 0x39) { lenOk = false; break; }
      len = len * 10 + (c - 0x30);
    }
    if (!lenOk || len <= 0 || i + len > data.length) break;
    const recEnd = i + len - 1; // the record's trailing '\n' sits at i+len-1
    if (recEnd > sp) {
      const record = data.subarray(sp + 1, recEnd); // KEY=VALUE (newline dropped)
      let eq = 0;
      while (eq < record.length && record[eq] !== 0x3d) eq++;
      if (eq < record.length) {
        const key = decoder.decode(record.subarray(0, eq));
        const value = decoder.decode(record.subarray(eq + 1));
        if (key === "path") out.path = value;
        else if (key === "size") out.size = /^\d+$/.test(value) ? Number(value) : NaN; // NaN → fail-closed
        // GNU sparse extended headers (`GNU.sparse.name` is the REAL member path libarchive honors,
        // `GNU.sparse.map`/`realsize`/`major`/… reshape the data layout). npm tarballs are never
        // sparse, and replicating libarchive's sparse handling exactly is error-prone, so ANY
        // GNU.sparse.* record fails the archive closed — otherwise a `GNU.sparse.name=../evil`
        // masks a traversal name the extractor still applies, or a sparse map desyncs advancement.
        else if (key.startsWith("GNU.sparse.")) out.sparse = true;
      }
    }
    i += len;
  }
  return out;
}

// Parse tar bytes into entries, applying PAX/GNU overrides and enforcing the caps.
export function parseTarEntries(tar: Uint8Array): ScanResult {
  const entries: TarEntry[] = [];
  let totalBytes = 0;
  let offset = 0;
  let pendingPaxPath: string | null = null;
  let pendingPaxSize: number | null = null;
  let pendingGnuName: string | null = null;

  while (offset + BLOCK <= tar.length) {
    if (isZeroBlock(tar, offset)) break; // end-of-archive marker
    const name0 = readCString(tar, offset, 100);
    const prefix = readCString(tar, offset + 345, 155);
    const headerSize = parseOctal(tar, offset + 124, 12);
    if (Number.isNaN(headerSize) || headerSize < 0) return fail("unparseable/oversized entry size", entries, totalBytes);
    const typeCode = tar[offset + 156]!;
    const typeflag = typeCode === 0 ? "0" : String.fromCharCode(typeCode);

    // Meta headers (PAX x/g, GNU L/K) carry their OWN data sized by the header size field.
    // ONLY the per-entry PAX header ('x') applies its path/size to the NEXT entry. A GLOBAL PAX
    // header ('g') sets archive-wide defaults, and extractors DISAGREE on whether a global path/
    // size overrides an individual entry — applying it here would DIVERGE from the extractor
    // (masking a traversal name, or hiding a following symlink by over-advancing). So 'g' is
    // parsed-and-skipped WITHOUT setting any override: tarScan then sees each entry's RAW header,
    // and validateEntries rejects any unsafe member fail-closed.
    if (typeflag === "x") {
      const pax = parsePax(tar.subarray(offset + BLOCK, offset + BLOCK + headerSize));
      if (pax.sparse === true) return fail("GNU sparse member unsupported (fail-closed)", entries, totalBytes);
      if (pax.path !== undefined) pendingPaxPath = pax.path;
      if (pax.size !== undefined) {
        if (!Number.isSafeInteger(pax.size) || pax.size < 0) return fail("invalid PAX size override", entries, totalBytes);
        pendingPaxSize = pax.size;
      }
      offset += BLOCK + roundUp(headerSize);
      continue;
    }
    if (typeflag === "g") {
      offset += BLOCK + roundUp(headerSize); // global header: skip, apply nothing (fail-closed)
      continue;
    }
    if (typeflag === "L") {
      pendingGnuName = readCString(tar.subarray(offset + BLOCK, offset + BLOCK + headerSize), 0, headerSize);
      offset += BLOCK + roundUp(headerSize);
      continue;
    }
    if (typeflag === "K") {
      // GNU long LINK name — only precedes a link entry (which we reject by typeflag anyway)
      offset += BLOCK + roundUp(headerSize);
      continue;
    }

    let name = prefix !== "" ? `${prefix}/${name0}` : name0;
    // A PAX `size` override replaces the ustar header size (which is 0 for a PAX'd entry) and
    // MUST govern data-block advancement too, or every subsequent entry is misparsed.
    let effectiveSize = headerSize;
    if (pendingPaxPath !== null) name = pendingPaxPath;
    else if (pendingGnuName !== null) name = pendingGnuName;
    // BOTH pending names are consumed (or discarded) at THIS entry — clear both so a stale GNU
    // longname that lost to a PAX path override never leaks onto a later entry.
    pendingPaxPath = null;
    pendingGnuName = null;
    if (pendingPaxSize !== null) { effectiveSize = pendingPaxSize; pendingPaxSize = null; }

    entries.push({ name, size: effectiveSize, typeflag });
    if (entries.length > MAX_ENTRIES) return fail(`entry count exceeds ${MAX_ENTRIES}`, entries, totalBytes);
    // CRITICAL: only REGULAR files ('0'/'7' contiguous) carry data blocks. Real tar ignores the
    // size field on directories/links/devices/fifos, so advancing by size there would let a
    // bogus directory size skip the NEXT header — hiding a symlink the extractor still creates.
    // libarchive/bsdtar ALSO coerces a type-'0' entry whose (effective) NAME ENDS IN '/' into a
    // zero-length directory and ignores its size — so a `package/sub/` type-0 header with a bogus
    // size would let us over-advance past a planted symlink header the extractor still parses.
    // Use the effective (PAX/GNU-resolved) name so a PAX-supplied trailing slash is covered too.
    const carriesData = (typeflag === "0" || typeflag === "7") && !name.endsWith("/");
    const dataBytes = carriesData ? effectiveSize : 0;
    if (carriesData) {
      totalBytes += effectiveSize;
      if (totalBytes > MAX_TOTAL_BYTES) return fail(`uncompressed size exceeds ${MAX_TOTAL_BYTES} bytes`, entries, totalBytes);
    }
    offset += BLOCK + roundUp(dataBytes);
  }
  return { ok: true, reason: null, entries, totalBytes };
}

// Validate the parsed entries against the §5.E safety rules. npm tarballs legitimately contain
// only regular files and directories under a `package/` root — anything else is rejected.
export function validateEntries(entries: TarEntry[]): { ok: boolean; reason: string | null } {
  for (const e of entries) {
    if (e.typeflag !== "0" && e.typeflag !== "5")
      return { ok: false, reason: `disallowed member type '${e.typeflag}' (${e.name})` }; // link/device/fifo/...
    if (e.name.startsWith("/") || e.name.startsWith("\\") || /^[A-Za-z]:/.test(e.name))
      return { ok: false, reason: `absolute path member ${e.name}` };
    // split on BOTH separators so a backslash `..` component is caught on any platform's tar
    const parts = e.name.split(/[/\\]/);
    if (parts.some((p) => p === ".."))
      return { ok: false, reason: `path traversal member ${e.name}` };
  }
  return { ok: true, reason: null };
}

// Full pre-scan: gunzip the .tgz, parse headers, enforce caps, then validate members. `gunzip`
// is injected so the parser stays pure/testable (production passes Bun.gunzipSync).
export function scanTarball(gzBytes: Uint8Array, gunzip: (b: Uint8Array) => Uint8Array): ScanResult {
  let tar: Uint8Array;
  try {
    tar = gunzip(gzBytes);
  } catch {
    return fail("gunzip failed", [], 0);
  }
  const parsed = parseTarEntries(tar);
  if (!parsed.ok) return parsed;
  const v = validateEntries(parsed.entries);
  if (!v.ok) return { ...parsed, ok: false, reason: v.reason };
  return parsed;
}
