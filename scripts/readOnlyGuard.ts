// readOnlyGuard.ts — the SINGLE argv-array allowlist chokepoint that gates every
// gh/git/tar spawn for this READ-ONLY auditor (§0, §6). It matches on the argv
// ARRAY, never a joined string, so a repo named `create-x` cannot false-positive and
// `gh api -X DELETE` cannot slip through substring matching. Every guard THROWS a
// ReadOnlyViolation on anything outside its read-only allowlist.

import { lstatSync, readlinkSync } from "node:fs";
import { isAbsolute, sep } from "node:path";

export class ReadOnlyViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReadOnlyViolation";
  }
}
const deny = (msg: string): never => {
  throw new ReadOnlyViolation(`READ-ONLY VIOLATION: ${msg}`);
};

// Package managers are NEVER spawned (§0) — their binaries are hard-denied. `corepack`
// shims yarn/pnpm, so it is denied too.
export const PM_DENYLIST = new Set(["npm", "npx", "yarn", "pnpm", "bunx", "corepack"]);
// `bun` is allowed ONLY to run this tool's OWN scripts (§0) — enforced by an allowlist
// below (a subcommand denylist would let `bun run evil.ts` through).
const OWN_SCRIPT = /^scripts\/[A-Za-z0-9_.-]+\.ts$/;

// ---- gh -----------------------------------------------------------------------------
const BODY_FLAGS = new Set(["-f", "-F", "--field", "--raw-field", "--input"]);
// gh flags that CONSUME the next token as their value (so it is NOT the endpoint).
const GH_VALUE_FLAGS = new Set([
  "-X", "--method", "-f", "-F", "--field", "--raw-field", "--input", "-H", "--header",
  "-q", "--jq", "-t", "--template", "--hostname", "-p", "--preview", "--cache",
]);
// gh SHORT flags that take a value (used by canon to split attached forms like -XDELETE).
const SHORT_VALUE = new Set(["-X", "-f", "-F", "-H", "-q", "-t", "-p"]);
// gh SHORT flags the auditor legitimately passes bare (no value). Anything else that is a
// single-dash multi-char token after canon is a cluster/typo we refuse to reason about.
const GH_BARE_SHORT = new Set(["-i"]);
// First path segment allowlist. "user/orgs" ⊂ "user"; "orgs/<org>/repos" ⊂ "orgs" (§5.A).
const GH_API_FIRST_SEGMENT = new Set(["repos", "orgs", "user", "rate_limit", "graphql"]);
// GitHub canonicalizes the Link rel="next" for `orgs/<login>/repos` to the NUMERIC
// `organizations/<id>/repos` form, which pagination recomposes into a relative endpoint
// (§5.A). ONLY that exact whole-path shape is allowed — every other organizations/*
// resource stays denied. (\d in JS regex is exactly [0-9]; no unicode digits.)
const GH_ORG_ID_REPOS = /^organizations\/\d+\/repos$/;

// Normalize BOTH `--flag=value` and attached short forms (`-XDELETE`, `-X=DELETE`,
// `-fbody=x`) into separate tokens so no attached-value form dodges a `--flag value`
// check. Bare short flags like `-i` are left intact (the regex requires a value).
function canon(args: string[]): string[] {
  return args.flatMap((a) => {
    if (a.startsWith("--") && a.includes("=")) {
      const eq = a.indexOf("=");
      return [a.slice(0, eq), a.slice(eq + 1)];
    }
    const m = /^(-[A-Za-z])=?(.+)$/.exec(a); // -Xvalue / -X=value (NOT bare -i)
    if (m && SHORT_VALUE.has(m[1]!)) return [m[1]!, m[2]!];
    return [a];
  });
}

// Reject a single-dash token that is neither a recognized value/bare short flag nor a
// long flag — e.g. a short CLUSTER `-iXDELETE` that gh would split into `-i -X DELETE`
// but the guard would otherwise treat as one opaque flag.
function rejectUnknownGhShort(token: string): void {
  if (!token.startsWith("-") || token.startsWith("--")) return;
  if (token === "-") return;
  if (SHORT_VALUE.has(token) || GH_BARE_SHORT.has(token)) return;
  deny(`gh unrecognized/cluster short flag ${token}`);
}

export function assertReadOnlyGh(rawArgs: string[]): void {
  const args = canon(rawArgs);
  if (args.length === 0) deny("gh with no subcommand");
  const sub = args[0]!;
  const rest = args.slice(1);

  if (sub === "api") {
    for (const a of rest) rejectUnknownGhShort(a);

    // endpoint = first positional token, skipping flags AND the values they consume.
    let endpoint = "";
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i]!;
      if (a.startsWith("-")) {
        if (GH_VALUE_FLAGS.has(a)) i++; // this flag consumes the next token
        continue;
      }
      endpoint = a;
      break;
    }
    if (endpoint === "") deny("gh api with no endpoint");
    assertGhEndpointAllowed(endpoint);

    const pathOnly = endpoint.split("?")[0]!;
    const isGraphql = pathOnly === "graphql";

    // check EVERY -X/--method (gh honors the LAST one, so a later DELETE must not pass).
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i]!;
      if (a === "-X" || a === "--method") {
        const v = (rest[i + 1] ?? "").toUpperCase();
        if (v !== "GET") deny(`gh api method ${rest[i + 1] ?? "(missing)"}`);
      }
    }
    // body flags force POST/PATCH on REST endpoints; on graphql they carry the query.
    for (const a of rest) {
      if (BODY_FLAGS.has(a) && !isGraphql) deny(`gh api body flag ${a}`);
      // --cache writes gh's response cache to disk OUTSIDE the §0 contained write roots; the
      // tool caches in SQLite (api_cache) instead and never passes --cache (§3).
      if (a === "--cache") deny("gh api --cache (writes a local cache outside contained roots)");
      // --hostname on `gh api` OVERRIDES the GH_HOST pin (§6), redirecting a token-bearing
      // request to an arbitrary host. The tool relies on GH_HOST env exclusively — deny it.
      if (a === "--hostname") deny("gh api --hostname (overrides the GH_HOST pin)");
    }
    if (isGraphql) assertGraphqlQueryIsReadOnly(rest);
    return;
  }

  // Non-api gh: a tiny allowlist of read-only subcommands. NOT `auth refresh` (mutates
  // local auth state — human-only remediation, deliberately absent).
  const tuple = `${sub} ${rest[0] ?? ""}`.trim();
  const OK_TUPLES = new Set(["repo list", "auth status"]);
  const OK_BARE = new Set(["--version"]);
  if (!OK_TUPLES.has(tuple) && !OK_BARE.has(sub)) deny(`gh ${args.join(" ")}`);

  // `auth status` accepts token-DISCLOSURE flags (`--show-token`/`-t`) on modern gh (§2 says
  // never print tokens), so its trailing args must be EXACTLY nothing or `--hostname <host>`
  // with a concrete host value. Any other shape — `--show-token`/`-t`, a bare `--hostname`
  // with no value, or `--hostname --show-token` (flag-as-value) — is refused.
  if (tuple === "auth status") {
    // Validate the RAW (pre-canon) trailing args: the tool only ever emits the separate
    // `--hostname <host>` form, so the attached `--hostname=<host>` form is rejected too —
    // keeping the grammar exact and consistent with the `gh api --hostname` denial above.
    const extra = rawArgs.slice(2);
    if (extra.length === 0) return;
    const host = extra[1] ?? "";
    if (extra.length !== 2 || extra[0] !== "--hostname" || host === "" || host.startsWith("-"))
      deny(`gh auth status trailing args ${extra.join(" ")}`);
  }
}

// Validate a gh api endpoint path: reject percent-encoded separators and `.`/`..`
// traversal that could smuggle a non-allowlisted resource past a naive prefix check,
// then require the FIRST path segment to exactly match the allowlist.
function assertGhEndpointAllowed(endpoint: string): void {
  const pathOnly = endpoint.split("?")[0]!;
  if (/%2f|%2e|%5c|%00/i.test(pathOnly)) deny(`gh api encoded path separator in ${endpoint}`);
  if (pathOnly.includes("\\")) deny(`gh api backslash in ${endpoint}`);
  const segments = pathOnly.split("/");
  for (const seg of segments) {
    if (seg === "." || seg === "..") deny(`gh api path traversal in ${endpoint}`);
  }
  const first = segments[0] ?? "";
  if (first === "organizations") {
    // whole-path match (not first-segment): the numeric pagination shape and nothing else.
    if (!GH_ORG_ID_REPOS.test(pathOnly)) deny(`gh api endpoint ${endpoint}`);
    return;
  }
  if (!GH_API_FIRST_SEGMENT.has(first)) deny(`gh api endpoint ${endpoint}`);
}

// Reject GraphQL mutations/subscriptions. Require exactly ONE inline `query=…` body-field
// value (reject `--input`/`@file` bodies the guard cannot statically inspect), strip
// leading BOM / comments / string literals, and reject any top-level `mutation` /
// `subscription` operation (at document start OR after a prior definition's closing brace).
export function assertGraphqlQueryIsReadOnly(rest: string[]): void {
  if (rest.includes("--input")) deny("gh api graphql --input (uninspectable body)");
  // collect every `query=` body-field VALUE (must be the value of a body flag).
  const values: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (BODY_FLAGS.has(a)) {
      const v = rest[i + 1] ?? "";
      if (/^query=/.test(v)) values.push(v.slice("query=".length));
      i++;
    } else if (/^query=/.test(a)) {
      // an already-split `-f query=…` value (canon does not split long -f values)
      values.push(a.slice("query=".length));
    }
  }
  if (values.length === 0) deny("gh api graphql query not inline/inspectable");
  if (values.length > 1) deny("gh api graphql multiple query bodies");
  const raw = values[0]!;
  if (raw === "" || raw.startsWith("@")) deny("gh api graphql query not inline/inspectable");
  // Strip BOM, line/block comments, and string literals (so a string containing the word
  // "mutation" cannot false-positive), then reject ANY `mutation`/`subscription` keyword.
  // GraphQL treats commas as ignored whitespace, so a positional check like `\}\s*mutation`
  // is defeated by `query{a},mutation{b}`. Our read queries never contain these words, so a
  // keyword ANYWHERE is a non-read operation — the fail-safe rejection has no false negative.
  const stripped = raw
    .replace(/^﻿/, "")
    .replace(/"""[\s\S]*?"""/g, '""')
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/#[^\n]*/g, "");
  if (/\b(mutation|subscription)\b/i.test(stripped))
    deny("gh api graphql non-read operation");
}

// ---- git ----------------------------------------------------------------------------
// The tool ONLY ever spawns `git clone` (§5.C fallback), `git rev-parse HEAD`, and ONE fixed
// `git show` form (the clone-HEAD committer date, §4). The verb allowlist is exactly those (plus
// --version). Because git accepts unambiguous long-option ABBREVIATIONS (`--templ` = `--template`,
// `--dep` = `--depth`), a denylist is unsafe — so clone uses a strict EXACT-OPTION ALLOWLIST of only
// the hardening flags the wrapper emits, rev-parse forbids every flag, and `show` is pinned to ONE
// exact raw-argv tuple (below). Other read verbs (cat-file, log) stay excluded entirely — they
// accept --output/--textconv/--filters, which would breach read-only.
const GIT_READ = new Set(["clone", "rev-parse", "show", "--version"]);
// The tool runs EXACTLY ONE `show` form: read a cloned HEAD's committer date (the
// clone-fallback scan). There is NO general show/log parser — that would reopen --output/textconv/
// --ext-diff/alternate-format/revision surface. Instead an EXACT raw-argv allowlist: --no-patch
// suppresses diff machinery, --no-show-signature avoids invoking GPG, --no-notes avoids notes
// lookups, %cI is the strict-ISO committer date. Anything else (reordered, extra args, -C, a
// different format, a revision other than HEAD) is rejected.
const GIT_SHOW_DATE_ARGV = ["show", "--no-patch", "--no-notes", "--no-show-signature", "--format=%cI", "HEAD"];
// clone options, split by arity: VALUE flags consume the following token as their value
// (git does too, even if that token looks like a flag), BOOL flags stand alone.
const GIT_CLONE_VALUE = new Set(["--depth", "--branch", "--template"]);
const GIT_CLONE_BOOL = new Set(["--single-branch", "--no-tags", "--no-recurse-submodules"]);

export function assertReadOnlyGit(rawArgs: string[]): void {
  const args = canon(rawArgs);
  if (args.length === 0) deny("git with no subcommand");
  const verb = args[0]!;
  if (!GIT_READ.has(verb)) deny(`git ${verb}`); // a pre-verb global (`git -c x clone`) also lands here

  // config-injection short options on ANY verb, incl. attached `-cfoo=baz` / `-ufoo`.
  // (Runs BEFORE the --version return so `git --version -c core.x=y` cannot dodge it.)
  for (const a of args) if (/^-c/.test(a) || /^-u/.test(a)) deny(`git option ${a}`);

  if (verb === "--version") {
    if (args.length !== 1) deny("git --version must be the sole argument");
    return;
  }

  if (verb === "rev-parse") {
    // the tool only runs `git rev-parse HEAD`; NO option is needed, so reject every flag
    // (incl. --git-dir/--work-tree and any abbreviation) — only bare positionals allowed.
    for (const a of args.slice(1)) if (a.startsWith("-")) deny(`git rev-parse option ${a}`);
    return;
  }

  if (verb === "show") {
    // Compare the RAW argv (NOT canon'd — canon splits `--format=%cI` into two tokens): the ONLY
    // permitted show is the exact commit-date tuple. No option parser, no abbreviations, no reorder.
    const ok =
      rawArgs.length === GIT_SHOW_DATE_ARGV.length &&
      rawArgs.every((a, i) => a === GIT_SHOW_DATE_ARGV[i]);
    if (!ok) deny("git show is restricted to the exact commit-date form");
    return;
  }

  // verb === "clone": parse the RAW argv (not canon'd) as an exact GRAMMAR. Parsing raw
  // preserves the `--flag=value` vs `--flag value` distinction, so a BOOL flag given a value
  // (`--single-branch=x`) is rejected — canon would have hidden it. A VALUE flag consumes the
  // NEXT token as its value (git does the same, even when that token looks like a flag — so
  // `--branch --template=` makes git use `--template=` as the branch value, NOT as the
  // template flag; modeling arity is what closes that override). Any option not in the
  // allowlist (an abbreviation --templ/--dep, an alias --recursive, or a dangerous flag
  // --separate-git-dir/--reference/--output/--mirror/--bare, or ANY short flag) is rejected.
  const raw = rawArgs.slice(1);
  const seen: Record<string, number> = {};
  const values: Record<string, string> = {};
  const positionals: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i]!;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const name = eq === -1 ? a : a.slice(0, eq);
      const attached = eq === -1 ? undefined : a.slice(eq + 1);
      if (GIT_CLONE_VALUE.has(name)) {
        seen[name] = (seen[name] ?? 0) + 1;
        if (attached !== undefined) values[name] = attached;
        else { values[name] = raw[i + 1] ?? ""; i++; }
      } else if (GIT_CLONE_BOOL.has(name)) {
        if (attached !== undefined) deny(`git clone ${name} takes no value`);
        seen[name] = (seen[name] ?? 0) + 1;
      } else {
        deny(`git clone option ${a}`);
      }
    } else if (a.startsWith("-") && a.length > 1) {
      deny(`git clone option ${a}`); // no short flags in the hardened clone
    } else {
      positionals.push(a); // url or dest
    }
  }
  // §0's hardened shape: --depth 1, --single-branch, --branch <b>, --no-tags,
  // --no-recurse-submodules, --template= (empty). ALL required, each exactly once.
  for (const f of [...GIT_CLONE_VALUE, ...GIT_CLONE_BOOL]) {
    if ((seen[f] ?? 0) === 0) deny(`git clone missing hardening ${f}`);
    if ((seen[f] ?? 0) > 1) deny(`git clone duplicate ${f}`);
  }
  if ((values["--depth"] ?? "") !== "1") deny("git clone --depth must be 1 (shallow)");
  const branch = values["--branch"] ?? "";
  if (branch === "" || branch.startsWith("-")) deny("git clone --branch must have a concrete value");
  if ((values["--template"] ?? "x") !== "") deny("git clone --template must be empty");
  if (positionals.length !== 2) deny(`git clone expects <url> <dest>, got ${positionals.length} positionals`);
}

// ---- tar ----------------------------------------------------------------------------
// tar is only ever LIST (-t/--list) or EXTRACT (-x/--extract) into a contained pkg-audit-*
// dir, AFTER the §5.E entry/link/size validation. Because GNU tar accepts unambiguous
// long-option ABBREVIATIONS (`--use-compress-progra=sh`, even `--use=sh`), a denylist is
// unsafe — so this is a strict ALLOWLIST: only the exact read/compress/file/dir flags the
// tool emits are permitted; every other long option or short letter is rejected.
const TAR_SAFE_LONG = new Set([
  "--list", "--extract", "--gzip", "--bzip2", "--xz", "--zstd", "--file",
  "--directory", "--verbose", "--no-same-owner", "--no-same-permissions",
]);
// read modes (t,x) + decompress (z,j,J) + file (f) + verbose (v). Deliberately EXCLUDES
// write letters (c,r,u,A), exec letters (I,F), path-escape (P), incremental (g).
const TAR_SAFE_SHORT = new Set(["t", "x", "z", "j", "J", "f", "v"]);

export function assertReadOnlyTar(rawArgs: string[]): void {
  if (rawArgs.length === 0) deny("tar with no arguments");
  // --version / --help are allowed ONLY as the sole argument (preflight flavor detection).
  if (rawArgs.includes("--version") || rawArgs.includes("--help")) {
    if (rawArgs.length === 1) return;
    deny("tar --version/--help must be the sole argument");
  }
  let sawReadMode = false;
  for (const a of rawArgs) {
    if (a.startsWith("--")) {
      const name = a.split("=")[0]!;
      if (!TAR_SAFE_LONG.has(name)) deny(`tar option ${a}`);
      if (name === "--list" || name === "--extract") sawReadMode = true;
    } else if (a.startsWith("-") && a.length > 1) {
      for (const ch of a.slice(1)) {
        if (ch === "C") continue; // -C = changedir; its value is a separate positional token
        if (!TAR_SAFE_SHORT.has(ch)) deny(`tar option -${ch} in ${a}`);
        if (ch === "t" || ch === "x") sawReadMode = true;
      }
    }
    // else: a positional (archive path, extract dir, or a flag's value) — allowed. Every
    // dash-prefixed token is checked above, so no dangerous flag can hide as a "value".
  }
  if (!sawReadMode) deny("tar mode (not a read-only list/extract)");
}

// ---- spawn --------------------------------------------------------------------------
// Normalize a binary name to its lowercase basename without a Windows extension so
// `/usr/bin/npm`, `npm.cmd`, `NPM` all resolve to `npm`.
function normBin(bin: string): string {
  const base = bin.split(/[\\/]/).pop() ?? bin;
  return base.replace(/\.(cmd|exe|bat|ps1)$/i, "").toLowerCase();
}

export function assertSpawnAllowed(bin: string, argv: string[] = []): void {
  const name = normBin(bin);
  if (PM_DENYLIST.has(name)) deny(`banned package manager ${name}`);
  if (name === "bun") {
    // §0: bun may run ONLY this tool's own scripts. NO bun runtime flag is permitted —
    // `--eval`/`-e`/`--preload`/`--cwd` all run attacker-chosen code BEFORE or INSTEAD of
    // the script, so a positional filter is unsafe. The argv must be EXACTLY
    // `[run] scripts/<name>.ts [scriptArgs…]` — the token in the run/script slot must be
    // literally `run` or an own-script; any flag there is rejected.
    const start = argv[0] === "run" ? 1 : 0;
    const script = argv[start];
    if (script === undefined || !OWN_SCRIPT.test(script)) deny(`bun ${argv.join(" ") || "(no script)"}`);
    return;
  }
}

// ---- write containment (§0 path allocator) ------------------------------------------
// The argv guards above prove a command is READ-ONLY in intent; but a clone dest, a tar -C
// extraction dir, the SQLite file, and every report/output write are still WRITES. §0
// requires every write TARGET to resolve inside an allowed root (./data, ./output, or a
// run-scoped pkg-audit-* temp dir). This is a SEPARATE mechanism from the pure argv guards
// (it needs the filesystem: realpath defeats symlink escape), so the github.ts wrapper calls
// `assertContained(dest, roots)` before spawning `git clone`/`tar -x`, and db.ts/report.ts
// call it on their paths. Kept here because it is the other half of §0 read-only safety.

// Resolve `p` to the absolute path a WRITE to it would actually land on, walking components
// LEFT-TO-RIGHT in FILESYSTEM order — following every symlink and applying `..` AFTER any
// preceding symlink is resolved. It must NOT lexically pre-normalize (`path.resolve`/`join`
// collapse `<root>/link/../x` to `<root>/x` BEFORE `link` is followed, which is exactly the
// symlink+`..` escape). It handles: a not-yet-created tail (pushed verbatim), a DANGLING
// symlink component (readlink resolves it even when its target does not exist yet, so a link
// pointing OUTSIDE is followed), and symlink chains/loops (capped by `depth`, fails closed).
function resolveWritePath(p: string, depth = 0): string {
  if (depth > 64) deny(`symlink chain too deep resolving ${p} (possible loop)`);
  const abs = isAbsolute(p) ? p : process.cwd() + sep + p;
  const stack: string[] = []; // resolved, existing-or-lexical path components (no symlinks)
  for (const part of abs.split(sep)) {
    if (part === "" || part === ".") continue;
    if (part === "..") { stack.pop(); continue; } // move up from the CURRENT resolved location
    const next = sep + stack.concat(part).join(sep);
    let st;
    try {
      st = lstatSync(next); // lstat sees the symlink itself, even a dangling one
    } catch {
      stack.push(part); // `next` does not exist — treat the rest lexically from here
      continue;
    }
    if (st.isSymbolicLink()) {
      const link = readlinkSync(next);
      const linkPath = isAbsolute(link) ? link : sep + stack.join(sep) + sep + link;
      const resolved = resolveWritePath(linkPath, depth + 1);
      stack.length = 0;
      for (const c of resolved.split(sep)) if (c) stack.push(c);
    } else {
      stack.push(part);
    }
  }
  return sep + stack.join(sep);
}

// Assert `target` resolves inside one of `allowedRoots`; returns the resolved absolute path.
// Throws a ReadOnlyViolation otherwise. Every symlink (parent OR dangling tail) is resolved,
// so no link can redirect a write outside the roots (§0).
export function assertContained(target: string, allowedRoots: string[]): string {
  if (allowedRoots.length === 0) deny("write containment called with no allowed roots");
  const resolved = resolveWritePath(target);
  for (const root of allowedRoots) {
    const rr = resolveWritePath(root);
    if (resolved === rr || resolved.startsWith(rr + sep)) return resolved;
  }
  throw new ReadOnlyViolation(
    `READ-ONLY VIOLATION: write target ${target} escapes the contained roots [${allowedRoots.join(", ")}]`,
  );
}
