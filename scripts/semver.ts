// semver.ts — zero-dep semver subset for the §5.E range-resolution fallback (max-satisfying
// packument version with npm's prerelease rule) and §7's versionsSeen ordering (semver
// PRECEDENCE, then raw-string tie-break so build-metadata variants order deterministically).
// Implements node-semver's documented desugarings for x-ranges, tilde, caret, hyphen ranges,
// || alternatives, and AND-space comparator sets. Parsers return null on anything they do not
// understand (fail-closed: a non-range like `latest`, a URL, or a protocol spec never matches).

export interface Semver {
  major: number;
  minor: number;
  patch: number;
  // Prerelease identifiers are kept as EXACT strings (never Number-converted) so a large
  // numeric identifier beyond 2^53 keeps full precision; numeric-ness is decided at compare
  // time. The grammar forbids leading zeros, so digit strings compare numerically via
  // (length, then lexicographic).
  prerelease: string[];
  build: string[];
  raw: string;
}

const isNumericId = (s: string): boolean => /^[0-9]+$/.test(s);

const SEMVER_RE =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

// A core numeric identifier (major/minor/patch) as a safe integer, or null when it exceeds
// Number.MAX_SAFE_INTEGER (node-semver rejects such versions rather than silently rounding).
function coreNum(digits: string): number | null {
  const n = Number(digits);
  return Number.isSafeInteger(n) ? n : null;
}

export function parseSemver(input: string): Semver | null {
  const m = SEMVER_RE.exec(input.trim());
  if (!m) return null;
  const major = coreNum(m[1]!);
  const minor = coreNum(m[2]!);
  const patch = coreNum(m[3]!);
  if (major === null || minor === null || patch === null) return null; // core beyond 2^53-1
  const prerelease = (m[4] ?? "").split(".").filter((s) => s !== "");
  return {
    major,
    minor,
    patch,
    prerelease,
    build: (m[5] ?? "").split(".").filter((s) => s !== ""),
    raw: input.trim(),
  };
}

// Semver PRECEDENCE (spec §11): numeric core, then prerelease (a version WITH a prerelease
// sorts LOWER than the same core without one; numeric identifiers < alphanumeric; longer
// prerelease wins a shared prefix). Build metadata is ignored.
export function compareSemver(a: Semver, b: Semver): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1; // release > prerelease
  if (b.prerelease.length === 0) return -1;
  const len = Math.min(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < len; i++) {
    const x = a.prerelease[i]!;
    const y = b.prerelease[i]!;
    if (x === y) continue;
    const xNum = isNumericId(x);
    const yNum = isNumericId(y);
    if (xNum && yNum) {
      // exact numeric compare with NO precision loss: no-leading-zero digit strings order by
      // length, then lexicographically (so 9007199254740993 > 9007199254740992 correctly).
      if (x.length !== y.length) return x.length < y.length ? -1 : 1;
      return x < y ? -1 : 1;
    }
    if (xNum) return -1; // numeric identifiers sort before alphanumeric
    if (yNum) return 1;
    return x < y ? -1 : 1;
  }
  if (a.prerelease.length === b.prerelease.length) return 0;
  return a.prerelease.length < b.prerelease.length ? -1 : 1;
}

// §7's total ordering for versionsSeen: precedence, then raw STRING lexicographic tie-break
// (build-metadata variants compare semver-equal but must still order deterministically).
export function compareForReport(aRaw: string, bRaw: string): number {
  const a = parseSemver(aRaw);
  const b = parseSemver(bRaw);
  if (a !== null && b !== null) {
    const c = compareSemver(a, b);
    if (c !== 0) return c;
  }
  return aRaw < bRaw ? -1 : aRaw > bRaw ? 1 : 0;
}

// ---- ranges ---------------------------------------------------------------------------------
type Op = ">" | ">=" | "<" | "<=" | "=";
interface Comparator {
  op: Op;
  version: Semver; // fully concrete after desugaring
}
type ComparatorSet = Comparator[]; // AND
export type Range = ComparatorSet[]; // OR of sets

interface Partial {
  major: number | null; // null = x/X/*/absent
  minor: number | null;
  patch: number | null;
  prerelease: string;
  build: string;
}

const PARTIAL_RE =
  /^v?(x|X|\*|0|[1-9]\d*)(?:\.(x|X|\*|0|[1-9]\d*))?(?:\.(x|X|\*|0|[1-9]\d*))?(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

function parsePartial(token: string): Partial | null {
  const m = PARTIAL_RE.exec(token);
  if (!m) return null;
  const isWild = (s: string | undefined): boolean => s === undefined || s === "x" || s === "X" || s === "*";
  // reject the whole partial if a CONCRETE core segment exceeds 2^53-1 (node-semver invalidates it)
  for (const s of [m[1], m[2], m[3]]) if (!isWild(s) && !Number.isSafeInteger(Number(s))) return null;
  const num = (s: string | undefined): number | null => (isWild(s) ? null : Number(s));
  const major = num(m[1]);
  const minor = num(m[2]);
  const patch = num(m[3]);
  // an x higher up forces x below (1.x.3 is not a thing) — treat as x for the rest
  return {
    major,
    minor: major === null ? null : minor,
    patch: major === null || minor === null ? null : patch,
    prerelease: m[4] ?? "",
    build: m[5] ?? "",
  };
}

function mk(major: number, minor: number, patch: number, prerelease = ""): Semver {
  const raw = `${major}.${minor}.${patch}${prerelease === "" ? "" : `-${prerelease}`}`;
  return parseSemver(raw)!;
}

// NOTE: no `-0` here — a prerelease-bearing ANY comparator would let 0.0.0-alpha satisfy `*`
// via the same-tuple prerelease rule, which npm rejects.
const ANY: ComparatorSet = [{ op: ">=", version: mk(0, 0, 0) }];

// Desugar one range token (possibly operator-prefixed) into comparators, per node-semver.
function desugarToken(op: string, p: Partial): ComparatorSet | null {
  const { major, minor, patch, prerelease } = p;
  const lowest = (): Semver => mk(major ?? 0, minor ?? 0, patch ?? 0, prerelease);
  if (op === "~") {
    if (major === null) return ANY;
    if (minor === null) return [{ op: ">=", version: mk(major, 0, 0) }, { op: "<", version: mk(major + 1, 0, 0, "0") }];
    return [{ op: ">=", version: lowest() }, { op: "<", version: mk(major, minor + 1, 0, "0") }];
  }
  if (op === "^") {
    if (major === null) return ANY;
    if (minor === null) return [{ op: ">=", version: mk(major, 0, 0) }, { op: "<", version: mk(major + 1, 0, 0, "0") }];
    if (patch === null) {
      if (major === 0) return [{ op: ">=", version: mk(0, minor, 0) }, { op: "<", version: mk(0, minor + 1, 0, "0") }];
      return [{ op: ">=", version: mk(major, minor, 0) }, { op: "<", version: mk(major + 1, 0, 0, "0") }];
    }
    if (major !== 0) return [{ op: ">=", version: lowest() }, { op: "<", version: mk(major + 1, 0, 0, "0") }];
    if (minor !== 0) return [{ op: ">=", version: lowest() }, { op: "<", version: mk(0, minor + 1, 0, "0") }];
    return [{ op: ">=", version: lowest() }, { op: "<", version: mk(0, 0, patch + 1, "0") }];
  }
  if (op === "" || op === "=") {
    if (major === null) return ANY;
    if (minor === null) return [{ op: ">=", version: mk(major, 0, 0) }, { op: "<", version: mk(major + 1, 0, 0, "0") }];
    if (patch === null) return [{ op: ">=", version: mk(major, minor, 0) }, { op: "<", version: mk(major, minor + 1, 0, "0") }];
    return [{ op: "=", version: lowest() }];
  }
  // bare inequality comparators over partials (node-semver replaceXRanges semantics).
  // The `>` partial LOWER bounds are STABLE (no `-0`): node-semver desugars `>1` → `>=2.0.0`
  // and `>1.2` → `>=1.3.0`, so a prerelease like 2.0.0-alpha does NOT satisfy `>1`.
  if (op === ">") {
    if (major === null) return [{ op: "<", version: mk(0, 0, 0, "0") }]; // >* matches nothing
    if (minor === null) return [{ op: ">=", version: mk(major + 1, 0, 0) }];
    if (patch === null) return [{ op: ">=", version: mk(major, minor + 1, 0) }];
    return [{ op: ">", version: lowest() }];
  }
  if (op === "<") {
    if (major === null) return [{ op: "<", version: mk(0, 0, 0, "0") }]; // <* matches nothing
    if (minor === null) return [{ op: "<", version: mk(major, 0, 0, "0") }];
    if (patch === null) return [{ op: "<", version: mk(major, minor, 0, "0") }];
    return [{ op: "<", version: lowest() }];
  }
  if (op === ">=") {
    if (major === null) return ANY;
    return [{ op: ">=", version: lowest() }];
  }
  if (op === "<=") {
    if (major === null) return ANY;
    if (minor === null) return [{ op: "<", version: mk(major + 1, 0, 0, "0") }];
    if (patch === null) return [{ op: "<", version: mk(major, minor + 1, 0, "0") }];
    return [{ op: "<=", version: lowest() }];
  }
  return null;
}

// Hyphen range: `A - B` (whitespace-delimited hyphen). Lower partial fills zeros (>=);
// upper partial becomes an exclusive next-boundary (<); full upper is inclusive (<=).
function desugarHyphen(lowTok: string, highTok: string): ComparatorSet | null {
  const low = parsePartial(lowTok);
  const high = parsePartial(highTok);
  if (low === null || high === null) return null;
  const set: ComparatorSet = [];
  if (low.major !== null)
    set.push({ op: ">=", version: mk(low.major, low.minor ?? 0, low.patch ?? 0, low.prerelease) });
  if (high.major === null) {
    // `1.2.3 - *` → no upper bound
  } else if (high.minor === null) {
    set.push({ op: "<", version: mk(high.major + 1, 0, 0, "0") });
  } else if (high.patch === null) {
    set.push({ op: "<", version: mk(high.major, high.minor + 1, 0, "0") });
  } else {
    set.push({ op: "<=", version: mk(high.major, high.minor, high.patch, high.prerelease) });
  }
  return set.length === 0 ? ANY : set;
}

const COMPARATOR_TOKEN_RE = /^(>=|<=|>|<|=|~|\^)?\s*(\S+)$/;

// Parse a full range. Returns null when ANY portion is unparseable (fail closed — the §5.E
// fallback must never guess a version from `latest`, a git URL, or a protocol spec).
export function parseRange(range: string): Range | null {
  const trimmed = range.trim();
  const alternatives = trimmed === "" ? [""] : trimmed.split("||");
  const out: Range = [];
  for (const alt of alternatives) {
    const text = alt.trim();
    if (text === "" || text === "*" || text.toLowerCase() === "x") {
      out.push(ANY);
      continue;
    }
    // hyphen ranges first: ` - ` is a set-level separator
    const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(text);
    if (hyphen) {
      const set = desugarHyphen(hyphen[1]!, hyphen[2]!);
      if (set === null) return null;
      out.push(set);
      continue;
    }
    // normalize `op   version` spacing so ">= 1.2.3" tokenizes as one comparator
    const compact = text.replace(/(>=|<=|>|<|=|~|\^)\s+/g, "$1");
    const set: ComparatorSet = [];
    for (const token of compact.split(/\s+/)) {
      const m = COMPARATOR_TOKEN_RE.exec(token);
      if (!m) return null;
      const partial = parsePartial(m[2]!);
      if (partial === null) return null;
      const comparators = desugarToken(m[1] ?? "", partial);
      if (comparators === null) return null;
      set.push(...comparators);
    }
    if (set.length === 0) return null;
    out.push(set);
  }
  return out;
}

function cmp(op: Op, a: Semver, b: Semver): boolean {
  const c = compareSemver(a, b);
  switch (op) {
    case ">": return c > 0;
    case ">=": return c >= 0;
    case "<": return c < 0;
    case "<=": return c <= 0;
    case "=": return c === 0;
  }
}

// npm's prerelease rule: a version WITH a prerelease satisfies a set only if some comparator
// in that set carries a prerelease on the SAME [major, minor, patch] tuple. (The synthetic
// `-0` bounds introduced by desugaring intentionally participate — matching node-semver.)
function setSatisfies(v: Semver, set: ComparatorSet): boolean {
  for (const c of set) if (!cmp(c.op, v, c.version)) return false;
  if (v.prerelease.length > 0) {
    return set.some(
      (c) =>
        c.version.prerelease.length > 0 &&
        c.version.major === v.major &&
        c.version.minor === v.minor &&
        c.version.patch === v.patch,
    );
  }
  return true;
}

export function satisfies(version: string, range: string): boolean {
  const v = parseSemver(version);
  if (v === null) return false;
  const r = parseRange(range);
  if (r === null) return false;
  return r.some((set) => setSatisfies(v, set));
}

// §5.E fallback: the MAX-satisfying version among the packument's published versions.
// Prereleases are excluded unless the range explicitly names one (enforced by the prerelease
// rule inside satisfies). Ties in precedence (build-metadata variants) break on the raw
// string so the pick is deterministic.
export function maxSatisfying(versions: string[], range: string): string | null {
  let best: string | null = null;
  let bestParsed: Semver | null = null;
  for (const raw of versions) {
    if (!satisfies(raw, range)) continue;
    const parsed = parseSemver(raw)!;
    if (
      bestParsed === null ||
      compareSemver(parsed, bestParsed) > 0 ||
      (compareSemver(parsed, bestParsed) === 0 && raw > (best ?? ""))
    ) {
      best = raw;
      bestParsed = parsed;
    }
  }
  return best;
}
