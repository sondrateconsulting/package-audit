// permalink.ts — the SINGLE pure builder for commit-pinned GitHub permalinks (§5.D). Every
// finding writer (manifest, lockfile, API-usage, CLI-usage) calls this so the URL shape can
// never drift. Output is byte-reproducible from its inputs alone: no dates, no env, no OS
// path APIs (which vary by platform / cwd) — only fixed string rules.

export type LineSpan = number | readonly [startLine: number, endLine: number];

export interface PermalinkInput {
  githubHost: string; // "github.com" or a GHES host "git.example.com" (optionally host:port)
  org: string;
  repo: string;
  commitSha: string; // a commit SHA (hex) — NEVER a branch; commit-pinning avoids link rot
  path: string; // repo-relative POSIX path
  line: LineSpan; // 1-based; a single line or an inclusive [start, end] span
}

// 7–64 LOWERCASE hex: covers an abbreviated SHA up to a full SHA-256 oid. Lowercase-only
// guarantees one canonical byte form (git/gh emit lowercase), so the report stays
// byte-reproducible. A branch name (e.g. "main") is not all-hex, enforcing "commit-pinned".
const HEX_SHA = /^[0-9a-f]{7,64}$/;
// C0 control chars + DEL — never valid in a path/owner segment.
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`permalink: ${msg}`);
}

const isPositiveInt = (n: number): boolean => Number.isSafeInteger(n) && n >= 1;

// Strip an optional scheme and trailing slashes; reject structural characters. GHES hostnames
// (and host:port) need no encoding, but a stray '/', '?', '#', or whitespace would break the URL.
function normalizeHost(host: string): string {
  const stripped = host.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  assert(stripped.length > 0, "githubHost is empty");
  // A host or host:port only — NO userinfo ('@'), path, query, or fragment. `evil.com@github.com`
  // would otherwise place `evil.com` as URL userinfo and mislead about the real host.
  const m = /^([A-Za-z0-9.-]+)(?::([0-9]{1,5}))?$/.exec(stripped);
  assert(m, `githubHost is not a valid host[:port]: ${host}`);
  if (m[2] !== undefined) {
    const port = Number(m[2]);
    assert(port >= 1 && port <= 65535, `githubHost port out of range: ${host}`);
  }
  return stripped;
}

function encodeOwnerSegment(name: string, kind: string): string {
  assert(name.length > 0, `${kind} is empty`);
  assert(!name.includes("/"), `${kind} must not contain '/': ${name}`);
  assert(!CONTROL_CHARS.test(name), `${kind} has a control character`);
  return encodeURIComponent(name);
}

// URL-encode a repo-relative POSIX path PER SEGMENT, preserving the '/' separators.
function encodePath(path: string): string {
  assert(path.length > 0, "path is empty");
  assert(!path.startsWith("/"), `path must be repo-relative, not absolute: ${path}`);
  assert(!path.endsWith("/"), `path must not end with '/': ${path}`);
  assert(!path.includes("\\"), `path must use POSIX '/', not a backslash: ${path}`);
  assert(!CONTROL_CHARS.test(path), "path has a control character");
  const segments = path.split("/");
  for (const seg of segments) {
    assert(seg.length > 0, `path has an empty segment (double slash): ${path}`);
    assert(seg !== "." && seg !== "..", `path must not contain '.'/'..': ${path}`);
  }
  return segments.map((s) => encodeURIComponent(s)).join("/");
}

// A single line -> "#Ln"; an inclusive span -> "#La-Lb", collapsing a==b to "#Ln". A reversed
// span THROWS rather than silently swapping — start>end is a caller bug that would otherwise
// emit a wrong evidence range.
function anchor(line: LineSpan): string {
  if (typeof line === "number") {
    assert(isPositiveInt(line), `line must be a positive integer: ${line}`);
    return `#L${line}`;
  }
  const [start, end] = line;
  assert(isPositiveInt(start) && isPositiveInt(end), `line span must be positive integers: [${start}, ${end}]`);
  assert(start <= end, `line span start must be <= end: [${start}, ${end}]`);
  return start === end ? `#L${start}` : `#L${start}-L${end}`;
}

export function buildPermalink(input: PermalinkInput): string {
  const host = normalizeHost(input.githubHost);
  const org = encodeOwnerSegment(input.org, "org");
  const repo = encodeOwnerSegment(input.repo, "repo");
  assert(HEX_SHA.test(input.commitSha), `commitSha must be a hex SHA (never a branch): ${input.commitSha}`);
  const path = encodePath(input.path);
  return `https://${host}/${org}/${repo}/blob/${input.commitSha}/${path}${anchor(input.line)}`;
}
